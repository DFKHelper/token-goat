"""Tests for the process-local directory listing cache in skill_cache (iter 8/10).

When the pre-compact manifest performs lazy skill injection, it calls
get_compact_any_session() once per loaded skill.  Previously each call ran an
independent out_dir.glob() OS syscall.  This iteration adds a short-TTL
(5-second) in-process directory listing cache so that multiple skill lookups
within a single manifest render share one iterdir() scan.

Covers:
A. _get_skills_dir_listing returns the correct files.
B. _get_skills_dir_listing reuses a cached listing within the TTL window.
C. _get_skills_dir_listing refreshes the listing after the TTL expires.
D. get_compact_any_session still returns correct compacts when using the cache.
E. Cache miss (expired TTL) triggers a fresh scan that finds newly-written files.
F. Fail-soft: _get_skills_dir_listing returns [] on I/O error.
"""
from __future__ import annotations

import time
import unittest.mock

import pytest

from token_goat.skill_cache import (
    _DIR_LISTING_CACHE_TTL_SECS,
    _get_skills_dir_listing,
    _skill_outputs_dir,
    get_compact_any_session,
    store_compact,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REAL_COMPACT = (
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\nSome longer content that makes this meaningful.\n"
)


def _reset_dir_cache() -> None:
    """Forcibly expire the directory listing cache by resetting the module-level state."""
    import token_goat.skill_cache as sc  # noqa: PLC0415
    sc._dir_listing_cache = None


# ---------------------------------------------------------------------------
# Sub-area A — _get_skills_dir_listing returns correct files
# ---------------------------------------------------------------------------






class DirListingMixin:
    """Mixin providing data-dir isolation + dir-listing cache reset for test classes."""

    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):  # noqa: PT004
        self.tmp_data_dir = tmp_data_dir
        _reset_dir_cache()


class TestDirListingBasic(DirListingMixin):

    def test_returns_existing_compact_file(self):
        """_get_skills_dir_listing includes a compact file that was just written."""
        store_compact("dl01", "skillA", _REAL_COMPACT)
        out_dir = _skill_outputs_dir()
        listing = _get_skills_dir_listing(out_dir)
        names = {p.name for p in listing}
        compact_files = [n for n in names if n.endswith("-compact")]
        assert compact_files, "listing should include at least one compact file"

    def test_returns_empty_for_empty_dir(self):
        """_get_skills_dir_listing returns [] for an empty directory (modulo pre-existing files)."""
        out_dir = _skill_outputs_dir()
        # Just ensure it returns a list without raising.
        listing = _get_skills_dir_listing(out_dir)
        assert isinstance(listing, list)


# ---------------------------------------------------------------------------
# Sub-area B — listing is cached within the TTL window
# ---------------------------------------------------------------------------


class TestDirListingCacheHit(DirListingMixin):

    def test_second_call_returns_same_list_object(self):
        """Two rapid calls to _get_skills_dir_listing return the same list instance."""
        out_dir = _skill_outputs_dir()
        listing1 = _get_skills_dir_listing(out_dir)
        listing2 = _get_skills_dir_listing(out_dir)
        assert listing1 is listing2, (
            "second call within TTL should return the same cached list object"
        )

    def test_iterdir_called_only_once_for_rapid_calls(self):
        """The underlying iterdir() is called only once for two rapid calls within TTL."""
        out_dir = _skill_outputs_dir()
        _reset_dir_cache()

        # WindowsPath.iterdir is a read-only slot — patch at the class level instead of
        # on the instance, which is the only way to intercept it on CPython/Windows.
        call_count = 0
        real_iterdir = out_dir.__class__.iterdir

        def counting_iterdir(self):
            nonlocal call_count
            call_count += 1
            return real_iterdir(self)

        with unittest.mock.patch.object(out_dir.__class__, "iterdir", counting_iterdir):
            _get_skills_dir_listing(out_dir)
            _get_skills_dir_listing(out_dir)
            _get_skills_dir_listing(out_dir)

        assert call_count == 1, (
            f"iterdir() should be called only once for 3 rapid calls; got {call_count}"
        )


