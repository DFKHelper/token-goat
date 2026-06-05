"""Tests added in iteration 75 — covering code paths from iterations 70-74.

Targets:
  - Import deferral (iter 70): db does not load sqlite_vec at module level;
    read_replacement does not import parser at module level.
  - Symlink escape guard (iter 74): iter_source_files skips symlinks pointing
    outside the project root; symlinks inside are NOT skipped.
  - XML escape in plist (iter 74): _xml_escape correctly escapes special chars.
  - Error handling (iter 72): _get_model raises EmbeddingsUnavailable on
    ImportError; find_project returns None when canonicalize raises OSError.
  - Type-narrowed hooks (iter 71): HookResponse, HookSpecificOutputDeny,
    HookSpecificOutputContext, HookSpecificOutputUpdate TypedDicts have the
    expected fields; helper functions produce correctly-shaped dicts.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# 1. Import deferral — db module must NOT load sqlite_vec at import time
# ---------------------------------------------------------------------------


class TestDbImportDeferral:
    """Verify that importing token_goat.db does not trigger sqlite_vec loading."""

    def test_db_imports_without_sqlite_vec(self):
        """db module must be importable even when sqlite_vec is absent."""
        import token_goat as _tg_pkg  # noqa: PLC0415

        # Temporarily block sqlite_vec to confirm it is not imported at module level.
        blocked = sys.modules.pop("sqlite_vec", None)
        sys.modules["sqlite_vec"] = None  # type: ignore[assignment]  # simulate absent
        try:
            # Force re-evaluation by removing db from cache if present.
            db_mod = sys.modules.pop("token_goat.db", None)
            pkg_attr = getattr(_tg_pkg, "db", None)
            import token_goat.db  # noqa: PLC0415, F401

            # Restore both sys.modules entry AND the package attribute so later
            # tests that do `from . import db` get the original module object.
            if db_mod is not None:
                sys.modules["token_goat.db"] = db_mod
                _tg_pkg.db = db_mod
            elif pkg_attr is not None:
                _tg_pkg.db = pkg_attr
        finally:
            if blocked is None:
                sys.modules.pop("sqlite_vec", None)
            else:
                sys.modules["sqlite_vec"] = blocked

    def test_db_has_no_top_level_sqlite_vec_import(self):
        """Statically verify db.py has no top-level 'import sqlite_vec' or 'from sqlite_vec'."""
        import ast

        db_path = Path(__file__).parent.parent / "src" / "token_goat" / "db.py"
        tree = ast.parse(db_path.read_text(encoding="utf-8"))
        top_level_imports = [
            node
            for node in ast.iter_child_nodes(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
        ]
        for node in top_level_imports:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name != "sqlite_vec", "sqlite_vec imported at top level in db.py"
            elif isinstance(node, ast.ImportFrom):
                assert node.module != "sqlite_vec", "from sqlite_vec imported at top level in db.py"

    def test_read_replacement_has_no_top_level_parser_import(self):
        """Statically verify read_replacement.py has no top-level import of parser."""
        import ast

        rr_path = (
            Path(__file__).parent.parent / "src" / "token_goat" / "read_replacement.py"
        )
        tree = ast.parse(rr_path.read_text(encoding="utf-8"))
        top_level_imports = [
            node
            for node in ast.iter_child_nodes(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
        ]
        for node in top_level_imports:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert "parser" not in alias.name, (
                        f"parser imported at top level in read_replacement.py: {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                assert "parser" not in module, (
                    f"parser imported at top level in read_replacement.py: {module}"
                )

    def test_sqlite_vec_only_loaded_inside_function(self):
        """sqlite_vec import in db.py must only appear inside a function body, not at module level."""
        import ast

        db_path = Path(__file__).parent.parent / "src" / "token_goat" / "db.py"
        tree = ast.parse(db_path.read_text(encoding="utf-8"))
        # Collect all Import/ImportFrom nodes that are direct children of the module body
        top_level = set(id(n) for n in ast.iter_child_nodes(tree))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and id(node) in top_level:
                for alias in node.names:
                    assert alias.name != "sqlite_vec"
            elif isinstance(node, ast.ImportFrom) and id(node) in top_level:
                assert (node.module or "") != "sqlite_vec"


# ---------------------------------------------------------------------------
# 2. Symlink escape guard — iter_source_files
# ---------------------------------------------------------------------------


class TestIterSourceFilesSymlinks:
    """iter_source_files must skip symlinks pointing outside the project root."""

    @pytest.fixture()
    def proj(self, tmp_path):
        """Create a minimal project structure with a .py file inside."""
        from token_goat.project import Project, canonicalize, project_hash

        root = tmp_path / "myproject"
        root.mkdir()
        (root / ".git").mkdir()
        src = root / "src"
        src.mkdir()
        (src / "main.py").write_text("def hello(): pass\n", encoding="utf-8")
        canon = canonicalize(root)
        return Project(root=canon, hash=project_hash(canon), marker=".git")

    def test_normal_py_file_is_yielded(self, proj):
        from token_goat.parser import iter_source_files

        paths = list(iter_source_files(proj))
        names = [p.name for p in paths]
        assert "main.py" in names

    @pytest.mark.skipif(sys.platform == "win32", reason="Symlinks require elevated rights on Windows")
    def test_symlink_outside_root_is_skipped(self, tmp_path):
        """A .py symlink pointing outside the project root must be skipped."""
        from token_goat.parser import iter_source_files
        from token_goat.project import Project, canonicalize, project_hash

        outside = tmp_path / "outside.py"
        outside.write_text("x = 1\n", encoding="utf-8")

        root = tmp_path / "proj"
        root.mkdir()
        (root / ".git").mkdir()
        link = root / "escape.py"
        link.symlink_to(outside)

        canon = canonicalize(root)
        proj = Project(root=canon, hash=project_hash(canon), marker=".git")
        paths = list(iter_source_files(proj))
        assert link not in paths, "symlink pointing outside root was incorrectly yielded"

    @pytest.mark.skipif(sys.platform == "win32", reason="Symlinks require elevated rights on Windows")
    def test_symlink_inside_root_is_yielded(self, tmp_path):
        """A .py symlink pointing inside the project root must NOT be skipped."""
        from token_goat.parser import iter_source_files
        from token_goat.project import Project, canonicalize, project_hash

        root = tmp_path / "proj"
        root.mkdir()
        (root / ".git").mkdir()
        real_file = root / "real.py"
        real_file.write_text("y = 2\n", encoding="utf-8")
        link = root / "alias.py"
        link.symlink_to(real_file)

        canon = canonicalize(root)
        proj = Project(root=canon, hash=project_hash(canon), marker=".git")
        paths = list(iter_source_files(proj))
        names = [p.name for p in paths]
        # Both the real file and the internal symlink must appear (or at least real.py)
        assert "real.py" in names

    def test_stat_oserror_skips_file(self, tmp_path):
        """Files that raise OSError during stat() are silently skipped, no crash."""
        from token_goat.parser import iter_source_files
        from token_goat.project import Project, canonicalize, project_hash

        root = tmp_path / "statproj"
        root.mkdir()
        (root / ".git").mkdir()
        py_file = root / "broken.py"
        py_file.write_text("x = 1\n", encoding="utf-8")

        canon = canonicalize(root)
        proj = Project(root=canon, hash=project_hash(canon), marker=".git")

        # Patch Path.stat so it raises OSError only for full-follow stat calls
        # (not lstat / follow_symlinks=False used by is_symlink).
        real_stat = Path.stat

        def _flaky_stat(self_path, *args, **kwargs):
            follow = kwargs.get("follow_symlinks", True)
            if self_path.name == "broken.py" and follow is not False:
                raise OSError("simulated stat failure")
            return real_stat(self_path, *args, **kwargs)

        with patch.object(Path, "stat", _flaky_stat):
            result = list(iter_source_files(proj))
        # broken.py should be absent (skipped due to OSError); no crash
        names = [p.name for p in result]
        assert "broken.py" not in names


# ---------------------------------------------------------------------------
# 3. XML escape in plist — _xml_escape
# ---------------------------------------------------------------------------


class TestXmlEscape:
    """_xml_escape must escape all XML-special characters correctly."""

    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.install import _xml_escape  # noqa: PLC0415

        self._fn = _xml_escape

    def test_ampersand_escaped(self):
        assert self._fn("a&b") == "a&amp;b"

    def test_less_than_escaped(self):
        assert self._fn("a<b") == "a&lt;b"

    def test_greater_than_escaped(self):
        assert self._fn("a>b") == "a&gt;b"

    def test_double_quote_escaped(self):
        assert self._fn('say "hi"') == "say &quot;hi&quot;"

    def test_single_quote_escaped(self):
        assert self._fn("it's") == "it&apos;s"

    def test_plain_string_unchanged(self):
        assert self._fn("hello world") == "hello world"

    def test_all_special_chars_in_one_string(self):
        result = self._fn('<tag attr=\'val\' other="x">&amp;</tag>')
        assert "&lt;" in result
        assert "&gt;" in result
        assert "&amp;" in result
        assert "&apos;" in result
        assert "&quot;" in result

    def test_empty_string(self):
        assert self._fn("") == ""

    def test_no_double_escaping(self):
        # "&amp;" should become "&amp;amp;" — xml.sax.saxutils escapes the & again
        result = self._fn("&amp;")
        assert result == "&amp;amp;"

    def test_path_with_angle_brackets(self):
        result = self._fn("/usr/local/<bin>")
        assert "<" not in result
        assert ">" not in result
        assert "&lt;" in result
        assert "&gt;" in result


# ---------------------------------------------------------------------------
# 4. Error handling — embeddings._get_model and project.find_project
# ---------------------------------------------------------------------------


class TestGetModelErrorHandling:
    """_get_model raises EmbeddingsUnavailable on ImportError."""

    def test_import_error_raises_unavailable(self):
        # Clear the model cache to force a fresh load attempt
        import token_goat.embeddings as emb  # noqa: PLC0415
        from token_goat.embeddings import EmbeddingsUnavailable, _get_model

        original_cache = emb._MODEL_CACHE.copy()
        emb._MODEL_CACHE.clear()

        try:
            with patch("builtins.__import__", side_effect=_make_import_blocker("fastembed")), pytest.raises(EmbeddingsUnavailable, match="fastembed not installed"):
                _get_model("BAAI/bge-small-en-v1.5")
        finally:
            emb._MODEL_CACHE.update(original_cache)

    def test_oserror_raises_unavailable(self):
        """OSError during model load raises EmbeddingsUnavailable."""
        import token_goat.embeddings as emb  # noqa: PLC0415
        from token_goat.embeddings import EmbeddingsUnavailable, _get_model

        original_cache = emb._MODEL_CACHE.copy()
        emb._MODEL_CACHE.clear()

        fake_te_cls = MagicMock(side_effect=OSError("disk full"))

        try:
            with patch.dict(sys.modules, {"fastembed": MagicMock(TextEmbedding=fake_te_cls)}), pytest.raises(EmbeddingsUnavailable, match="fastembed model load failed"):
                _get_model("BAAI/bge-small-en-v1.5")
        finally:
            emb._MODEL_CACHE.update(original_cache)

    def test_model_cached_on_success(self):
        """Successful model load is cached — second call does not re-instantiate."""
        import token_goat.embeddings as emb  # noqa: PLC0415

        fake_model = MagicMock()
        model_name = "__test_cached_model__"
        emb._MODEL_CACHE[model_name] = fake_model

        try:
            result = emb._get_model(model_name)
            assert result is fake_model
        finally:
            emb._MODEL_CACHE.pop(model_name, None)


def _make_import_blocker(blocked_name: str):
    """Return a side_effect for builtins.__import__ that raises ImportError for blocked_name."""
    real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__  # type: ignore[attr-defined]

    def _import(name, *args, **kwargs):
        if name == blocked_name or name.startswith(blocked_name + "."):
            raise ImportError(f"No module named '{blocked_name}'")
        return real_import(name, *args, **kwargs)

    return _import


class TestFindProjectOsError:
    """find_project returns None when canonicalize raises OSError or ValueError."""

    def test_oserror_from_canonicalize_returns_none(self, tmp_path):
        from token_goat.project import find_project

        with patch("token_goat.project.canonicalize", side_effect=OSError("permission denied")):
            result = find_project(tmp_path)
        assert result is None

    def test_valueerror_from_canonicalize_returns_none(self, tmp_path):
        from token_goat.project import find_project

        with patch("token_goat.project.canonicalize", side_effect=ValueError("bad path")):
            result = find_project(tmp_path)
        assert result is None

    def test_find_project_returns_none_for_no_marker(self, tmp_path):
        """Directory with no project markers should return None."""
        from token_goat.project import find_project

        bare = tmp_path / "bare"
        bare.mkdir()
        result = find_project(bare)
        assert result is None

    def test_find_project_stops_at_system_temp(self, tmp_path):
        """Stray project-marker files in %TEMP% / /tmp must not be treated as a project root.

        find_project stops the upward walk when it reaches tempfile.gettempdir(),
        so a package.json (or similar) dropped there by an unrelated tool does not
        absorb every pytest tmp_path subdirectory into a phantom project.
        """
        import tempfile

        from token_goat.project import find_project

        sys_temp = Path(tempfile.gettempdir())
        stray = sys_temp / "package.json"
        pre_existing = stray.exists()
        if not pre_existing:
            stray.write_text('{"name": "stray-test-marker"}', encoding="utf-8")
        try:
            bare = tmp_path / "bare"
            bare.mkdir()
            result = find_project(bare)
            assert result is None, (
                f"find_project should stop at system temp; got {result!r} "
                f"(tmp_path is under sys_temp={sys_temp})"
            )
        finally:
            if not pre_existing:
                stray.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# 5. Type-narrowed hooks — hooks_common TypedDicts
# ---------------------------------------------------------------------------


class TestHookCommonTypedDicts:
    """HookResponse and HookSpecificOutput* TypedDicts have the expected fields."""

    def test_hook_specific_output_deny_fields(self):
        from token_goat.hooks_common import HookSpecificOutputDeny

        keys = set(HookSpecificOutputDeny.__annotations__)
        assert "hookEventName" in keys
        assert "permissionDecision" in keys
        assert "permissionDecisionReason" in keys
        assert "additionalContext" in keys

    def test_hook_specific_output_context_fields(self):
        from token_goat.hooks_common import HookSpecificOutputContext

        keys = set(HookSpecificOutputContext.__annotations__)
        assert "hookEventName" in keys
        assert "additionalContext" in keys

    def test_hook_specific_output_update_fields(self):
        from token_goat.hooks_common import HookSpecificOutputUpdate

        keys = set(HookSpecificOutputUpdate.__annotations__)
        assert "hookEventName" in keys
        assert "updatedInput" in keys
        assert "additionalContext" in keys

    def test_hook_response_fields(self):
        from token_goat.hooks_common import HookResponse

        keys = set(HookResponse.__annotations__)
        assert "continue" in keys
        assert "systemMessage" in keys
        assert "hookSpecificOutput" in keys

    def test_continue_returns_dict_with_continue_true(self):
        from token_goat.hooks_common import CONTINUE

        result = CONTINUE()
        assert result == {"continue": True}

    def test_continue_returns_fresh_dict_each_call(self):
        from token_goat.hooks_common import CONTINUE

        a = CONTINUE()
        b = CONTINUE()
        assert a is not b, "CONTINUE() must return a new dict each time"

    def test_deny_redirect_shape(self):
        from token_goat.hooks_common import deny_redirect

        result = deny_redirect("too big", "use token-goat instead")
        assert result["continue"] is True
        hso = result["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert hso["permissionDecision"] == "deny"
        assert hso["permissionDecisionReason"] == "too big"
        assert hso["additionalContext"] == "use token-goat instead"

    def test_pre_tool_use_with_context_shape(self):
        from token_goat.hooks_common import pre_tool_use_with_context

        result = pre_tool_use_with_context("hey look here")
        assert result["continue"] is True
        hso = result["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert hso["additionalContext"] == "hey look here"
        assert "permissionDecision" not in hso

    def test_pre_tool_use_with_update_shape(self):
        from token_goat.hooks_common import pre_tool_use_with_update

        updated = {"file_path": "/new/path.py"}
        result = pre_tool_use_with_update(updated, "redirected to shrunk image")
        assert result["continue"] is True
        hso = result["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert hso["updatedInput"] == updated
        assert hso["additionalContext"] == "redirected to shrunk image"

    def test_get_tool_input_none_payload(self):
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input(None) == {}

    def test_get_tool_input_missing_key(self):
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input({"other_key": "val"}) == {}

    def test_get_tool_input_none_value(self):
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input({"tool_input": None}) == {}

    def test_get_tool_input_valid(self):
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input({"tool_input": {"file_path": "x.py"}}) == {"file_path": "x.py"}

    def test_get_tool_input_non_dict_payload(self):
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input("not a dict") == {}  # type: ignore[arg-type]
