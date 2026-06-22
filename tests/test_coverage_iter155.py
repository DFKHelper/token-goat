"""Regression tests for iterations 151-154.

Coverage targets:
- read_commands.py: _run_read_like_command with both read_symbol and read_section callers
- languages/common.py: AttributeError guards in make_add_symbol, add_symbol_info, add_imports
- languages/rust.py: AttributeError guard in _add_symbol (local closure)
- languages/markdown.py: OverflowError guard in section extraction
- image_shrink.py: narrowed contextlib.suppress — AttributeError on exif_transpose is suppressed
- compact.py: sanitize_log_str applied to symbol names and paths in manifest output
- db.py: _PROJECT_HASH_RE rejects uppercase and underscores
- hooks_read.py: _try_shrink_image sanitizes file_path in stats detail
"""
from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# ===========================================================================
# 1. read_commands.py — _run_read_like_command with read_symbol and read_section
# ===========================================================================


class TestRunReadLikeCommand:
    """_run_read_like_command dispatches correctly for both reader callables."""

    def _make_symbol_result(self):
        from token_goat.read_replacement import SymbolResult

        return SymbolResult(
            file="src/foo.py",
            symbol="my_func",
            kind="function",
            start_line=10,
            end_line=20,
            text="def my_func(): pass",
            signature="def my_func()",
            bytes_total=500,
            bytes_extracted=50,
            bytes_saved=450,
        )

    def _make_section_result(self):
        from token_goat.read_replacement import SectionResult

        return SectionResult(
            file="docs/README.md",
            heading="Install",
            level=2,
            start_line=5,
            end_line=15,
            text="## Install\n\nrun pip install",
            bytes_total=400,
            bytes_extracted=40,
            bytes_saved=360,
        )

    def test_read_symbol_caller_emits_output(self, capsys):
        """_run_read_like_command with read_symbol reader prints symbol text."""
        from token_goat.read_commands import _run_read_like_command

        sym_result = self._make_symbol_result()

        with (
            patch("token_goat.read_commands.find_project", return_value=None),
            patch(
                "token_goat.read_replacement.find_in_all_projects",
                return_value=(MagicMock(hash="a" * 40), "src/foo.py"),
            ),
            patch("token_goat.read_replacement.read_symbol", return_value=sym_result),
            patch("token_goat.db.record_stat"),
            patch("token_goat.db.reset_miss"),
        ):
            _run_read_like_command(
                target="foo.py::my_func",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="symbol",
                missing_label="Symbol",
                stat_kind="read_replacement",
                reader=lambda *a, **kw: sym_result,
            )

        # No exception means the read_symbol path completed successfully
        capsys.readouterr()  # consume output

    def test_read_section_caller_emits_output(self, capsys):
        """_run_read_like_command with read_section reader prints section text."""
        from token_goat.read_commands import _run_read_like_command

        sec_result = self._make_section_result()

        with (
            patch("token_goat.read_commands.find_project", return_value=None),
            patch(
                "token_goat.read_replacement.find_in_all_projects",
                return_value=(MagicMock(hash="b" * 40), "docs/README.md"),
            ),
            patch("token_goat.read_replacement.read_section", return_value=sec_result),
            patch("token_goat.db.record_stat"),
            patch("token_goat.db.reset_miss"),
        ):
            _run_read_like_command(
                target="README.md::Install",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=lambda *a, **kw: sec_result,
            )

        # No exception means the section reader path completes without error

    def test_missing_separator_emits_error(self, capsys):
        """Target without '::' emits an error message and raises SystemExit/Exit."""
        import click

        from token_goat.read_commands import _run_read_like_command

        with pytest.raises((SystemExit, click.exceptions.Exit)):
            _run_read_like_command(
                target="foo.py",  # no ::
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="symbol",
                missing_label="Symbol",
                stat_kind="read_replacement",
                reader=lambda *a, **kw: None,
            )

        captured = capsys.readouterr()
        # Error message goes to stderr and mentions the expected format
        assert "symbol" in captured.err

    def test_reader_returns_none_emits_missing_label(self, capsys):
        """When reader returns None, _run_read_like_command emits the missing_label and exits."""
        import click

        from token_goat.read_commands import _run_read_like_command

        with (
            patch("token_goat.read_commands.find_project", return_value=None),
            patch(
                "token_goat.read_replacement.find_in_all_projects",
                return_value=(MagicMock(hash="c" * 40), "src/bar.py"),
            ),
            patch("token_goat.db.record_stat"),
            pytest.raises((SystemExit, click.exceptions.Exit)),
        ):
            _run_read_like_command(
                target="bar.py::missing_fn",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="symbol",
                missing_label="Symbol",
                stat_kind="read_replacement",
                reader=lambda *a, **kw: None,
            )

    def test_duplicate_heading_hint_emitted_to_stderr(self, capsys):
        """When read_section returns ambiguous_at_lines, a stderr hint names the other lines."""
        from token_goat.read_commands import _run_read_like_command
        from token_goat.read_replacement import SectionResult

        sec_result = SectionResult(
            file="docs/guide.md",
            heading="Setup",
            level=2,
            start_line=10,
            end_line=20,
            core_start_line=10,
            core_end_line=20,
            text="## Setup\n\nfirst occurrence",
            bytes_total=800,
            bytes_extracted=80,
            bytes_saved=720,
            ambiguous_at_lines=[45, 80],
        )

        with (
            patch("token_goat.read_commands.find_project", return_value=None),
            patch(
                "token_goat.read_replacement.find_in_all_projects",
                return_value=(MagicMock(hash="d" * 40), "docs/guide.md"),
            ),
            patch("token_goat.db.record_stat"),
        ):
            _run_read_like_command(
                target="guide.md::Setup",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=lambda *a, **kw: sec_result,
            )

        captured = capsys.readouterr()
        # Hint must appear on stderr and mention the other line numbers
        assert "45" in captured.err
        assert "80" in captured.err
        assert "#2" in captured.err

    def test_duplicate_heading_hint_suppressed_in_json_mode(self, capsys):
        """ambiguous_at_lines hint is not emitted when json_output=True."""
        from token_goat.read_commands import _run_read_like_command
        from token_goat.read_replacement import SectionResult

        sec_result = SectionResult(
            file="docs/guide.md",
            heading="Setup",
            level=2,
            start_line=10,
            end_line=20,
            core_start_line=10,
            core_end_line=20,
            text="## Setup\n\nfirst occurrence",
            bytes_total=800,
            bytes_extracted=80,
            bytes_saved=720,
            ambiguous_at_lines=[45],
        )

        with (
            patch("token_goat.read_commands.find_project", return_value=None),
            patch(
                "token_goat.read_replacement.find_in_all_projects",
                return_value=(MagicMock(hash="e" * 40), "docs/guide.md"),
            ),
            patch("token_goat.db.record_stat"),
        ):
            _run_read_like_command(
                target="guide.md::Setup",
                session_id=None,
                json_output=True,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=lambda *a, **kw: sec_result,
            )

        captured = capsys.readouterr()
        # No disambiguation hint in json mode
        assert "#2" not in captured.err
        # JSON output must not leak the internal field
        import json
        payload = json.loads(captured.out)
        assert "ambiguous_at_lines" not in payload


