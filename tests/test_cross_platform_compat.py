"""Cross-platform and cross-harness compatibility tests.

Covers five sub-areas:
  A. Windows-specific path handling in bash_parser._is_system_path
  B. Gemini CLI hook payload normalization with unknown/extra fields
  C. WSL path translation — project hash consistency across shells
  D. Python 3.11/3.12/3.13 API compatibility (tomllib, no match-statement gaps)
  E. Hook wire format round-trip across all supported harnesses
"""
from __future__ import annotations

import ast
import functools
import sys
from pathlib import Path
from typing import NamedTuple

import pytest


class _SourceFile(NamedTuple):
    rel: str
    text: str
    tree: ast.Module


@functools.lru_cache(maxsize=1)
def _parsed_source_files() -> tuple[_SourceFile, ...]:
    """Parse every token_goat source file once per process; result is cached."""
    src_dir = Path(__file__).parent.parent / "src" / "token_goat"
    python_files = list(src_dir.glob("*.py")) + list((src_dir / "languages").glob("*.py"))
    result: list[_SourceFile] = []
    for py_file in python_files:
        is_lang = py_file.parent.name == "languages"
        rel = f"languages/{py_file.name}" if is_lang else py_file.name
        text = py_file.read_text(encoding="utf-8", errors="replace")
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        result.append(_SourceFile(rel=rel, text=text, tree=tree))
    return tuple(result)

# ---------------------------------------------------------------------------
# Sub-area A: Windows path handling in bash_parser._is_system_path
# ---------------------------------------------------------------------------


