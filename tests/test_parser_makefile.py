"""Tests for the Makefile language extractor and basename dispatch."""
from __future__ import annotations

import pytest

from token_goat.languages import makefile_idx

# ---------------------------------------------------------------------------
# Core extractor tests
# ---------------------------------------------------------------------------

class TestMakefileExtractor:
    def test_simple_targets(self):
        src = b"""all: main.o
\tgcc -o app main.o

main.o: main.c
\tgcc -c main.c

clean:
\trm -f *.o app
"""
        symbols, refs, imps, sections = makefile_idx.extract(src, "Makefile")
        assert refs == [] and imps == []
        names = [s.name for s in symbols]
        assert "all" in names
        assert "main.o" in names
        assert "clean" in names

    def test_sections_assigned(self):
        src = b"build:\n\tmake all\n\ntest:\n\tpytest\n"
        _, _, _, sections = makefile_idx.extract(src, "Makefile")
        headings = [s.heading for s in sections]
        assert "build" in headings
        assert "test" in headings

    def test_end_lines_assigned(self):
        src = b"build:\n\tgcc main.c\n\ntest:\n\tpytest\n"
        _, _, _, sections = makefile_idx.extract(src, "Makefile")
        build_sec = next(s for s in sections if s.heading == "build")
        test_sec = next(s for s in sections if s.heading == "test")
        assert build_sec.end_line is not None
        assert test_sec.end_line is not None
        # build section ends before test section starts
        assert build_sec.end_line < test_sec.line

    def test_define_block(self):
        src = b"""define CC_FLAGS
-Wall -Wextra -O2
endef

all:
\techo done
"""
        symbols, _, _, sections = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "CC_FLAGS" in names
        kinds = {s.name: s.kind for s in symbols}
        assert kinds["CC_FLAGS"] == "makefile_define"

    def test_phony_excluded(self):
        src = b".PHONY: all clean\nall:\n\techo hi\nclean:\n\trm -f *.o\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert ".PHONY" not in names
        assert "all" in names
        assert "clean" in names

    def test_double_colon_rule(self):
        """Double-colon rules (``target::``) are valid Makefile syntax."""
        src = b"install:: check\n\tcp app /usr/local/bin\n"
        symbols, _, _, sections = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "install" in names

    def test_comments_stripped(self):
        """Commented-out targets must not appear in the index."""
        src = b"# disabled_target:\n#\tdo_something\nreal_target:\n\tdo_other\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "disabled_target" not in names
        assert "real_target" in names

    def test_variable_assignment_not_indexed(self):
        """Simple variable assignments (``CC = gcc``) must NOT be indexed."""
        src = b"CC = gcc\nLD = ld\nall:\n\t$(CC) main.c\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "CC" not in names
        assert "LD" not in names
        assert "all" in names

    def test_empty_file(self):
        symbols, refs, imps, sections = makefile_idx.extract(b"", "Makefile")
        assert symbols == []
        assert refs == []
        assert imps == []
        assert sections == []

    def test_utf8_bom_on_first_target(self):
        """A UTF-8 BOM prefix must not hide the first target."""
        src = "﻿all: build\n\tbuild\n".encode()
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "all" in names

    def test_binary_garbage_does_not_raise(self):
        """Non-UTF-8 bytes must be handled gracefully (fail-soft)."""
        src = b"\xff\xfe target: all\n"
        # Should not raise; result shape may be empty or partial
        result = makefile_idx.extract(src, "Makefile")
        assert len(result) == 4

    def test_indented_line_not_target(self):
        """Recipe lines (tab-indented) that look like targets must be ignored."""
        src = b"all:\n\tclean:\n\t\trm -f *.o\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "all" in names
        # The indented ``clean:`` is a recipe line, not a target declaration.
        assert "clean" not in names

    def test_pattern_rule_included(self):
        """Pattern rules like ``%.o: %.c`` are valid targets and should be indexed."""
        src = b"%.o: %.c\n\t$(CC) -c $<\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "%.o" in names

    def test_target_with_prerequisites(self):
        """Prerequisites on the same line as the target should not affect the symbol name."""
        src = b"app: main.o utils.o\n\tgcc -o app main.o utils.o\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "app" in names
        # prerequisites must not appear as separate symbols
        assert "main.o" not in names or symbols[0].name == "app"

    def test_symbol_kind_is_makefile_target(self):
        src = b"build:\n\tgo build ./...\n"
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        assert any(s.kind == "makefile_target" for s in symbols)

    def test_multiple_defines(self):
        src = b"""define CFLAGS
-Wall
endef

define LDFLAGS
-lpthread
endef
"""
        symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
        names = [s.name for s in symbols]
        assert "CFLAGS" in names
        assert "LDFLAGS" in names

    def test_special_targets_excluded(self):
        """All GNU make special targets must be suppressed."""
        specials = [
            b".DEFAULT:\n",
            b".SUFFIXES:\n",
            b".SILENT:\n",
            b".PRECIOUS: foo.o\n",
            b".IGNORE:\n",
            b".NOTPARALLEL:\n",
            b".ONESHELL:\n",
            b".INTERMEDIATE: foo\n",
            b".SECONDARY: bar\n",
            b".DELETE_ON_ERROR:\n",
            b".POSIX:\n",
        ]
        for src in specials:
            symbols, _, _, _ = makefile_idx.extract(src, "Makefile")
            assert symbols == [], f"Special target not excluded for: {src!r}"