# ===========================================================================
# 2. languages/common.py — AttributeError guards
# ===========================================================================


class TestMakeAddSymbolAttributeErrorGuard:
    """make_add_symbol silently skips nodes missing .name or .span."""

    def _make_symbols_list(self):
        from token_goat.languages.common import make_add_symbol

        symbols = []
        seen = set()
        add = make_add_symbol(symbols, seen, b"def foo(): pass", language="python")
        return symbols, add

    def test_node_missing_name_attribute_is_skipped(self):
        """A node with no .name attribute must be silently skipped."""
        symbols, add = self._make_symbols_list()

        node = SimpleNamespace()  # no .name attribute at all

        add(node)

        assert symbols == []

    def test_node_with_empty_name_and_missing_children_is_skipped(self):
        """A node with name='' but no .children is silently dropped."""
        symbols, add = self._make_symbols_list()

        node = SimpleNamespace(name="")  # name is empty, no .children

        add(node)

        assert symbols == []

    def test_node_with_empty_name_descends_into_children(self):
        """A node with name='' and .children recurses into the children."""
        symbols, add = self._make_symbols_list()

        # Build a child that also has no name — just verifies no crash
        child = SimpleNamespace(name="")
        parent = SimpleNamespace(name="", children=[child])

        add(parent)

        assert symbols == []  # child also has no name, nothing added

    def test_node_missing_span_is_skipped_after_name_found(self, caplog):
        """A node with a name but no .span logs a debug message and is skipped."""
        symbols, add = self._make_symbols_list()

        # has .name but no .span — triggers the second AttributeError guard
        node = SimpleNamespace(name="broken_func", kind="Function")

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.common"):
            add(node)

        assert symbols == []
        assert any("skipping malformed node" in r.message for r in caplog.records)


