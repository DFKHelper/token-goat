"""Tests for lazy-injection cross-session compact fallback (iter 3/10).

When a skill was compacted in a previous session, the manifest should show
the token estimate from the cross-session compact rather than a bare recall
pointer with no size hint.  Also verifies that the token count is computed
from the stripped compact body (excluding the header line).

Covers:
A. Current-session compact found → token estimate displayed.
B. No compact stored yet → bare recall pointer (no token count).
C. Cross-session compact present → fallback token estimate shown.
D. Token estimate uses stripped body (header excluded).
"""
from __future__ import annotations

import re
import unittest.mock

from compact_test_helpers import DataDirMixin
from conftest import fire_skill_hook

from token_goat import compact, config, skill_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# A skill body that exceeds the compact-threshold (4 000 bytes) so hooks_skill
# will automatically store a compact when the skill is loaded.
_SKILL_BODY = (
    "---\ndescription: A testing skill.\n---\n\n"
    "## Key Rules\n\n"
    "CRITICAL: never skip.\n"
    "MUST: run tests.\n\n"
    "## Details\n\n"
    + ("Detail line. " * 400)  # ~5 200 chars — well above 4 000-byte threshold
)


def _lazy_config() -> config.Config:
    """Config that forces lazy (recall-only) mode regardless of inline_snippets default."""
    cfg = config.Config()
    cfg.compact_assist.lazy_skill_injection = True
    cfg.skill_preservation.inline_snippets = False  # override inline_snippets=True default
    return cfg


# ---------------------------------------------------------------------------
# Sub-area A — current-session compact found → token estimate shown
# ---------------------------------------------------------------------------


class TestCurrentSessionCompact(DataDirMixin):
    """When a compact exists for the current session, lazy pointer shows its size."""


    def test_token_estimate_shown_when_compact_stored(self):
        """After skill loads in session, manifest shows token count on the lazy pointer."""
        sid = "lazy-a-current"
        fire_skill_hook(sid, "testskill", _SKILL_BODY)

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "testskill" in m
        assert re.search(r"testskill \(\d+ tok\)", m), (
            "lazy pointer should show token count when compact is stored; "
            f"manifest snippet: {m[:600]!r}"
        )

    def test_recall_command_present(self):
        """Lazy pointer always includes the recall command."""
        sid = "lazy-a-recall"
        fire_skill_hook(sid, "testskill", _SKILL_BODY)

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "skill-body testskill --compact" in m


# ---------------------------------------------------------------------------
# Sub-area B — no compact stored → bare pointer
# ---------------------------------------------------------------------------


class TestBarePointerNoCompact(DataDirMixin):
    """When no compact exists anywhere, lazy pointer has no token count."""


    def test_bare_pointer_when_no_compact(self):
        """If get_compact returns None and no cross-session compact exists either,
        output must be a bare recall pointer without a token count."""
        sid = "lazy-b-bare"
        # Load the skill so it appears in the session, but don't let a compact
        # be stored by mocking get_compact_any_session to return None.
        fire_skill_hook(sid, "myskill", _SKILL_BODY)

        # Forcibly delete the compact so neither session lookup finds anything.
        out_dir = skill_cache._skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "myskill" in m
        # No parenthesised token count on the myskill line.
        assert not re.search(r"myskill \(\d+ tok\)", m), (
            "bare pointer should not show token count when no compact exists; "
            f"manifest snippet: {m[:600]!r}"
        )
        assert "skill-body myskill --compact" in m


# ---------------------------------------------------------------------------
# Sub-area C — cross-session fallback
# ---------------------------------------------------------------------------


class TestCrossSessionFallback(DataDirMixin):
    """A compact stored in session A is found by session B's lazy injection."""


    def test_cross_session_compact_provides_token_estimate(self):
        """Compact generated in session A should show a token count in session B manifest."""
        sid_a = "lazy-c-session-a"
        sid_b = "lazy-c-session-b"

        # Load in session A to generate the compact.
        fire_skill_hook(sid_a, "crossskill", _SKILL_BODY)

        # Verify compact is stored for session A.
        compact_a = skill_cache.get_compact(sid_a, "crossskill")
        assert compact_a is not None, "compact should be stored after skill hook fires"

        # In session B, load the same skill (body only — compact not yet generated
        # for this session).
        fire_skill_hook(sid_b, "crossskill", _SKILL_BODY)

        # Delete the session-B compact so the current-session lookup misses,
        # forcing the cross-session fallback.
        from token_goat.skill_cache import _compact_file_id, _skill_outputs_dir  # noqa: PLC0415
        sid_b_compact_id = _compact_file_id(sid_b, "crossskill")
        compact_b_path = _skill_outputs_dir() / sid_b_compact_id
        if compact_b_path.exists():
            compact_b_path.unlink()

        # Session B manifest should still show a token count via cross-session fallback.
        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid_b, max_tokens=50_000)

        assert "crossskill" in m
        assert re.search(r"crossskill \(\d+ tok\)", m), (
            "cross-session fallback should provide token count even when session-B compact deleted; "
            f"manifest snippet: {m[:600]!r}"
        )


# ---------------------------------------------------------------------------
# Sub-area D — token estimate uses stripped body
# ---------------------------------------------------------------------------


class TestTokenEstimateStripsHeader(DataDirMixin):
    """Token count in the manifest reflects the stripped compact, not header+content."""


    def test_token_count_matches_stripped_body_length(self):
        """The token count shown in the lazy pointer == len(stripped_compact) // 4."""
        sid = "lazy-d-strip"
        fire_skill_hook(sid, "stripskill", _SKILL_BODY)

        stored = skill_cache.get_compact(sid, "stripskill")
        assert stored is not None

        stripped = skill_cache._strip_compact_header(stored)  # type: ignore[attr-defined]
        expected_tokens = max(1, len(stripped) // 4)

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert f"stripskill ({expected_tokens} tok)" in m, (
            f"token count should be {expected_tokens} based on stripped body len {len(stripped)}; "
            f"manifest snippet: {m[:600]!r}"
        )