# ---------------------------------------------------------------------------
# Basename dispatch tests
# ---------------------------------------------------------------------------

class TestMakefileBasenameDispatch:
    """Verify that Makefile, GNUmakefile, and makefile (lowercase) resolve
    through the basename lookup table."""

    def test_Makefile_dispatch(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        mk = root / "Makefile"
        mk.write_text("all:\n\tgcc main.c\nclean:\n\trm -f *.o\n", encoding="utf-8")
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, mk)
        assert result is not None
        assert result.language == "makefile"
        headings = [s.heading for s in result.sections]
        assert "all" in headings
        assert "clean" in headings

    def test_GNUmakefile_dispatch(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        mk = root / "GNUmakefile"
        mk.write_text("build:\n\tgo build ./...\n", encoding="utf-8")
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, mk)
        assert result is not None
        assert result.language == "makefile"

    def test_mk_extension_dispatch(self, tmp_data_dir, tmp_path):
        """.mk files (common fragment extension) resolve via LANG_BY_EXT."""
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        mk = root / "rules.mk"
        mk.write_text("compile:\n\tcc src.c\n", encoding="utf-8")
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, mk)
        assert result is not None
        assert result.language == "makefile"


# ---------------------------------------------------------------------------
# Extension mapping tests (no DB / filesystem required)
# ---------------------------------------------------------------------------

class TestParserExtensionMappings:
    """Verify extension and basename entries in the parser's lookup tables."""

    @pytest.mark.parametrize("ext,expected_lang", [
        (".mts", "typescript"),
        (".cts", "typescript"),
        (".mk", "makefile"),
        (".css", "css"),
        (".scss", "css"),
        (".less", "css"),
        (".sql", "sql"),
        (".graphql", "graphql"),
        (".gql", "graphql"),
        (".proto", "proto"),
    ])
    def test_ext_mapped_to_language(self, ext, expected_lang):
        from token_goat.parser import LANG_BY_EXT
        assert LANG_BY_EXT[ext] == expected_lang

    @pytest.mark.parametrize("basename,expected_lang", [
        ("makefile", "makefile"),
        ("gnumakefile", "makefile"),
    ])
    def test_basename_mapped_to_language(self, basename, expected_lang):
        from token_goat.parser import LANG_BY_BASENAME
        assert LANG_BY_BASENAME[basename] == expected_lang
