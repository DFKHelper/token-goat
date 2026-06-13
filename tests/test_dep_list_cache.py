from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _make_pre_bash_payload(sid: str, cmd: str, *, cwd: str = "/proj") -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "cwd": cwd,
    }


# ---------------------------------------------------------------------------
# TestIsDepListCommandPositive
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cmd",
    [
        "npm ls",
        "npm list",
        "npm ls --depth=0",
        "npm ls --json",
        "pip list",
        "pip freeze",
        "  pip list  ",
        "uv pip list",
        "uv pip freeze",
        "pnpm list",
        "pnpm ls",
        "yarn list",
        "yarn list --depth=0",
        "cargo tree",
        "bundle list",
        "bundle show",
        "composer show",
    ],
)
def test_is_dep_list_command_positive(cmd: str) -> None:
    from token_goat.bash_cache import is_dep_list_command

    assert is_dep_list_command(cmd), f"expected True for {cmd!r}"


# ---------------------------------------------------------------------------
# TestIsDepListCommandNegative
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cmd",
    [
        "npm install",
        "npm run build",
        "npm ci",
        "pip install flask",
        "pip install -r requirements.txt",
        "yarn add lodash",
        "yarn remove lodash",
        "cargo build",
        "cargo run",
        "git status",
        "ls -la",
    ],
)
def test_is_dep_list_command_negative(cmd: str) -> None:
    from token_goat.bash_cache import is_dep_list_command

    assert not is_dep_list_command(cmd), f"expected False for {cmd!r}"


# ---------------------------------------------------------------------------
# TestDepLockfileFingerprint
# ---------------------------------------------------------------------------


class TestDepLockfileFingerprint:
    def test_npm_lockfile_returns_hex_string(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        lockfile = tmp_path / "package-lock.json"  # type: ignore[operator]
        lockfile.write_text('{"name":"test"}', encoding="utf-8")
        result = dep_lockfile_fingerprint("npm ls", str(tmp_path))
        assert result is not None
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result), f"not hex: {result!r}"

    def test_fingerprint_changes_when_lockfile_changes(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        lockfile = tmp_path / "package-lock.json"  # type: ignore[operator]
        lockfile.write_text('{"name":"test","version":"1.0.0"}', encoding="utf-8")
        fp1 = dep_lockfile_fingerprint("npm ls", str(tmp_path))
        lockfile.write_text('{"name":"test","version":"2.0.0"}', encoding="utf-8")
        fp2 = dep_lockfile_fingerprint("npm ls", str(tmp_path))
        assert fp1 is not None
        assert fp2 is not None
        assert fp1 != fp2

    def test_no_lockfile_returns_none(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        # tmp_path is fresh with no files — no lockfile present
        result = dep_lockfile_fingerprint("npm ls", str(tmp_path))
        assert result is None

    def test_no_cwd_returns_none(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        result = dep_lockfile_fingerprint("npm ls", None)
        assert result is None

    def test_pip_uses_requirements_txt(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        lockfile = tmp_path / "requirements.txt"  # type: ignore[operator]
        lockfile.write_text("flask==3.0.0\nrequests==2.31.0\n", encoding="utf-8")
        result = dep_lockfile_fingerprint("pip list", str(tmp_path))
        assert result is not None
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result)

    def test_unknown_tool_returns_none(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        result = dep_lockfile_fingerprint("ls -la", str(tmp_path))
        assert result is None


# ---------------------------------------------------------------------------
# TestDepListCacheServe
# ---------------------------------------------------------------------------


class TestDepListCacheServe:
    def test_cross_session_serve_returns_advisory(self, tmp_data_dir: object) -> None:
        """Output stored under session A is served as an advisory hint on session B (not a deny)."""
        import token_goat.bash_cache as bc
        from token_goat.hooks_read import _handle_dep_list_serve

        sid_a = "dep-list-sess-a"
        sid_b = "dep-list-sess-b"
        cmd = "npm ls --depth=0"
        cwd = "/proj"
        stdout = "my-app@1.0.0\n└── express@4.18.2\n"

        meta = bc.store_output(sid_a, cmd, stdout, "", 0, cwd=cwd)
        assert meta is not None
        bc.write_sidecar(meta)

        payload = _make_pre_bash_payload(sid_b, cmd, cwd=cwd)
        result = _handle_dep_list_serve(payload)

        assert result is not None, "_handle_dep_list_serve should return a response"
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny", "dep list serve must be advisory, not deny"
        ctx = result.get("additionalContext", "") or hso.get("additionalContext", "")
        assert "express@4.18.2" in ctx, "cached output should appear in additionalContext"

    def test_cache_miss_returns_none(self, tmp_data_dir: object) -> None:
        """When no cached entry exists, _handle_dep_list_serve returns None."""
        from token_goat.hooks_read import _handle_dep_list_serve

        payload = _make_pre_bash_payload("dep-list-miss", "pip list")
        result = _handle_dep_list_serve(payload)
        assert result is None

    def test_non_dep_list_returns_none(self, tmp_data_dir: object) -> None:
        """Non-dep-list commands are not served even if they have cached output."""
        import token_goat.bash_cache as bc
        from token_goat.hooks_read import _handle_dep_list_serve

        sid = "dep-list-non-dep"
        cmd = "npm install"
        cwd = "/proj"
        meta = bc.store_output(sid, cmd, "added 42 packages\n", "", 0, cwd=cwd)
        assert meta is not None
        bc.write_sidecar(meta)

        payload = _make_pre_bash_payload("dep-list-other-sess", cmd, cwd=cwd)
        result = _handle_dep_list_serve(payload)
        assert result is None, "non-dep-list commands must not be served by _handle_dep_list_serve"

    def test_non_bash_tool_returns_none(self, tmp_data_dir: object) -> None:
        """Payloads from non-Bash tools return None safely."""
        from token_goat.hooks_read import _handle_dep_list_serve

        payload = {
            "session_id": "dep-list-read-tool",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/package.json"},
            "cwd": "/proj",
        }
        result = _handle_dep_list_serve(payload)
        assert result is None


# ---------------------------------------------------------------------------
# TestDepListCacheHitStatGroup
# ---------------------------------------------------------------------------


class TestDepListCacheHitStatGroup:
    def test_dep_list_cache_hit_in_bash_group(self) -> None:
        from token_goat.render.stats_renderer import _kind_group_label

        assert _kind_group_label("dep_list_cache_hit") == "Bash"

    def test_uv_prefers_uv_lock_over_requirements_txt(self, tmp_path: object) -> None:
        from token_goat.bash_cache import dep_lockfile_fingerprint

        uv_lock = tmp_path / "uv.lock"  # type: ignore[operator]
        uv_lock.write_text("version = 1\n[[package]]\nname = \"flask\"\n", encoding="utf-8")
        req = tmp_path / "requirements.txt"  # type: ignore[operator]
        req.write_text("flask==3.0.0\n", encoding="utf-8")
        # uv.lock must be preferred — fingerprint must come from it, not requirements.txt
        fp_both = dep_lockfile_fingerprint("uv pip list", str(tmp_path))
        req.unlink()
        fp_uv_only = dep_lockfile_fingerprint("uv pip list", str(tmp_path))
        assert fp_both == fp_uv_only, "uv.lock must be the primary fingerprint source"