# ---------------------------------------------------------------------------
# Sub-area C — listing refreshes after TTL expires
# ---------------------------------------------------------------------------


class TestDirListingCacheExpiry(DirListingMixin):

    def test_cache_refreshes_after_ttl(self):
        """After simulating TTL expiry, the next call to _get_skills_dir_listing re-scans."""
        import token_goat.skill_cache as sc  # noqa: PLC0415

        out_dir = _skill_outputs_dir()
        listing1 = _get_skills_dir_listing(out_dir)

        # Force the cached timestamp to be older than the TTL.
        old_ts = time.time() - _DIR_LISTING_CACHE_TTL_SECS - 1.0
        sc._dir_listing_cache = (old_ts, listing1)

        # Next call should re-scan.
        listing2 = _get_skills_dir_listing(out_dir)
        # It should be a new list object (fresh scan), not the cached one.
        assert listing2 is not listing1, (
            "after TTL expiry, _get_skills_dir_listing should return a fresh list"
        )

    def test_new_file_visible_after_ttl(self):
        """A compact written after cache fill is visible after the TTL expires."""
        import token_goat.skill_cache as sc  # noqa: PLC0415

        store_compact("dl-ttl01", "beforeskill", _REAL_COMPACT)
        out_dir = _skill_outputs_dir()
        _get_skills_dir_listing(out_dir)  # populate cache

        # Write another compact.
        store_compact("dl-ttl02", "afterskill", _REAL_COMPACT)

        # Expire the cache.
        sc._dir_listing_cache = None

        # Fresh scan should include the new file.
        listing2 = _get_skills_dir_listing(out_dir)
        names = {p.name for p in listing2}
        after_compact = [n for n in names if "afterskill" in n and n.endswith("-compact")]
        assert after_compact, "new compact file should be visible after TTL expires"


# ---------------------------------------------------------------------------
# Sub-area D — get_compact_any_session still works correctly
# ---------------------------------------------------------------------------


class TestGetCompactAnySessionWithCache(DirListingMixin):

    def test_returns_compact_for_any_session(self):
        """get_compact_any_session finds a compact regardless of session mismatch."""
        store_compact("dl-any01", "findme", _REAL_COMPACT)
        _reset_dir_cache()  # ensure fresh scan
        result = get_compact_any_session("findme")
        assert result is not None, "should find compact across sessions"
        assert "Rules" in result

    def test_multiple_skills_same_scan(self):
        """Multiple get_compact_any_session calls for different skills use one directory scan."""
        store_compact("dl-multi01", "skillX", _REAL_COMPACT)
        store_compact("dl-multi01", "skillY", _REAL_COMPACT)

        out_dir = _skill_outputs_dir()
        # WindowsPath.iterdir is a read-only slot — must patch at the class level.
        real_iterdir = out_dir.__class__.iterdir
        iterdir_count = 0

        def counting_iterdir_cls(self):
            nonlocal iterdir_count
            iterdir_count += 1
            return real_iterdir(self)

        with unittest.mock.patch.object(out_dir.__class__, "iterdir", counting_iterdir_cls):
            _reset_dir_cache()
            get_compact_any_session("skillX")
            get_compact_any_session("skillY")
            get_compact_any_session("skillX")  # third call, still within TTL

        assert iterdir_count == 1, (
            f"3 get_compact_any_session calls should trigger 1 iterdir; got {iterdir_count}"
        )


# ---------------------------------------------------------------------------
# Sub-area F — fail-soft on I/O error
# ---------------------------------------------------------------------------


class TestDirListingFailSoft(DirListingMixin):

    def test_returns_empty_list_on_oserror(self):
        """_get_skills_dir_listing returns [] when iterdir raises OSError."""
        out_dir = _skill_outputs_dir()

        # WindowsPath.iterdir is a read-only slot — patch at the class level.
        def exploding_iterdir(self):
            raise OSError("no disk")

        with unittest.mock.patch.object(out_dir.__class__, "iterdir", exploding_iterdir):
            _reset_dir_cache()
            listing = _get_skills_dir_listing(out_dir)

        assert listing == [], "should return empty list on I/O error (fail-soft)"
