"""Tests for the size-gated large-read / large-grep deny-redirect.

Covers ``hooks_read._handle_large_read_redirect`` and
``hooks_read._handle_large_grep_redirect`` plus the ``hints.large_read_redirect_bytes``
config knob:

- A full Read of a file at/above the threshold is denied and redirected to surgical
  reads; smaller reads pass through.
- A Read that already sets offset/limit is exempt (deliberate windowing; this also
  prevents a redirect loop, since the redirect itself tells the agent to window).
- Binary files and a 0 (disabled) threshold are exempt.
- The threshold defaults to 45000 and is overridable via the
  ``TOKEN_GOAT_LARGE_READ_BYTES`` env var.
- A content-mode Grep over a single oversized file is denied; head_limit, the cheap
  output modes, directory targets, and small files are exempt.

The threshold is exercised by patching ``config.load`` with a Config whose
``hints.large_read_redirect_bytes`` is set, mirroring ``test_serve_diff_on_reread``.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from hook_helpers import assert_deny

from token_goat import config as cfg_mod
from token_goat import hooks_read

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cfg(threshold: int) -> cfg_mod.Config:
    """Return a Config with ``hints.large_read_redirect_bytes`` set to *threshold*."""
    base = cfg_mod.load()
    return replace(base, hints=replace(base.hints, large_read_redirect_bytes=threshold))


def _write(path: Path, n_bytes: int) -> Path:
    """Write exactly *n_bytes* ASCII bytes (write_bytes avoids CRLF size drift)."""
    path.write_bytes(b"A" * n_bytes)
    return path


def _read_payload(path: Path, tmp_path: Path, **extra: object) -> dict:
    ti: dict[str, object] = {"file_path": str(path)}
    ti.update(extra)
    return {"session_id": "lr", "tool_name": "Read", "tool_input": ti, "cwd": str(tmp_path)}


def _grep_payload(tmp_path: Path, **ti: object) -> dict:
    return {"session_id": "lg", "tool_name": "Grep", "tool_input": ti, "cwd": str(tmp_path)}


def _decision(result: dict) -> str | None:
    return (result.get("hookSpecificOutput") or {}).get("permissionDecision")


def _ctx(result: dict) -> str:
    return (result.get("hookSpecificOutput") or {}).get("additionalContext", "")


# ---------------------------------------------------------------------------
# Read guard
# ---------------------------------------------------------------------------


class TestLargeReadRedirect:
    def test_large_read_denied_and_redirects(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "recon_dump.md", 60_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert_deny(result)
        ctx = _ctx(result)
        assert "token-goat skeleton" in ctx
        assert "offset" in ctx and "limit" in ctx
        assert "recon_dump.md" in ctx

    def test_small_read_passes_through(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "small.md", 10_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert _decision(result) != "deny"

    def test_boundary_at_threshold_denies(self, tmp_data_dir, tmp_path):
        """size == threshold denies (>=); size == threshold-1 passes."""
        f = _write(tmp_path / "at.md", 45_000)
        g = _write(tmp_path / "under.md", 44_999)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            assert _decision(hooks_read.pre_read(_read_payload(f, tmp_path))) == "deny"
            assert _decision(hooks_read.pre_read(_read_payload(g, tmp_path))) != "deny"

    def test_windowed_read_with_offset_exempt(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "big.md", 60_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path, offset=1))
        assert _decision(result) != "deny"

    def test_windowed_read_with_limit_exempt(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "big.md", 60_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path, limit=100))
        assert _decision(result) != "deny"

    def test_disabled_when_threshold_zero(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "huge.md", 200_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(0)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert _decision(result) != "deny"

    def test_binary_file_exempt(self, tmp_data_dir, tmp_path):
        """A large binary file is skipped (skeleton/section cannot help there)."""
        f = _write(tmp_path / "blob.bin", 200_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert _decision(result) != "deny"

    def test_missing_file_is_fail_soft(self, tmp_data_dir, tmp_path):
        missing = tmp_path / "nope.md"
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(_read_payload(missing, tmp_path))
        assert _decision(result) != "deny"

    def test_huge_file_denied_via_early_tier(self, tmp_data_dir, tmp_path):
        """A >=10 MB read is hard-denied by the early catastrophic-tier guard.

        Proven with a *sessionless* payload: the early guard runs before the session
        gate, while the normal 45 KB-10 MB fallback sits after it and is unreachable
        here. A deny therefore proves the early ``floor=_LARGE_FILE_HINT_SKIP_BYTES``
        tier fired, independent of the fallback. These files are skipped wholesale by
        the hint pipeline (``_is_binary_or_large_file``) so the early position is the
        only place that can catch them.
        """
        f = _write(tmp_path / "huge.log", 10 * 1024 * 1024 + 1)
        payload = {"tool_name": "Read", "tool_input": {"file_path": str(f)}, "cwd": str(tmp_path)}
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(payload)
        assert_deny(result)

    def test_huge_file_disabled_when_threshold_zero(self, tmp_data_dir, tmp_path):
        """A 0 (disabled) configured threshold disables the early tier too, despite the
        floor — the floor raises the gate, it never overrides the disable switch."""
        f = _write(tmp_path / "huge.log", 10 * 1024 * 1024 + 1)
        payload = {"tool_name": "Read", "tool_input": {"file_path": str(f)}, "cwd": str(tmp_path)}
        with patch.object(cfg_mod, "load", return_value=_cfg(0)):
            result = hooks_read.pre_read(payload)
        assert _decision(result) != "deny"


# ---------------------------------------------------------------------------
# Grep guard
# ---------------------------------------------------------------------------


class TestLargeGrepRedirect:
    def test_content_grep_large_file_denied(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "transcript.jsonl", 80_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(tmp_path, pattern="error|fail", path=str(f), output_mode="content")
            )
        assert_deny(result)
        ctx = _ctx(result)
        assert "transcript.jsonl" in ctx
        assert "head_limit" in ctx

    def test_grep_with_head_limit_exempt(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "transcript.jsonl", 80_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(
                    tmp_path, pattern="error|fail", path=str(f), output_mode="content", head_limit=50
                )
            )
        assert _decision(result) != "deny"

    def test_grep_files_with_matches_exempt(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "transcript.jsonl", 80_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(
                    tmp_path, pattern="error|fail", path=str(f), output_mode="files_with_matches"
                )
            )
        assert _decision(result) != "deny"

    def test_grep_default_output_mode_exempt(self, tmp_data_dir, tmp_path):
        """No output_mode means the cheap files_with_matches default — not gated."""
        f = _write(tmp_path / "transcript.jsonl", 80_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(tmp_path, pattern="error|fail", path=str(f))
            )
        assert _decision(result) != "deny"

    def test_grep_directory_target_exempt(self, tmp_data_dir, tmp_path):
        """A content grep over a directory is a normal repo search — never gated."""
        _write(tmp_path / "transcript.jsonl", 80_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(tmp_path, pattern="error|fail", path=str(tmp_path), output_mode="content")
            )
        assert _decision(result) != "deny"

    def test_grep_small_file_exempt(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "small.jsonl", 10_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            result = hooks_read.pre_read(
                _grep_payload(tmp_path, pattern="error|fail", path=str(f), output_mode="content")
            )
        assert _decision(result) != "deny"


# ---------------------------------------------------------------------------
# Config knob
# ---------------------------------------------------------------------------


class TestPressureScaledThreshold:
    """_pressure_scaled_threshold and _handle_large_read_redirect pressure-tier integration."""

    def test_scaled_threshold_cool_is_base(self):
        from token_goat.hooks_read import _pressure_scaled_threshold
        assert _pressure_scaled_threshold(45_000, "cool") == 45_000

    def test_scaled_threshold_warm_is_lower(self):
        from token_goat.hooks_read import _pressure_scaled_threshold
        assert _pressure_scaled_threshold(45_000, "warm") < 45_000

    def test_scaled_threshold_hot_lower_than_warm(self):
        from token_goat.hooks_read import _pressure_scaled_threshold
        assert _pressure_scaled_threshold(45_000, "hot") < _pressure_scaled_threshold(45_000, "warm")

    def test_scaled_threshold_critical_lowest(self):
        from token_goat.hooks_read import _pressure_scaled_threshold
        assert _pressure_scaled_threshold(45_000, "critical") < _pressure_scaled_threshold(45_000, "hot")
        assert _pressure_scaled_threshold(45_000, "critical") >= 1  # never zero

    def test_unknown_tier_falls_back_to_base(self):
        from token_goat.hooks_read import _pressure_scaled_threshold
        assert _pressure_scaled_threshold(45_000, "future_tier") == 45_000

    def test_warm_tier_denies_file_below_cool_threshold(self, tmp_path):
        """A 32 KB file passes at cool but is denied at warm (warm threshold ≈30 KB)."""
        from token_goat.hooks_read import _handle_large_read_redirect
        f = _write(tmp_path / "medium.md", 32_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="cool") is None
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="warm") is not None

    def test_hot_tier_denies_file_below_warm_threshold(self, tmp_path):
        """A 17 KB file passes at warm but is denied at hot (hot threshold ≈15 KB)."""
        from token_goat.hooks_read import _handle_large_read_redirect
        f = _write(tmp_path / "smallish.md", 17_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="warm") is None
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="hot") is not None

    def test_critical_tier_denies_file_below_hot_threshold(self, tmp_path):
        """A 10 KB file passes at hot but is denied at critical (critical threshold ≈8 KB)."""
        from token_goat.hooks_read import _handle_large_read_redirect
        f = _write(tmp_path / "small.md", 10_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="hot") is None
            assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, tier="critical") is not None

    def test_pressure_scaling_disabled_when_floor_active(self, tmp_path):
        """The catastrophic early call (floor=10MB) is never tier-scaled — tier must not change its gate."""
        from token_goat.hooks_read import _LARGE_FILE_HINT_SKIP_BYTES, _handle_large_read_redirect
        f = _write(tmp_path / "big.md", 32_000)
        with patch.object(cfg_mod, "load", return_value=_cfg(45_000)):
            # 32 KB is below the 10 MB floor — should NOT deny at any tier when floor is active.
            for tier in ("cool", "warm", "hot", "critical"):
                assert _handle_large_read_redirect(str(f), {"file_path": str(f)}, floor=_LARGE_FILE_HINT_SKIP_BYTES, tier=tier) is None


class TestLargeReadConfig:
    def test_default_threshold_is_45000(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_LARGE_READ_BYTES", raising=False)
        assert cfg_mod.load().hints.large_read_redirect_bytes == 45_000

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("TOKEN_GOAT_LARGE_READ_BYTES", "10000")
        assert cfg_mod.load().hints.large_read_redirect_bytes == 10_000

    def test_env_disable(self, monkeypatch):
        monkeypatch.setenv("TOKEN_GOAT_LARGE_READ_BYTES", "0")
        assert cfg_mod.load().hints.large_read_redirect_bytes == 0