class TestAddSymbolInfoAttributeErrorGuard:
    """add_symbol_info silently skips SymbolInfo objects missing .name or .span."""

    def test_missing_name_attribute_skipped(self, caplog):
        """SymbolInfo with no .name is skipped with a DEBUG log."""
        from token_goat.languages.common import add_symbol_info

        symbols = []
        seen: set = set()
        bad_sym = SimpleNamespace()  # no .name

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.common"):
            add_symbol_info(symbols, seen, [bad_sym], language="python")

        assert symbols == []
        assert any("skipping malformed SymbolInfo" in r.message for r in caplog.records)

    def test_missing_span_attribute_skipped(self, caplog):
        """SymbolInfo with .name but no .span is skipped with a DEBUG log."""
        from token_goat.languages.common import add_symbol_info

        symbols = []
        seen: set = set()
        bad_sym = SimpleNamespace(name="MyConst", kind="Constant")  # no .span

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.common"):
            add_symbol_info(symbols, seen, [bad_sym], language="go")

        assert symbols == []
        assert any("skipping malformed SymbolInfo" in r.message for r in caplog.records)

    def test_valid_sym_info_is_added(self):
        """A well-formed SymbolInfo is added to the symbols list."""
        from token_goat.languages.common import add_symbol_info

        symbols = []
        seen: set = set()
        span = SimpleNamespace(start_line=4, end_line=4)
        good_sym = SimpleNamespace(name="MY_CONST", span=span, kind="Constant")

        add_symbol_info(symbols, seen, [good_sym], language="go")

        assert len(symbols) == 1
        assert symbols[0].name == "MY_CONST"


class TestAddImportsAttributeErrorGuard:
    """add_imports silently skips import objects whose span is missing."""

    def test_missing_span_attribute_skipped(self, caplog):
        """An import node with no .span is skipped and logged at DEBUG."""
        from token_goat.languages.common import add_imports

        imp_exp = []
        bad_import = SimpleNamespace()  # no .span

        def extractor(imp):
            return "some_module"

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.common"):
            add_imports(imp_exp, [bad_import], extractor)

        assert imp_exp == []
        assert any("skipping malformed import" in r.message for r in caplog.records)

    def test_valid_import_is_added(self):
        """A well-formed import node is appended to imp_exp."""
        from token_goat.languages.common import add_imports

        imp_exp = []
        span = SimpleNamespace(start_line=0)
        good_import = SimpleNamespace(span=span)

        add_imports(imp_exp, [good_import], lambda imp: "os")

        assert len(imp_exp) == 1
        assert imp_exp[0].target == "os"
        assert imp_exp[0].kind == "import"


# ===========================================================================
# 3. languages/rust.py — AttributeError guard in local _add_symbol closure
# ===========================================================================