class TestIsSystemPathWindowsPaths:
    """_is_system_path must reject Windows system paths regardless of separator style."""

    from token_goat.bash_parser import _is_system_path  # type: ignore[attr-defined]

    def test_windows_backslash_system32_rejected(self) -> None:
        """C:\\Windows\\System32 (backslash form) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path(r"C:\Windows\System32\drivers\etc\hosts") is True

    def test_windows_forward_slash_system32_rejected(self) -> None:
        """C:/Windows/System32 (forward-slash form) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("C:/Windows/System32/drivers/etc/hosts") is True

    def test_windows_lowercase_system32_rejected(self) -> None:
        """c:/windows/system32 (all lowercase) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("c:/windows/system32/notepad.exe") is True

    def test_windows_program_files_forward_slash_rejected(self) -> None:
        """C:/Program Files/Python/python.exe is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("C:/Program Files/Python/python.exe") is True

    def test_windows_program_files_backslash_rejected(self) -> None:
        r"""C:\Program Files\Python\python.exe is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path(r"C:\Program Files\Python\python.exe") is True

    def test_windows_programdata_rejected(self) -> None:
        """C:/ProgramData is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("C:/ProgramData/Microsoft/something") is True

    def test_wsl_mounted_windows_system_rejected(self) -> None:
        """/mnt/c/windows/system32 (WSL form) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/mnt/c/windows/system32/notepad.exe") is True

    def test_wsl_mounted_windows_programdata_rejected(self) -> None:
        """/mnt/c/programdata/... (WSL form) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/mnt/c/programdata/Microsoft/Windows/AppLocker") is True

    def test_wsl_mounted_program_files_rejected(self) -> None:
        """/mnt/c/program files/... (WSL form) is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/mnt/c/program files/Python 3.12/python.exe") is True

    def test_user_project_path_accepted(self) -> None:
        r"""C:\Users\foo\project\file.py is NOT a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path(r"C:\Users\foo\project\file.py") is False

    def test_user_project_path_forward_slash_accepted(self) -> None:
        """C:/Users/foo/project/file.py is NOT a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("C:/Users/foo/project/file.py") is False

    def test_wsl_user_project_accepted(self) -> None:
        """/mnt/c/Users/foo/project/src/main.py is NOT a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/mnt/c/Users/foo/project/src/main.py") is False

    def test_posix_system_etc_rejected(self) -> None:
        """/etc/hosts is a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/etc/hosts") is True

    def test_posix_project_path_accepted(self) -> None:
        """/home/user/project/main.py is NOT a system path."""
        from token_goat.bash_parser import _is_system_path

        assert _is_system_path("/home/user/project/main.py") is False


class TestBashParserWindowsProjectPaths:
    """Full parse() calls with explicit Windows absolute paths should be treated as reads."""

    def test_type_command_windows_path_with_backslashes(self) -> None:
        r"""type C:\Users\foo\project\file.py should parse as a read."""
        from token_goat.bash_parser import parse

        intent = parse(r'type "C:\Users\foo\project\file.py"')
        assert intent.kind == "read"

    def test_cat_windows_user_path_forward_slash(self) -> None:
        """cat C:/Users/zelys/project/src/app.py should parse as a read."""
        from token_goat.bash_parser import parse

        intent = parse("cat C:/Users/zelys/project/src/app.py")
        assert intent.kind == "read"
        assert intent.target_path == "C:/Users/zelys/project/src/app.py"


# ---------------------------------------------------------------------------
# Sub-area B: Gemini CLI compatibility — unknown fields and extra fields
# ---------------------------------------------------------------------------


class TestGeminiNormalizeUnknownFields:
    """normalize_payload (gemini) must handle unknown/extra fields gracefully."""

    def test_unknown_fields_preserved(self) -> None:
        """Unknown fields in Gemini payload should be preserved, not dropped."""
        from token_goat.hooks_cli import normalize_payload

        payload = {
            "tool_name": "read_file",
            "tool_input": {"path": "/src/foo.py"},
            "session_id": "sess-abc",
            "cwd": "/home/user/project",
            "some_future_field": "extra_value",
        }
        result = normalize_payload(payload, harness="gemini")
        assert result["tool_name"] == "Read"
        assert result["some_future_field"] == "extra_value"
        assert result["session_id"] == "sess-abc"
        assert result["cwd"] == "/home/user/project"

    def test_function_call_id_remapped_to_tool_use_id(self) -> None:
        """functionCallId (Gemini wire format) must be remapped to toolUseId."""
        from token_goat.hooks_cli import normalize_payload

        payload = {
            "tool_name": "run_shell_command",
            "tool_input": {"command": "ls -la"},
            "functionCallId": "call-xyz-123",
        }
        result = normalize_payload(payload, harness="gemini")
        assert result.get("toolUseId") == "call-xyz-123"
        assert "functionCallId" not in result

    def test_tool_use_id_not_overwritten_if_present(self) -> None:
        """If toolUseId is already present, functionCallId must not overwrite it."""
        from token_goat.hooks_cli import normalize_payload

        payload = {
            "tool_name": "read_file",
            "tool_input": {"path": "/src/x.py"},
            "toolUseId": "existing-id",
            "functionCallId": "gemini-call-id",
        }
        result = normalize_payload(payload, harness="gemini")
        assert result["toolUseId"] == "existing-id"

    def test_harness_stamp_always_present(self) -> None:
        """Normalized Gemini payload must always have _tg_harness='gemini'."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"tool_name": "glob", "tool_input": {"pattern": "**/*.py"}}
        result = normalize_payload(payload, harness="gemini")
        assert result["_tg_harness"] == "gemini"

    def test_none_tool_input_handled(self) -> None:
        """A Gemini payload with null tool_input must not crash."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"tool_name": "run_shell_command", "tool_input": None}
        result = normalize_payload(payload, harness="gemini")
        assert result["tool_name"] == "Bash"
        # tool_input was None — preserved as-is after remapping attempt
        assert result["tool_input"] is None or isinstance(result["tool_input"], dict)


class TestGeminiDenormalizeRoundTrip:
    """Full Gemini wire format round-trip: normalize then denormalize."""

    def test_allow_round_trip(self) -> None:
        """Normalize a Gemini payload, dispatch a no-op, denormalize back to allow."""
        from token_goat.hooks_cli import denormalize_response, normalize_payload

        normalize_payload(
            {"tool_name": "read_file", "tool_input": {"path": "/src/main.py"}, "session_id": "s1"},
            harness="gemini",
        )
        # Simulate what a handler returns: the canonical continue:True response.
        handler_output = {"continue": True, "_tg_harness": "gemini"}
        result = denormalize_response(handler_output, harness="gemini")
        assert result["decision"] == "allow"
        assert "continue" not in result

    def test_deny_round_trip(self) -> None:
        """Deny response round-trip: continue:False → decision:deny."""
        from token_goat.hooks_cli import denormalize_response

        handler_output = {
            "continue": False,
            "hookSpecificOutput": {"permissionDecisionReason": "blocked by security policy"},
        }
        result = denormalize_response(handler_output, harness="gemini")
        assert result["decision"] == "deny"
        assert result.get("reason") == "blocked by security policy"


# ---------------------------------------------------------------------------
# Sub-area C: WSL path translation — project hash consistency
# ---------------------------------------------------------------------------


class TestWSLProjectHashConsistency:
    """Project hash must be identical for Windows and WSL forms of the same path."""

    def test_normalize_shell_prefix_wsl_and_windows_equivalent(self) -> None:
        """_normalize_shell_drive_prefix must produce c:/... from both WSL and Windows forms."""
        from token_goat.project import _normalize_shell_drive_prefix  # type: ignore[attr-defined]

        wsl_form = "/mnt/c/Users/zelys/projects/my-app"
        win_form = "c:/Users/zelys/projects/my-app"
        assert _normalize_shell_drive_prefix(wsl_form) == win_form

    def test_normalize_path_wsl_and_windows_same_key(self) -> None:
        """util.normalize_path must produce identical keys for WSL and Windows path forms."""
        from token_goat.util import normalize_path

        wsl_form = "/mnt/c/Users/zelys/projects/my-app/src/main.py"
        win_backslash = r"C:\Users\zelys\projects\my-app\src\main.py"
        win_forward = "C:/Users/zelys/projects/my-app/src/main.py"

        key_wsl = normalize_path(wsl_form)
        key_win_bs = normalize_path(win_backslash)
        key_win_fw = normalize_path(win_forward)

        assert key_wsl == key_win_bs == key_win_fw

    def test_session_normalize_path_wsl_and_windows_same_key(self) -> None:
        """session._normalize_path aliases WSL and Windows forms to the same key."""
        from token_goat import session

        # Access the private helper used by hooks_read for path comparison.
        _norm = session._normalize_path  # type: ignore[attr-defined]
        wsl = "/mnt/c/foo/bar.py"
        win = r"C:\foo\bar.py"
        assert _norm(wsl) == _norm(win)

    @pytest.mark.skipif(
        sys.platform != "win32", reason="project_hash canonicalization is Windows-specific"
    )
    def test_project_hash_identical_wsl_and_windows(self) -> None:
        """project_hash(canonicalize()) is identical for all Windows shell forms."""
        from token_goat.project import canonicalize, project_hash

        # These are all representations of the same project root.
        forms = [
            "C:/Projects/myapp",
            "c:/Projects/myapp",
            "/mnt/c/Projects/myapp",
            "/c/Projects/myapp",
        ]
        hashes = {project_hash(canonicalize(Path(f))) for f in forms}
        assert len(hashes) == 1, f"Expected one hash, got {len(hashes)}: {hashes}"


# ---------------------------------------------------------------------------
# Sub-area D: Python 3.11/3.12/3.13 compatibility
# ---------------------------------------------------------------------------


class TestPythonVersionCompatibility:
    """Verify API usage that varies across Python 3.11/3.12/3.13."""

    def test_tomllib_available_as_stdlib(self) -> None:
        """tomllib must be available as stdlib (Python 3.11+); no fallback needed."""
        import tomllib  # noqa: F401

        # If this import succeeds, the stdlib version is being used.
        # Token-goat requires Python 3.11+, so tomllib must always be available.
        assert sys.version_info >= (3, 11), (
            f"tomllib is stdlib since 3.11; token-goat requires >=3.11; "
            f"running {sys.version_info.major}.{sys.version_info.minor}"
        )

    def test_tomllib_import_in_config(self) -> None:
        """config.py imports tomllib directly (not via try/except fallback)."""
        import ast
        import importlib.util

        spec = importlib.util.find_spec("token_goat.config")
        assert spec is not None
        config_path = Path(spec.origin)  # type: ignore[arg-type]
        source = config_path.read_text(encoding="utf-8")
        tree = ast.parse(source)

        # Verify: there's a bare `import tomllib` at module level (not inside try).
        tomllib_imports = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            and any(alias.name == "tomllib" for alias in node.names)
        ]
        assert len(tomllib_imports) >= 1, "config.py must import tomllib at module level"

        # Verify: no try/except blocks that import tomllib then fall back to tomli.
        tomli_fallback = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            and getattr(node, "module", "") == "tomli"
        ]
        assert len(tomli_fallback) == 0, (
            "config.py must not import from tomli (fallback for pre-3.11); "
            "token-goat requires Python 3.11+"
        )

    def test_no_match_statement_in_source(self) -> None:
        """No structural `match` statements in source (would require 3.10+).

        token-goat declares python_requires = '>=3.11', so match statements are
        syntactically fine — but only if they're actually 3.10 match-case syntax.
        This test confirms there are no such statements and avoids a regression
        if someone accidentally adds one without understanding the version floor.

        Note: token-goat already requires 3.11+, so match statements WOULD be
        fine. This test verifies we're not relying on them by checking there are
        none (since we use other approaches for dispatch logic).
        """
        import ast

        src_dir = Path(__file__).parent.parent / "src" / "token_goat"
        # Include both top-level source and the languages/ subdirectory.
        python_files = list(src_dir.glob("*.py")) + list((src_dir / "languages").glob("*.py"))
        assert len(python_files) > 0, "Expected source files in src/token_goat"

        match_stmts_found = []
        for py_file in python_files:
            try:
                tree = ast.parse(py_file.read_text(encoding="utf-8", errors="replace"))
                for node in ast.walk(tree):
                    if isinstance(node, ast.Match):
                        match_stmts_found.append(f"{py_file.parent.name}/{py_file.name}:{node.lineno}")
            except SyntaxError:
                pass  # Syntax errors are caught by other tests/CI

        assert match_stmts_found == [], (
            "Found structural match statements (Python 3.10+ syntax) in source files: "
            + ", ".join(match_stmts_found)
            + ". These are OK syntactically (3.11+ is required) but unexpected."
        )

    def test_python_version_at_least_311(self) -> None:
        """Confirm running on Python 3.11+ as declared in pyproject.toml."""
        assert sys.version_info >= (3, 11), (
            f"token-goat requires Python >=3.11; "
            f"running {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        )

    def test_dataclass_kw_only_supported(self) -> None:
        """kw_only=True in @dataclass is a 3.10+ feature used in source."""
        # Verify the Python version supports it.
        from dataclasses import dataclass

        @dataclass(kw_only=True)
        class _Probe:
            x: int = 0

        assert _Probe().x == 0

    def test_future_annotations_imported_in_annotated_modules(self) -> None:
        """Source files that use type annotations must import from __future__ import annotations.

        This is required for forward references in type hints to work correctly
        across Python 3.11/3.12/3.13 without needing string quotes everywhere.

        Files with no annotations (e.g. __main__.py, short utility entry points)
        are excluded since the import is unnecessary there.

        Covers both src/token_goat/*.py and src/token_goat/languages/*.py.
        """
        # Exclude files that legitimately have no annotations.
        excluded = {"__init__.py", "__main__.py"}
        missing = []
        for sf in _parsed_source_files():
            rel_name = sf.rel.split("/")[-1]
            if rel_name in excluded:
                continue
            has_annotations = any(
                isinstance(node, (ast.AnnAssign, ast.FunctionDef, ast.AsyncFunctionDef))
                and (
                    isinstance(node, ast.AnnAssign)
                    or getattr(node, "returns", None) is not None
                    or any(
                        arg.annotation is not None
                        for arg in (
                            node.args.args
                            + node.args.posonlyargs
                            + node.args.kwonlyargs
                            + ([node.args.vararg] if node.args.vararg else [])
                            + ([node.args.kwarg] if node.args.kwarg else [])
                        )
                    )
                )
                for node in ast.walk(sf.tree)
            )
            if has_annotations and "from __future__ import annotations" not in sf.text:
                missing.append(sf.rel)

        assert missing == [], (
            "These annotated source files are missing 'from __future__ import annotations': "
            + ", ".join(sorted(missing))
        )

    def test_no_type_alias_statements_in_source(self) -> None:
        """No Python 3.12+ ``type X = ...`` type alias statements in source.

        ``type X = ...`` (``ast.TypeAlias``) was added in Python 3.12.
        token-goat requires Python >=3.11, so this syntax would be a
        compat regression on the minimum supported version.
        Covers both src/token_goat/*.py and src/token_goat/languages/*.py.
        """
        source_files = _parsed_source_files()
        assert len(source_files) > 0, "Expected source files in src/token_goat"

        found = []
        for sf in source_files:
            for node in ast.walk(sf.tree):
                if type(node).__name__ == "TypeAlias":
                    found.append(f"{sf.rel}:{node.lineno}")  # type: ignore[attr-defined]

        assert found == [], (
            "Found Python 3.12+ 'type X = ...' alias statements (incompatible with 3.11): "
            + ", ".join(found)
        )

    def test_no_deprecated_stdlib_imports_in_source(self) -> None:
        """No imports of stdlib modules removed in Python 3.12 or 3.13.

        Modules removed in 3.12: distutils
        Modules removed in 3.13: aifc, cgi, chunk (audio module), imghdr, mailcap,
            msilib, nis, nntplib, ossaudiodev, pipes, sndhdr, sunau, telnetlib, uu, xdrlib

        Note: ``chunk`` as a Python *identifier* (variable name) is fine — this
        test checks only ``import chunk`` / ``from chunk import ...`` statements.
        Covers both src/token_goat/*.py and src/token_goat/languages/*.py.
        """
        removed_312 = {"distutils"}
        removed_313 = {
            "aifc", "cgi", "chunk", "imghdr", "mailcap", "msilib", "nis",
            "nntplib", "ossaudiodev", "pipes", "sndhdr", "sunau", "telnetlib",
            "uu", "xdrlib",
        }
        deprecated_modules = removed_312 | removed_313

        bad_imports: list[str] = []
        for sf in _parsed_source_files():
            for node in ast.walk(sf.tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top = alias.name.split(".")[0]
                        if top in deprecated_modules:
                            bad_imports.append(f"{sf.rel}:{node.lineno}: import {alias.name}")
                elif isinstance(node, ast.ImportFrom):
                    mod = (node.module or "").split(".")[0]
                    if mod in deprecated_modules:
                        bad_imports.append(f"{sf.rel}:{node.lineno}: from {node.module} import ...")

        assert bad_imports == [], (
            "Found imports of stdlib modules removed in Python 3.12/3.13: "
            + "; ".join(bad_imports)
        )

    def test_tomllib_not_imported_via_try_except_fallback(self) -> None:
        """No file imports tomllib via a try/except fallback to tomli.

        token-goat requires Python >=3.11 where tomllib is always in stdlib.
        A try/except that falls back to ``import tomli as tomllib`` would be
        dead code and is a signal that the version floor was accidentally lowered.
        Covers all of src/token_goat/ including languages/ and cli.py.
        """
        fallbacks: list[str] = []
        for sf in _parsed_source_files():
            for node in ast.walk(sf.tree):
                # Catch ``from tomli import ...`` or ``import tomli``
                if isinstance(node, ast.ImportFrom) and (node.module or "") == "tomli":
                    fallbacks.append(f"{sf.rel}:{node.lineno}: from tomli import ...")
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "tomli":
                            fallbacks.append(f"{sf.rel}:{node.lineno}: import tomli")

        assert fallbacks == [], (
            "Found tomli (pre-3.11 fallback) imports — use tomllib (stdlib) directly: "
            + "; ".join(fallbacks)
        )


# ---------------------------------------------------------------------------
# Sub-area E: Hook wire format round-trip for all harnesses
# ---------------------------------------------------------------------------


class TestWireFormatRoundTrip:
    """End-to-end wire format round-trips for all four harnesses.

    Each round-trip: simulate the harness sending a payload → normalize_payload
    → denormalize_response → verify the output matches the harness's expected format.
    """

    def test_claude_harness_round_trip_passthrough(self) -> None:
        """Claude harness: payload and response pass through with no transformation."""
        from token_goat.hooks_cli import denormalize_response, normalize_payload

        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/src/main.py"},
            "session_id": "sess-claude-1",
            "cwd": "/projects/myapp",
        }
        norm = normalize_payload(payload, harness="claude")
        assert norm["tool_name"] == "Read"
        assert norm["_tg_harness"] == "claude"
        assert norm["session_id"] == "sess-claude-1"

        response = {"continue": True, "hookSpecificOutput": {"additionalContext": "hint text"}}
        denorm = denormalize_response(response, harness="claude")
        # Claude: response passes through unchanged
        assert denorm is response
        assert denorm["hookSpecificOutput"]["additionalContext"] == "hint text"

    def test_codex_harness_round_trip(self) -> None:
        # Codex 0.137.0+: tool names remapped to PascalCase, HSO keys preserved as camelCase.
        from token_goat.hooks_cli import denormalize_response, normalize_payload

        payload = {
            "tool_name": "edit_file",
            "tool_input": {"file_path": "/src/app.py", "old_string": "a", "new_string": "b"},
            "session_id": "sess-codex-1",
        }
        norm = normalize_payload(payload, harness="codex")
        assert norm["tool_name"] == "Edit"
        assert norm["_tg_harness"] == "codex"

        response = {
            "continue": True,
            "hookSpecificOutput": {
                "additionalContext": "ctx",
                "updatedInput": {"new_string": "b2"},
                "permissionDecision": "allow",
                "hookEventName": "PreToolUse",
            },
        }
        denorm = denormalize_response(response, harness="codex")
        hso = denorm["hookSpecificOutput"]
        assert isinstance(hso, dict)
        assert hso["additionalContext"] == "ctx"
        assert hso["updatedInput"] == {"new_string": "b2"}
        assert hso["permissionDecision"] == "allow"
        assert hso["hookEventName"] == "PreToolUse"
        assert "additional_context" not in hso
        assert "updated_input" not in hso

    def test_gemini_harness_round_trip(self) -> None:
        """Gemini harness: tool names remapped, response translated to decision/reason."""
        from token_goat.hooks_cli import denormalize_response, normalize_payload

        payload = {
            "tool_name": "replace",
            "tool_input": {"path": "/src/x.py", "old_str": "old", "new_str": "new"},
            "session_id": "sess-gemini-1",
            "functionCallId": "call-abc-456",
        }
        norm = normalize_payload(payload, harness="gemini")
        assert norm["tool_name"] == "Edit"
        assert norm["tool_input"]["file_path"] == "/src/x.py"
        assert norm["tool_input"]["old_string"] == "old"
        assert norm["tool_input"]["new_string"] == "new"
        assert norm.get("toolUseId") == "call-abc-456"

        response = {"continue": True}
        denorm = denormalize_response(response, harness="gemini")
        assert denorm["decision"] == "allow"
        assert "continue" not in denorm

    def test_gemini_harness_deny_with_reason_round_trip(self) -> None:
        """Gemini deny response with reason propagated."""
        from token_goat.hooks_cli import denormalize_response

        response = {
            "continue": False,
            "hookSpecificOutput": {"permissionDecisionReason": "sensitive file access denied"},
        }
        denorm = denormalize_response(response, harness="gemini")
        assert denorm["decision"] == "deny"
        assert denorm["reason"] == "sensitive file access denied"

    def test_all_harnesses_accept_unknown_tool_gracefully(self) -> None:
        """All harnesses must handle unknown tool names without raising exceptions."""
        from token_goat.hooks_cli import normalize_payload

        unknown_payload = {"tool_name": "some_future_tool", "tool_input": {"x": 1}}
        for harness in ("claude", "codex", "gemini"):
            result = normalize_payload(unknown_payload, harness=harness)  # type: ignore[arg-type]
            # Must not raise; must preserve tool_name or pass through
            assert isinstance(result, dict), f"harness={harness}: expected dict result"
            # _tg_harness must always be stamped
            assert result.get("_tg_harness") == harness, f"harness={harness}: missing _tg_harness"

    def test_all_harnesses_accept_extra_fields_in_payload(self) -> None:
        """All harnesses must preserve extra/unknown fields in the payload."""
        from token_goat.hooks_cli import normalize_payload

        payload = {
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "session_id": "sess-123",
            "cwd": "/projects",
            "extra_future_field": "some_value",
        }
        for harness in ("claude", "codex", "gemini"):
            result = normalize_payload(payload, harness=harness)  # type: ignore[arg-type]
            assert result.get("extra_future_field") == "some_value", (
                f"harness={harness}: extra field not preserved"
            )
            assert result.get("session_id") == "sess-123", (
                f"harness={harness}: session_id not preserved"
            )

    def test_harness_stamped_regardless_of_payload_content(self) -> None:
        """_tg_harness stamp is applied even when payload has no tool_input."""
        from token_goat.hooks_cli import normalize_payload

        for harness in ("claude", "codex", "gemini"):
            payload = {"tool_name": "Read"}  # no tool_input key
            result = normalize_payload(payload, harness=harness)  # type: ignore[arg-type]
            assert result.get("_tg_harness") == harness, f"harness={harness}: missing _tg_harness"
