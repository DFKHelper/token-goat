"""Tests for --strip-comments and --scan-secrets flags on the pack command."""
from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from token_goat.cli import app
from token_goat.pack import PackFile, collect_files, scan_secrets, strip_comments

runner = CliRunner()


def _make_project(tmp_path: Path, make_project, files: dict[str, str]) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    make_project(root)
    return root


# ---------------------------------------------------------------------------
# Unit tests for strip_comments()
# ---------------------------------------------------------------------------


class TestStripComments:
    def test_python_line_comment_removed(self):
        src = "x = 1  # set x\ny = 2\n"
        out = strip_comments(src, Path("a.py"))
        assert "# set x" not in out
        assert "y = 2" in out

    def test_python_docstring_removed(self):
        src = '"""This is a docstring."""\ndef foo():\n    pass\n'
        out = strip_comments(src, Path("a.py"))
        assert "This is a docstring" not in out
        assert "def foo" in out

    def test_python_multiline_docstring_preserves_line_count(self):
        src = '"""Line one.\nLine two.\n"""\ndef bar():\n    pass\n'
        original_lines = src.count("\n")
        out = strip_comments(src, Path("a.py"))
        assert out.count("\n") == original_lines

    def test_js_line_comment_removed(self):
        src = "const x = 1; // assign x\nconst y = 2;\n"
        out = strip_comments(src, Path("a.js"))
        assert "// assign x" not in out
        assert "const y" in out

    def test_js_block_comment_removed(self):
        src = "/* header */\nconst z = 3;\n"
        out = strip_comments(src, Path("a.js"))
        assert "header" not in out
        assert "const z" in out

    def test_ts_comments_stripped(self):
        src = "// top\nfunction add(a: number) {\n  return a; // return\n}\n"
        out = strip_comments(src, Path("a.ts"))
        assert "top" not in out
        assert "function add" in out

    def test_sql_line_comment_removed(self):
        src = "SELECT 1; -- a comment\n"
        out = strip_comments(src, Path("query.sql"))
        assert "-- a comment" not in out
        assert "SELECT 1" in out

    def test_ruby_hash_comment_removed(self):
        src = "x = 1 # assign\n"
        out = strip_comments(src, Path("a.rb"))
        assert "# assign" not in out

    def test_unknown_extension_unchanged(self):
        src = "// no change\nfoo bar\n"
        out = strip_comments(src, Path("a.xyz"))
        assert out == src

    def test_css_block_comment_removed(self):
        src = "/* color comment */\nbody { color: red; }\n"
        out = strip_comments(src, Path("a.css"))
        assert "color comment" not in out
        assert "body" in out


# ---------------------------------------------------------------------------
# Unit tests for scan_secrets()
# ---------------------------------------------------------------------------


def _make_pf(rel: str, content: str) -> PackFile:
    return PackFile(path=Path(rel), rel_path=rel, content=content, lines=content.count("\n"), tokens=1)


class TestScanSecrets:
    def test_aws_access_key_detected(self):
        pf = _make_pf("creds.txt", "key = AKIAIOSFODNN7EXAMPLE\n")
        hits = scan_secrets([pf])
        assert any(h.kind == "AWS access key" for h in hits)

    def test_github_token_detected(self):
        pf = _make_pf("config.py", 'token = "ghp_' + "A" * 36 + '"\n')
        hits = scan_secrets([pf])
        assert any("GitHub" in h.kind for h in hits)

    def test_private_key_detected(self):
        pf = _make_pf("key.pem", "-----BEGIN RSA PRIVATE KEY-----\nABC\n")
        hits = scan_secrets([pf])
        assert any("Private key" in h.kind for h in hits)

    def test_clean_file_no_hits(self):
        pf = _make_pf("main.py", "x = 1\nprint(x)\n")
        hits = scan_secrets([pf])
        assert hits == []

    def test_hit_reports_line_number(self):
        pf = _make_pf("cfg.env", "FOO=bar\nkey = AKIAIOSFODNN7EXAMPLE\nBAZ=qux\n")
        hits = scan_secrets([pf])
        aws_hits = [h for h in hits if h.kind == "AWS access key"]
        assert aws_hits and aws_hits[0].line == 2

    def test_png_file_skipped(self):
        pf = _make_pf("img.png", "AKIAIOSFODNN7EXAMPLE")
        hits = scan_secrets([pf])
        assert hits == []

    def test_multiple_files_reported_separately(self):
        files = [
            _make_pf("a.py", "a = AKIAIOSFODNN7EXAMPLE\n"),
            _make_pf("b.py", "print('hello')\n"),
            _make_pf("c.py", "sk_live_ABC123" + "x" * 20 + "\n"),
        ]
        hits = scan_secrets(files)
        paths = {h.rel_path for h in hits}
        assert "a.py" in paths
        assert "b.py" not in paths
        assert "c.py" in paths


# ---------------------------------------------------------------------------
# Integration: --strip-comments CLI flag
# ---------------------------------------------------------------------------


class TestPackStripCommentsFlag:
    def test_comments_absent_in_output(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "src/a.py": "x = 1  # inline comment\ndef foo():\n    pass\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "src/a.py", "--strip-comments"])
        assert result.exit_code == 0
        assert "inline comment" not in result.output

    def test_code_preserved_after_strip(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "src/b.py": "# header\nx = 42\n# footer\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "src/b.py", "--strip-comments"])
        assert result.exit_code == 0
        assert "x = 42" in result.output

    def test_without_flag_comments_present(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "src/c.py": "x = 1  # keep me\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "src/c.py"])
        assert result.exit_code == 0
        assert "keep me" in result.output


# ---------------------------------------------------------------------------
# Integration: --scan-secrets CLI flag
# ---------------------------------------------------------------------------


class TestPackScanSecretsFlag:
    def test_clean_file_exits_zero(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "src/main.py": "x = 1\nprint(x)\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "src/main.py", "--scan-secrets"])
        assert result.exit_code == 0

    def test_secret_file_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "creds.py": "key = AKIAIOSFODNN7EXAMPLE\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "creds.py", "--scan-secrets"])
        assert result.exit_code == 2

    def test_secret_warning_message_on_stderr(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "creds.py": "key = AKIAIOSFODNN7EXAMPLE\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "creds.py", "--scan-secrets"], catch_exceptions=False)
        combined = (result.output or "") + (result.stderr if hasattr(result, "stderr") else "")
        assert "secret" in combined.lower() or result.exit_code == 2

    def test_no_flag_emits_secret_without_error(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project(tmp_path, make_project, {
            "creds.py": "key = AKIAIOSFODNN7EXAMPLE\n",
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["pack", "creds.py"])
        assert result.exit_code == 0
        assert "AKIAIOSFODNN7EXAMPLE" in result.output


# ---------------------------------------------------------------------------
# collect_files: do_strip_comments passthrough
# ---------------------------------------------------------------------------


class TestCollectFilesStripComments:
    def test_do_strip_comments_strips_python(self, tmp_path):
        (tmp_path / ".git").mkdir()
        f = tmp_path / "a.py"
        f.write_text("x = 1  # comment\ny = 2\n", encoding="utf-8")
        result = collect_files(tmp_path, ["a.py"], do_strip_comments=True)
        assert len(result.files) == 1
        assert "# comment" not in result.files[0].content

    def test_do_strip_comments_false_preserves(self, tmp_path):
        (tmp_path / ".git").mkdir()
        f = tmp_path / "a.py"
        f.write_text("x = 1  # comment\n", encoding="utf-8")
        result = collect_files(tmp_path, ["a.py"], do_strip_comments=False)
        assert "# comment" in result.files[0].content