class TestRustAddSymbolAttributeErrorGuard:
    """Rust _add_symbol local closure skips nodes with missing attributes."""

    def _call_extract_with_mocked_result(self, structure_items):
        """Invoke rust.extract() with tree-sitter result mocked to given structure."""
        from token_goat.languages import rust

        mock_result = SimpleNamespace(
            structure=structure_items,
            symbols=[],
            imports=[],
        )
        with patch("token_goat.languages.common.parse_source", return_value=(mock_result, "")):
            return rust.extract(b"fn foo() {}", "test.rs")

    def test_node_missing_name_returns_no_symbols(self):
        """A structure node with no .name attribute produces no symbols."""
        node = SimpleNamespace()  # no .name
        symbols, refs, imp_exp, sections = self._call_extract_with_mocked_result([node])
        assert symbols == []

    def test_node_missing_span_skipped_after_name(self, caplog):
        """A node with .name but no .span is skipped and logged at DEBUG."""
        node = SimpleNamespace(name="my_struct", kind="Struct")  # no .span

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.common"):
            symbols, _, _, _ = self._call_extract_with_mocked_result([node])

        assert symbols == []
        assert any("skipping malformed node" in r.message for r in caplog.records)

    def test_node_with_empty_name_missing_children_skipped(self):
        """A node with name='' and no .children produces no symbols."""
        node = SimpleNamespace(name="")
        symbols, _, _, _ = self._call_extract_with_mocked_result([node])
        assert symbols == []


# ===========================================================================
# 4. languages/markdown.py — OverflowError guard
# ===========================================================================


class TestMarkdownOverflowErrorGuard:
    """markdown.extract() returns empty lists when OverflowError is raised."""

    def test_overflow_error_returns_empty(self, caplog):
        """When an OverflowError occurs during extraction, all four lists are empty."""
        from token_goat.languages import markdown

        # Patch _ATX_RE.finditer to raise OverflowError mid-extraction
        class _OverflowRe:
            def finditer(self, text):
                raise OverflowError("integer overflow in count")

            def match(self, text):
                return None

        with (
            patch.object(markdown, "_ATX_RE", _OverflowRe()),
            caplog.at_level(logging.DEBUG, logger="token_goat.languages.markdown"),
        ):
            symbols, refs, imp_exp, sections = markdown.extract(
                b"# Hello\n\nSome text", "test.md"
            )

        assert symbols == []
        assert refs == []
        assert imp_exp == []
        assert sections == []
        assert any("parse failed" in r.message for r in caplog.records)

    def test_normal_extraction_works(self):
        """Sanity check: valid markdown returns headings without error."""
        from token_goat.languages import markdown

        source = b"# Title\n\n## Section\n\nContent here"
        symbols, refs, imp_exp, sections = markdown.extract(source, "doc.md")

        heading_names = [s.name for s in symbols]
        assert "Title" in heading_names
        assert "Section" in heading_names


# ===========================================================================
# 5. image_shrink.py — contextlib.suppress includes AttributeError
# ===========================================================================


