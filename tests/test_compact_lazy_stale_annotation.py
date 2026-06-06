"""Tests for stale-compact annotation in lazy skill injection pointer lines (iter 7/10).

When building the manifest in lazy injection mode, the code already reads the
compact text to estimate the token count.  This iteration adds a free staleness
check: extract the source SHA embedded in the compact header and compare it to
the session's recorded content_sha.  If they differ, append '[stale]' to the
pointer line so the post-compact model knows not to trust the cached compact.

Covers:
A. Fresh compact (SHA match) → no [stale] annotation.
B. Stale compact (SHA mismatch) → [stale] annotation present.
C. Compact without a SHA header (old format) → no [stale] annotation (unknown is not stale).
D. No compact at all → bare pointer, no [stale] annotation.
E. [stale] annotation appears inside the parenthesised token count, not as a separate word.
"""
from __future__ import annotations

import re
import unittest.mock

import pytest
from compact_test_helpers import DataDirMixin
from conftest import fire_skill_hook

from token_goat import compact, config
from token_goat.skill_cache import store_compact

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SKILL_BODY = (
    "---\ndescription: Lazy stale annotation test skill.\n---\n\n"
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\n"
    + ("Detail line. " * 400)
)

# A compact body to overwrite the auto-generated one.
_FRESH_COMPACT = (
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\nOverwritten compact for test purposes.\n"
)


def _lazy_config() -> config.Config:
    """Config that forces lazy (recall-only) mode."""
    cfg = config.Config()
    cfg.compact_assist.lazy_skill_injection = True
    cfg.skill_preservation.inline_snippets = False
    return cfg


# ---------------------------------------------------------------------------
# Sub-area A — fresh compact (SHA match) → no [stale] annotation
# ---------------------------------------------------------------------------


class TestFreshCompactNoStaleAnnotation(DataDirMixin):

    def test_fresh_compact_no_stale_flag(self):
        """When the compact's embedded SHA matches the session content_sha, no [stale] appears."""
        from token_goat.skill_cache import (  # noqa: PLC0415
            extract_compact_source_sha,  # type: ignore[attr-defined]
            get_compact,
        )

        sid = "lazy7-fresh-01"
        fire_skill_hook(sid, "freshskill", _SKILL_BODY)

        # Verify the auto-generated compact has a SHA header.
        compact_text = get_compact(sid, "freshskill")
        if compact_text is None:
            pytest.skip("compact not auto-generated — threshold may have changed")
        embedded_sha = extract_compact_source_sha(compact_text)
        if embedded_sha is None:
            pytest.skip("compact was stored without a sha header (old format)")

        # The session's content_sha should match the embedded sha.
        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        # Fresh compact: no stale annotation expected.
        assert "[stale]" not in m, (
            f"fresh compact should not show [stale]; manifest:\n{m[:800]!r}"
        )
        assert "freshskill" in m


# ---------------------------------------------------------------------------
# Sub-area B — stale compact (SHA mismatch) → [stale] annotation present
# ---------------------------------------------------------------------------


class TestStaleCompactAnnotation(DataDirMixin):

    def test_stale_compact_shows_stale_annotation(self):
        """When the compact's embedded SHA differs from the session content_sha, [stale] appears."""
        sid = "lazy7-stale-01"
        fire_skill_hook(sid, "staleskill", _SKILL_BODY)

        # Overwrite the compact with a deliberately mismatched SHA.
        # source_sha="000000000000" won't match the session's real content_sha.
        store_compact(sid, "staleskill", _FRESH_COMPACT, source_sha="000000000000")

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "staleskill" in m, f"staleskill should appear in manifest:\n{m[:800]!r}"
        # The stale annotation should be present since the SHA was forced to mismatch.
        assert "[stale]" in m, (
            f"stale compact should show [stale] annotation; manifest:\n{m[:800]!r}"
        )

    def test_stale_annotation_inside_parens(self):
        """The [stale] annotation appears inside the token count parentheses."""
        sid = "lazy7-stale-02"
        fire_skill_hook(sid, "parencheck", _SKILL_BODY)
        store_compact(sid, "parencheck", _FRESH_COMPACT, source_sha="000000000000")

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        # Should match: "parencheck (N tok [stale])"
        assert re.search(r"parencheck \(\d+ tok \[stale\]\)", m), (
            f"[stale] should be inside the parenthesised token count; manifest:\n{m[:800]!r}"
        )


# ---------------------------------------------------------------------------
# Sub-area C — compact without SHA header → no [stale] annotation
# ---------------------------------------------------------------------------


class TestCompactWithoutShaHeader(DataDirMixin):

    def test_no_stale_when_no_sha_header(self):
        """Compacts written without a SHA header (old format) are not flagged as stale."""
        sid = "lazy7-nosha-01"
        fire_skill_hook(sid, "noshaskill", _SKILL_BODY)

        # Overwrite with a compact that has no sha= in the header.
        # store_compact omits the sha when source_sha is None.
        store_compact(sid, "noshaskill", _FRESH_COMPACT, source_sha=None)

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "noshaskill" in m
        # No SHA to compare against → cannot determine staleness → no [stale] flag.
        assert "[stale]" not in m, (
            f"compact without SHA header should not show [stale]; manifest:\n{m[:800]!r}"
        )


# ---------------------------------------------------------------------------
# Sub-area D — no compact at all → bare pointer, no [stale]
# ---------------------------------------------------------------------------


class TestNoCompactNoBareStale(DataDirMixin):

    def test_bare_pointer_has_no_stale_flag(self):
        """When no compact exists at all, the bare pointer line has no [stale] annotation."""
        from token_goat.skill_cache import _skill_outputs_dir  # noqa: PLC0415

        sid = "lazy7-bare-01"
        fire_skill_hook(sid, "bareskill", _SKILL_BODY)

        # Delete all compact files.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        with unittest.mock.patch("token_goat.compact._load_config", return_value=_lazy_config()):
            m = compact.build_manifest(sid, max_tokens=50_000)

        assert "bareskill" in m
        assert "[stale]" not in m, (
            f"bare pointer (no compact) should have no [stale]; manifest:\n{m[:800]!r}"
        )
