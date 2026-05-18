"""Tests for the INI / CFG / .env language extractor."""
from __future__ import annotations

from token_goat.languages import ini_idx


class TestIniSections:
    def test_simple_sections(self):
        src = b"""
[install]
prefix = /usr/local

[uninstall]
yes = true
"""
        symbols, refs, imps, sections = ini_idx.extract(src, "setup.cfg")
        assert refs == [] and imps == []
        headings = [s.heading for s in sections]
        assert "install" in headings
        assert "uninstall" in headings
        # Section start lines are 1-based.
        install_sec = next(s for s in sections if s.heading == "install")
        assert install_sec.line == 2
        assert install_sec.end_line is not None and install_sec.end_line < sections[1].line

    def test_dotted_and_colon_names(self):
        src = b"[tool.black]\nline-length = 100\n\n[mysqld:replica]\nport = 3307\n"
        _, _, _, sections = ini_idx.extract(src, "x.ini")
        headings = [s.heading for s in sections]
        assert "tool.black" in headings
        assert "mysqld:replica" in headings

    def test_comment_after_header_tolerated(self):
        src = b"[main]  ; production block\nport = 80\n"
        _, _, _, sections = ini_idx.extract(src, "x.ini")
        assert [s.heading for s in sections] == ["main"]

    def test_malformed_header_skipped(self):
        src = b"[unclosed\nport = 80\n[ok]\nfoo = bar\n"
        _, _, _, sections = ini_idx.extract(src, "x.ini")
        assert [s.heading for s in sections] == ["ok"]

    def test_empty_file_yields_nothing(self):
        _, _, _, sections = ini_idx.extract(b"", "x.ini")
        assert sections == []


class TestEnvExtractor:
    def test_top_level_keys(self):
        src = b"DATABASE_URL=postgres://localhost/db\nDEBUG=1\nAPI_KEY: secret\n"
        symbols, refs, imps, sections = ini_idx.extract_env(src, ".env")
        assert refs == [] and imps == [] and sections == []
        names = [s.name for s in symbols]
        assert names == ["DATABASE_URL", "DEBUG", "API_KEY"]

    def test_comments_and_blank_lines_skipped(self):
        src = b"# leading comment\n\nFOO=1\n; second style\nBAR=2\n"
        symbols, _, _, _ = ini_idx.extract_env(src, ".env")
        assert [s.name for s in symbols] == ["FOO", "BAR"]

    def test_indented_lines_skipped(self):
        """Indented lines are continuation/heredoc bodies, never new keys."""
        src = b"VAR=hello\n  CONTINUATION\nNEXT=world\n"
        symbols, _, _, _ = ini_idx.extract_env(src, ".env")
        assert [s.name for s in symbols] == ["VAR", "NEXT"]

    def test_line_numbers_are_one_based(self):
        src = b"# header\nFOO=1\nBAR=2\n"
        symbols, _, _, _ = ini_idx.extract_env(src, ".env")
        foo = next(s for s in symbols if s.name == "FOO")
        bar = next(s for s in symbols if s.name == "BAR")
        assert foo.line == 2
        assert bar.line == 3


class TestBasenameDispatch:
    def test_env_dotfile_resolves_to_env_language(self, tmp_data_dir, tmp_path):
        """``.env`` has no Path.suffix; it must dispatch via basename lookup."""
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        env_path = tmp_path / ".env"
        env_path.write_text("DATABASE_URL=x\nDEBUG=1\n", encoding="utf-8")
        root = canonicalize(tmp_path)
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, env_path)
        assert result is not None
        assert result.language == "env"
        assert [s.name for s in result.symbols] == ["DATABASE_URL", "DEBUG"]

    def test_setup_cfg_resolves_to_ini_language(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        p = tmp_path / "setup.cfg"
        p.write_text("[metadata]\nname = pkg\n\n[options]\npackages = find\n", encoding="utf-8")
        root = canonicalize(tmp_path)
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, p)
        assert result is not None
        assert result.language == "ini"
        headings = {s.heading for s in result.sections}
        assert "metadata" in headings and "options" in headings