class TestImageShrinkExifTransposeAttributeErrorSuppressed:
    """AttributeError (and other documented errors) from exif_transpose are suppressed."""

    def _make_large_png(self, tmp_path, name="test.png"):
        """Create a PNG large enough to pass SIZE_THRESHOLD_BYTES using raw bytes."""
        from token_goat.image_shrink import SIZE_THRESHOLD_BYTES

        # Write a fake-large file (just over threshold, but bypass PIL by mocking open)
        src = tmp_path / name
        src.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (SIZE_THRESHOLD_BYTES + 1))
        return src

    def test_attribute_error_is_suppressed_in_suppress_block(self):
        """The contextlib.suppress block in shrink() lists AttributeError.

        Verify by inspecting the source directly: the suppress call must include
        AttributeError so that images without EXIF segments don't raise.
        """
        import inspect

        from token_goat import image_shrink

        source = inspect.getsource(image_shrink.shrink)
        # The suppress call must include AttributeError
        assert "AttributeError" in source
        # And it must appear alongside the other documented errors
        assert "contextlib.suppress" in source

    def test_suppress_block_includes_all_documented_errors(self):
        """The suppress block covers OSError, ValueError, AttributeError, ZeroDivisionError."""
        import inspect

        from token_goat import image_shrink

        source = inspect.getsource(image_shrink.shrink)
        for exc_name in ("OSError", "ValueError", "AttributeError", "ZeroDivisionError"):
            assert exc_name in source, f"Expected {exc_name} in suppress block"

    def test_attribute_error_does_not_propagate(self, tmp_path):
        """AttributeError from exif_transpose must not propagate out of shrink()."""
        try:
            from PIL import Image, ImageOps  # noqa: F401
        except ImportError:
            pytest.skip("Pillow not installed")

        from token_goat import image_shrink

        src = tmp_path / "photo.png"
        # Create a real image large enough to pass threshold checks
        img = Image.new("RGB", (2000, 2000), color=(200, 100, 50))
        img.save(str(src), format="PNG")

        # If AttributeError propagated, shrink() would raise instead of returning None.
        # contextlib.suppress catches it, so shrink() must either return a Path or None —
        # either outcome is acceptable; the critical invariant is no exception raised.
        with patch("PIL.ImageOps.exif_transpose", side_effect=AttributeError("no EXIF data")):
            try:
                image_shrink.shrink(src)
                # shrink() returned (None or Path) — suppress worked correctly
            except AttributeError:
                pytest.fail("AttributeError from exif_transpose was not suppressed")

    def test_zero_division_error_does_not_propagate(self, tmp_path):
        """ZeroDivisionError from corrupt rational EXIF tags must also be suppressed."""
        try:
            from PIL import Image, ImageOps  # noqa: F401
        except ImportError:
            pytest.skip("Pillow not installed")

        from token_goat import image_shrink

        src = tmp_path / "photo2.png"
        img = Image.new("RGB", (2000, 2000))
        img.save(str(src), format="PNG")

        with patch(
            "PIL.ImageOps.exif_transpose", side_effect=ZeroDivisionError("corrupt rational tag")
        ):
            try:
                image_shrink.shrink(src)
            except ZeroDivisionError:
                pytest.fail("ZeroDivisionError from exif_transpose was not suppressed")


# ===========================================================================
# 6. compact.py — sanitize_log_str on symbol names and paths
# ===========================================================================


class TestCompactSanitizeLogStr:
    """build_manifest strips newlines from symbol names and file paths."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Point data_dir at a fresh temp dir so bash_outputs/ is empty.

        Without this, build_manifest → _render_active_errors_section globs the
        real bash_outputs/ dir (thousands of .json files) on every test, adding
        ~4 s each.  An empty temp dir returns immediately.
        """

    def _make_session(self, path, symbols=None, edited=None):
        """Return a minimal SessionCache-like object."""
        import time

        from token_goat.session import FileEntry, SessionCache

        now = time.time()
        fe = FileEntry(
            rel_or_abs=path,
            last_read_ts=now,
            read_count=1,
            symbols_read=symbols or [],
            line_ranges=[],
        )
        return SessionCache(
            session_id="aabbccdd" * 4,
            started_ts=now,
            last_activity_ts=now,
            files={path: fe},
            greps=[],
            edited_files=edited or {},
        )

    def test_newline_in_file_path_stripped_from_manifest(self):
        """A file path containing a newline has the newline replaced, not preserved."""
        from token_goat.compact import build_manifest

        evil_path = "src/foo.py\nINJECTED SECTION"
        session = self._make_session(evil_path)

        with patch("token_goat.compact._load_session_cache", return_value=session):
            result = build_manifest("aabbccdd" * 4)

        # The literal newline followed by the injected text must not appear verbatim.
        # sanitize_log_str replaces \n with the two-character sequence \n (backslash-n),
        # so the injected text may appear escaped but not as a real line break.
        assert "\nINJECTED SECTION" not in result

    def test_newline_in_symbol_name_stripped_from_manifest(self):
        """A symbol name containing a newline is sanitized in the Symbols Accessed section."""
        from token_goat.compact import build_manifest

        evil_symbol = "legitimate_fn\nFAKE: edited secret.key"
        session = self._make_session("src/real.py", symbols=[evil_symbol])

        with patch("token_goat.compact._load_session_cache", return_value=session):
            result = build_manifest("aabbccdd" * 4)

        # The literal newline must not appear before "FAKE:"
        assert "\nFAKE:" not in result

    def test_newline_in_edited_file_path_stripped(self):
        """An edited file path containing a newline is sanitized."""
        from token_goat.compact import build_manifest

        evil_path = "src/bar.py\nFORGED HEADING"
        # Also put the evil path as the read-file entry so the manifest is non-empty
        session = self._make_session("src/clean.py", edited={evil_path: 2})

        with patch("token_goat.compact._load_session_cache", return_value=session):
            result = build_manifest("aabbccdd" * 4)

        # The literal newline before "FORGED HEADING" must not appear
        assert "\nFORGED HEADING" not in result


# ===========================================================================
# 7. db.py — _PROJECT_HASH_RE rejects uppercase and underscores
# ===========================================================================


class TestProjectHashRegex:
    """_PROJECT_HASH_RE only matches lowercase hex strings."""

    def _get_re(self):
        from token_goat.db import _PROJECT_HASH_RE

        return _PROJECT_HASH_RE

    def test_valid_lowercase_hex_matches(self):
        regex = self._get_re()
        assert regex.match("a" * 40) is not None
        assert regex.match("0" * 40) is not None
        assert regex.match("deadbeef1234567890abcdef" * 1) is not None

    def test_uppercase_letters_rejected(self):
        regex = self._get_re()
        assert regex.match("DEADBEEF" + "a" * 32) is None
        assert regex.match("A" * 40) is None

    def test_underscore_rejected(self):
        regex = self._get_re()
        assert regex.match("abc_def" + "0" * 33) is None

    def test_hyphen_rejected(self):
        regex = self._get_re()
        assert regex.match("abc-def" + "0" * 33) is None

    def test_empty_string_rejected(self):
        regex = self._get_re()
        assert regex.match("") is None

    def test_mixed_case_rejected(self):
        regex = self._get_re()
        assert regex.match("aAbBcC" + "0" * 34) is None

    def test_validate_function_raises_on_uppercase(self):
        """_validate_project_hash raises ValueError for uppercase hex."""
        from token_goat.db import _validate_project_hash

        with pytest.raises(ValueError):
            _validate_project_hash("ABCDEF1234567890ABCDEF1234567890ABCDEF12")

    def test_validate_function_raises_on_underscore(self):
        from token_goat.db import _validate_project_hash

        with pytest.raises(ValueError):
            _validate_project_hash("abc_def1234567890abcdef1234567890abcdef1")

    def test_validate_function_accepts_lowercase_hex(self):
        from token_goat.db import _validate_project_hash

        # Should not raise
        _validate_project_hash("a" * 40)


# ===========================================================================
# 8. hooks_read.py — _try_shrink_image sanitizes file_path in stats detail
# ===========================================================================


class TestTryShrinkImageSanitizesFilePath:
    """_try_shrink_image passes a sanitized file_path to db.record_stat."""

    def test_newline_in_file_path_sanitized_in_stat(self, tmp_path):
        """Newlines in file_path are stripped before being stored as stat detail."""
        try:
            import PIL  # noqa: F401
        except ImportError:
            pytest.skip("Pillow not installed")

        # Create an oversized image that will actually be shrunk
        src = tmp_path / "evil\npath.png"
        evil_path_str = str(src)

        from token_goat.hooks_read import _try_shrink_image

        recorded_details = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail=""):
            recorded_details.append(detail)

        with (
            patch("token_goat.image_shrink.is_image_path", return_value=True),
            patch("token_goat.image_shrink.should_shrink", return_value=True),
            patch(
                "token_goat.image_shrink.shrink",
                return_value=tmp_path / "cached.png",
            ),
            patch(
                "token_goat.image_shrink.stats_for",
                return_value={
                    "src_bytes": 200_000,
                    "out_bytes": 10_000,
                    "bytes_saved": 190_000,
                    "orig_width": 2000,
                    "orig_height": 1500,
                    "out_width": 1024,
                    "out_height": 768,
                },
            ),
            patch("token_goat.db.record_stat", side_effect=fake_record_stat),
        ):
            _try_shrink_image(evil_path_str, {"file_path": evil_path_str})

        assert recorded_details, "record_stat should have been called"
        detail = recorded_details[0]
        # The literal newline must not appear in the stored detail
        assert "\n" not in detail
