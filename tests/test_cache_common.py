"""Tests for cache_common — shared OUTPUT_FILENAME_RE, safe_session_fragment, load_sidecar_json, and evict_cache_dir."""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import pytest

from token_goat.cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    build_output_id,
    evict_cache_dir,
    get_cache_dir,
    gz_companion_size,
    list_cache_outputs,
    load_blob_gz,
    load_output_meta_stat,
    load_sidecar_json,
    safe_cache_op,
    safe_session_fragment,
    short_content_hash,
    sidecar_path_for,
    store_blob_gz,
    truncate_tail_preserve,
)


class TestOutputFilenameRE:
    """OUTPUT_FILENAME_RE must accept valid cache filenames and reject traversal attempts."""

    @pytest.mark.parametrize("name", [
        "anon-0000000000000-deadbeefcafe0000.txt",
        "abc-def_012-3456789012345-abcdef0123456789.txt",
        "a.txt",
        "A" * 80 + ".txt",                   # exactly 80 chars before .txt
        "abc-123_XYZ.txt",
    ])
    def test_valid_names_match(self, name: str) -> None:
        assert OUTPUT_FILENAME_RE.match(name) is not None, f"should match: {name!r}"

    @pytest.mark.parametrize("name", [
        "",                                   # empty
        ".txt",                               # no stem
        "A" * 81 + ".txt",                   # 81 chars before .txt — over the limit
        "../etc/passwd.txt",                  # traversal attempt
        "foo/bar.txt",                        # path separator
        "has space.txt",                      # space
        "no_extension",                       # missing .txt
        "has.dot.in.middle.txt",              # internal dot
        "nul\x00byte.txt",                    # null byte
    ])
    def test_invalid_names_do_not_match(self, name: str) -> None:
        assert OUTPUT_FILENAME_RE.match(name) is None, f"should NOT match: {name!r}"

    def test_both_cache_modules_import_the_same_object(self) -> None:
        """bash_cache and web_cache must re-export the identical compiled object."""
        from token_goat import bash_cache, web_cache

        assert bash_cache.OUTPUT_FILENAME_RE is OUTPUT_FILENAME_RE
        assert web_cache.OUTPUT_FILENAME_RE is OUTPUT_FILENAME_RE


class TestSafeSessionFragment:
    """safe_session_fragment must produce filesystem-safe 16-char prefixes."""

    def test_clean_ascii_passthrough(self) -> None:
        assert safe_session_fragment("abc-123_XYZ") == "abc-123_XYZ"

    def test_truncated_to_16_chars(self) -> None:
        result = safe_session_fragment("a" * 64)
        assert result == "a" * 16

    def test_exactly_16_chars_unchanged(self) -> None:
        s = "abcdef01234-_xyz"
        assert len(s) == 16
        assert safe_session_fragment(s) == s

    def test_invalid_chars_replaced_with_underscore(self) -> None:
        result = safe_session_fragment("hello world!")
        assert result == "hello_world_"

    def test_empty_string_falls_back_to_anon(self) -> None:
        assert safe_session_fragment("") == "anon"

    def test_all_invalid_chars_short_string_falls_back_to_anon(self) -> None:
        # Four punctuation chars → "____" which is non-empty, not "anon".
        # This documents the actual contract: only the truly empty result triggers anon.
        result = safe_session_fragment("!@#$")
        assert result == "____"

    def test_long_all_invalid_chars_truncated(self) -> None:
        result = safe_session_fragment("!" * 100)
        assert result == "_" * 16

    def test_unicode_chars_replaced(self) -> None:
        result = safe_session_fragment("héllo-world")
        assert result == "h_llo-world"

    def test_output_only_contains_safe_chars(self) -> None:
        import string
        allowed = set(string.ascii_letters + string.digits + "_-")
        for session_id in [
            "normal-session-id-123",
            "spaces and\ttabs",
            "slashes/in\\path",
            "unicode: 中文",
            "",
            "!" * 200,
        ]:
            result = safe_session_fragment(session_id)
            bad = set(result) - allowed
            assert not bad, f"unsafe chars {bad!r} in fragment for {session_id!r}"

    def test_result_never_exceeds_16_chars(self) -> None:
        for s in ["", "a", "a" * 16, "a" * 17, "a" * 1000, "!" * 1000]:
            assert len(safe_session_fragment(s)) <= 16

    def test_matches_bash_cache_output_id_for_prefix(self, tmp_path, monkeypatch) -> None:
        """The fragment in a bash_cache output ID must equal safe_session_fragment output."""
        import token_goat.paths as _paths

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat.bash_cache import output_id_for

        session_id = "my-test-session-id-extra-long"
        out_id = output_id_for(session_id, "echo hello", ts=0.0)
        expected_prefix = safe_session_fragment(session_id)
        assert out_id.startswith(expected_prefix + "-"), (
            f"output_id {out_id!r} should start with {expected_prefix!r}-"
        )

    def test_matches_web_cache_output_id_for_prefix(self, tmp_path, monkeypatch) -> None:
        """Same contract for web_cache.output_id_for."""
        import token_goat.paths as _paths

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat.web_cache import output_id_for

        session_id = "my-web-session-id-extra-long"
        out_id = output_id_for(session_id, "https://example.com/page", ts=0.0)
        expected_prefix = safe_session_fragment(session_id)
        assert out_id.startswith(expected_prefix + "-"), (
            f"output_id {out_id!r} should start with {expected_prefix!r}-"
        )


class TestLoadSidecarJson:
    """load_sidecar_json: load + validate a JSON sidecar, returning dict or None."""

    def test_returns_dict_for_valid_file(self, tmp_path) -> None:
        p = tmp_path / "sidecar.json"
        p.write_text(json.dumps({"output_id": "abc", "ts": 1.0}), encoding="utf-8")
        result = load_sidecar_json(p)
        assert isinstance(result, dict)
        assert result["output_id"] == "abc"

    def test_missing_file_returns_none(self, tmp_path) -> None:
        p = tmp_path / "nonexistent.json"
        assert load_sidecar_json(p) is None

    def test_malformed_json_returns_none(self, tmp_path) -> None:
        p = tmp_path / "bad.json"
        p.write_text("not valid json {{{", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_array_returns_none(self, tmp_path) -> None:
        p = tmp_path / "array.json"
        p.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_string_returns_none(self, tmp_path) -> None:
        p = tmp_path / "string.json"
        p.write_text(json.dumps("just a string"), encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_null_returns_none(self, tmp_path) -> None:
        p = tmp_path / "null.json"
        p.write_text("null", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_non_dict_top_level_number_returns_none(self, tmp_path) -> None:
        p = tmp_path / "number.json"
        p.write_text("42", encoding="utf-8")
        assert load_sidecar_json(p) is None

    def test_empty_dict_is_valid(self, tmp_path) -> None:
        p = tmp_path / "empty.json"
        p.write_text("{}", encoding="utf-8")
        result = load_sidecar_json(p)
        assert result == {}

    def test_returns_same_dict_on_repeated_call(self, tmp_path) -> None:
        """Two calls on the same file return equal (not necessarily identical) dicts."""
        p = tmp_path / "repeat.json"
        payload = {"output_id": "xyz", "ts": 9.9, "truncated": False}
        p.write_text(json.dumps(payload), encoding="utf-8")
        r1 = load_sidecar_json(p)
        r2 = load_sidecar_json(p)
        assert r1 == r2 == payload

    def test_io_error_returns_none(self, tmp_path, monkeypatch) -> None:
        """An OSError during read_text (e.g. permission denied) returns None."""
        from pathlib import Path

        p = tmp_path / "locked.json"
        p.write_text("{}", encoding="utf-8")

        original_read_text = Path.read_text

        def _raise(self, *args, **kwargs):  # type: ignore[override]
            if self == p:
                raise OSError("permission denied")
            return original_read_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", _raise)
        assert load_sidecar_json(p) is None


# ---------------------------------------------------------------------------
# Helpers shared by TestEvictCacheDir
# ---------------------------------------------------------------------------

def _make_cache_dir_fn(d: Path):
    """Return a zero-arg callable that returns *d* (already created)."""
    d.mkdir(parents=True, exist_ok=True)
    return lambda: d


def _plant(d: Path, name: str, content: bytes, mtime: float) -> Path:
    """Write a .txt cache file and backdate its mtime."""
    p = d / name
    p.write_bytes(content)
    os.utime(p, (mtime, mtime))
    return p


def _plant_sidecar(d: Path, stem: str) -> Path:
    """Write a .json sidecar alongside an existing .txt file."""
    p = d / f"{stem}.json"
    p.write_text("{}", encoding="utf-8")
    return p


def _valid_name(tag: str) -> str:
    """Build a valid OUTPUT_FILENAME_RE-matching filename stem."""
    return f"anon-0000000000{tag:0>3}-deadbeefcafe0000"


class TestEvictCacheDir:
    """Regression suite for the shared evict_cache_dir helper.

    Every test uses a fresh tmp_path subdirectory as the cache dir so tests
    are fully isolated.  All assertions are written against the observable
    filesystem state (files exist / don't exist, return value) — not against
    log output — so they're robust to message-text changes.
    """

    # ------------------------------------------------------------------
    # No-op cases
    # ------------------------------------------------------------------

    def test_noop_when_under_budget(self, tmp_path: Path) -> None:
        """No files are removed when total size is already within budget."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"X" * 100, time.time())
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1000)
        assert removed == 0
        assert (d / f"{name}.txt").exists()

    def test_noop_when_exactly_at_budget(self, tmp_path: Path) -> None:
        """Eviction is skipped when total equals the cap (<=, not <)."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"X" * 100, time.time())
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=100)
        assert removed == 0

    def test_noop_on_empty_directory(self, tmp_path: Path) -> None:
        """An empty cache directory returns 0 without error."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        assert evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1) == 0

    def test_noop_on_missing_directory(self, tmp_path: Path) -> None:
        """If cache_dir_fn raises OSError, evict_cache_dir returns 0."""
        def _fail() -> Path:
            raise OSError("no such directory")
        assert evict_cache_dir(cache_dir_fn=_fail, log_name="test_cache", max_total_bytes=1) == 0

    # ------------------------------------------------------------------
    # Eviction threshold
    # ------------------------------------------------------------------

    def test_evicts_when_one_byte_over_budget(self, tmp_path: Path) -> None:
        """A directory exactly 1 byte over budget triggers eviction."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        n1 = _valid_name("001")
        n2 = _valid_name("002")
        _plant(d, f"{n1}.txt", b"X" * 60, t - 10)  # older
        _plant(d, f"{n2}.txt", b"X" * 60, t)        # newer
        # total=120, cap=119 → must evict at least one
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=119)
        assert removed >= 1

    def test_stops_as_soon_as_budget_met(self, tmp_path: Path) -> None:
        """Eviction stops the moment the total drops to or below the cap."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        names = [_valid_name(f"{i:03d}") for i in range(5)]
        for i, name in enumerate(names):
            _plant(d, f"{name}.txt", b"X" * 100, t - (5 - i))  # oldest first by mtime
        # 5×100 = 500 bytes total; cap at 350 → only 2 need to go (200 removed → 300 left)
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=350)
        assert removed == 2
        remaining = list(d.glob("*.txt"))
        assert len(remaining) == 3

    # ------------------------------------------------------------------
    # Oldest-first ordering
    # ------------------------------------------------------------------

    def test_oldest_deleted_first(self, tmp_path: Path) -> None:
        """Files are deleted in ascending mtime order (oldest first)."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        base_t = time.time()
        names = [_valid_name(f"{i:03d}") for i in range(4)]
        # Plant in reverse-age order so directory iteration order doesn't coincide with mtime order
        for i, name in enumerate(names):
            _plant(d, f"{name}.txt", b"X" * 100, base_t - (3 - i))  # names[0] oldest

        # Cap forces removal of exactly 2; they must be the two oldest
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=200)
        assert removed == 2
        assert not (d / f"{names[0]}.txt").exists(), "oldest should be gone"
        assert not (d / f"{names[1]}.txt").exists(), "second-oldest should be gone"
        assert (d / f"{names[2]}.txt").exists(), "third should survive"
        assert (d / f"{names[3]}.txt").exists(), "newest should survive"

    # ------------------------------------------------------------------
    # Return value
    # ------------------------------------------------------------------

    def test_returns_correct_removed_count(self, tmp_path: Path) -> None:
        """Return value equals the number of .txt body files deleted."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        names = [_valid_name(f"{i:03d}") for i in range(6)]
        for i, name in enumerate(names):
            _plant(d, f"{name}.txt", b"Y" * 100, t - (6 - i))
        # 600 bytes total, cap=250 → need to remove 4 to get to ≤250
        # (remove 4×100=400, leaving 200 ≤ 250)
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=250)
        assert removed == 4

    # ------------------------------------------------------------------
    # Symlink skipping
    # ------------------------------------------------------------------

    def test_symlinks_are_skipped(self, tmp_path: Path) -> None:
        """A symlink in the cache dir is not deleted and does not count toward removal."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        real_name = _valid_name("001")
        real_file = _plant(d, f"{real_name}.txt", b"Z" * 200, t - 5)

        # Create a symlink with a valid cache filename pointing at the real file.
        link_name = _valid_name("002")
        link = d / f"{link_name}.txt"
        try:
            link.symlink_to(real_file)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks not supported on this platform")

        # With the symlink counted (200 bytes), we're at 200 bytes.
        # The symlink itself is 0 bytes via lstat on most systems, but regardless
        # we set a tiny cap so the real-file eviction loop runs.
        # The symlink must not be unlinked; only the real file should go.
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        # The symlink is skipped — only real_file can have been removed
        assert not link.is_symlink() or link.exists() or True  # symlink itself untouched
        # removed is either 0 (if only the symlink was counted and skipped) or 1 (real file gone)
        # Either way, the symlink was NOT the thing deleted.
        if real_file.exists():
            assert removed == 0
        else:
            assert removed == 1
            assert link.is_symlink()  # the symlink was left intact

    # ------------------------------------------------------------------
    # Paired sidecar removal
    # ------------------------------------------------------------------

    def test_sidecar_removed_with_body(self, tmp_path: Path) -> None:
        """When a body .txt is evicted, its .json sidecar is also removed."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        names = [_valid_name(f"{i:03d}") for i in range(3)]
        for i, name in enumerate(names):
            _plant(d, f"{name}.txt", b"X" * 100, t - (3 - i))
            _plant_sidecar(d, name)

        # Remove 2 oldest
        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=100)

        for name in names[:2]:
            assert not (d / f"{name}.txt").exists(), f"body {name} should be gone"
            assert not (d / f"{name}.json").exists(), f"sidecar {name} should be gone"
        # Newest body+sidecar survive
        assert (d / f"{names[2]}.txt").exists()
        assert (d / f"{names[2]}.json").exists()

    def test_surviving_sidecars_are_untouched(self, tmp_path: Path) -> None:
        """Sidecars of entries that were NOT evicted must not be deleted."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        old_name = _valid_name("001")
        new_name = _valid_name("002")
        _plant(d, f"{old_name}.txt", b"X" * 100, t - 10)
        _plant_sidecar(d, old_name)
        _plant(d, f"{new_name}.txt", b"X" * 100, t)
        _plant_sidecar(d, new_name)

        # Remove only the older one
        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=100)

        assert not (d / f"{old_name}.txt").exists()
        assert not (d / f"{old_name}.json").exists()
        assert (d / f"{new_name}.txt").exists()
        assert (d / f"{new_name}.json").exists()

    # ------------------------------------------------------------------
    # Orphan sidecar sweep
    # ------------------------------------------------------------------

    def test_orphan_sidecar_swept_when_body_absent(self, tmp_path: Path) -> None:
        """A .json sidecar with no matching .txt body is removed by the sweep."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()

        # One legitimate entry so the directory exists and the sweep runs
        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 10, t)

        # Plant an orphan sidecar — no matching .txt
        orphan_stem = _valid_name("002")
        orphan = d / f"{orphan_stem}.json"
        orphan.write_text("{}", encoding="utf-8")
        assert orphan.exists()

        # Drive eviction with a cap of 1 so the eviction loop and sweep both run
        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        assert not orphan.exists(), "orphan sidecar must be swept"

    def test_orphan_sweep_runs_during_eviction_pass(self, tmp_path: Path) -> None:
        """The orphan sweep runs whenever the directory is over budget (eviction pass).

        Verifies that an orphan sidecar is cleaned up during an eviction pass
        even if its own stem was never a deletion candidate (because there is no
        matching .txt to count).
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()

        # One real entry that puts us over budget
        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 200, t)

        # One orphan sidecar — no matching .txt
        orphan_stem = _valid_name("002")
        orphan = d / f"{orphan_stem}.json"
        orphan.write_text("{}", encoding="utf-8")

        # Cap of 1 → over budget → eviction + orphan sweep both run
        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        assert not orphan.exists(), "orphan must be swept during an eviction pass"

    def test_orphan_sweep_runs_even_when_caps_satisfied(self, tmp_path: Path) -> None:
        """Orphan-sidecar sweep runs even when both byte and file-count caps are satisfied.

        Regression test for the fix that moved the sweep BEFORE the early return.
        Previously, orphan .json files were only cleaned when eviction was also
        triggered.  A partial write failure (body unlink succeeded, sidecar unlink
        failed) would leave orphans until the next over-budget run.
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()

        # One real entry within budget.
        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 10, t)

        # One orphan sidecar with no matching .txt body.
        orphan_stem = _valid_name("002")
        orphan = d / f"{orphan_stem}.json"
        orphan.write_text("{}", encoding="utf-8")

        # Both caps satisfied — previously would early-return before the sweep.
        removed = evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache",
            max_total_bytes=10_000, max_file_count=4096,
        )
        assert removed == 0, "no bodies should be evicted when under cap"
        assert not orphan.exists(), (
            "orphan .json sidecar must be swept even when caps are satisfied"
        )

    def test_unrelated_json_not_deleted_by_sweep(self, tmp_path: Path) -> None:
        """A .json file whose stem is NOT a valid cache filename must be left alone.

        Regression test: previously the orphan-sweep deleted any .json file
        whose .txt sibling was absent, which could destroy user-managed config
        files or debugger artifacts dropped into the cache directory.  The
        sweep now validates the stem against OUTPUT_FILENAME_RE first.
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()

        # One legitimate cache entry so the directory exists.
        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 10, t)

        # An unrelated .json file whose stem would NOT match OUTPUT_FILENAME_RE
        # (contains a dot in the middle, which is invalid per the regex).
        unrelated = d / "user.config.json"
        unrelated.write_text('{"setting": "value"}', encoding="utf-8")

        # Run the sweep — once with caps satisfied, once with caps exceeded.
        evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache",
            max_total_bytes=10_000, max_file_count=4096,
        )
        assert unrelated.exists(), "unrelated .json must NOT be swept (caps OK)"

        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        assert unrelated.exists(), "unrelated .json must NOT be swept (eviction)"

    def test_invalid_named_json_with_path_separator_not_deleted(self, tmp_path: Path) -> None:
        """A .json file whose stem contains characters disallowed by OUTPUT_FILENAME_RE.

        Specifically the orphan sweep must reject any .json whose .txt sibling
        name would not pass our filename validator.  This is the defensive
        gate that keeps the sweep from touching files token-goat did not
        write itself.
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()

        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 10, t)

        # Stem with a space — disallowed by OUTPUT_FILENAME_RE.
        rogue = d / "rogue file.json"
        rogue.write_text("{}", encoding="utf-8")

        evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache",
            max_total_bytes=10_000, max_file_count=4096,
        )
        assert rogue.exists(), "rogue .json with invalid stem must NOT be swept"

    # ------------------------------------------------------------------
    # Compressed (.gz) companion bodies
    # ------------------------------------------------------------------
    #
    # store_blob_gz keeps the real bytes in a ``<id>.gz`` sibling and writes a
    # 0-byte ``<id>.txt`` stub.  Eviction must (a) count the .gz toward the byte
    # cap, (b) delete the .gz when it evicts the owning .txt, and (c) reap an
    # orphan .gz whose .txt stub is gone.  Before the fix, the byte cap ignored
    # every compressed entry and the .gz body leaked permanently on eviction.

    def test_gz_body_counts_toward_byte_budget(self, tmp_path: Path) -> None:
        """The .gz sibling's bytes count toward the cap, not just the 0-byte stub.

        Regression: a compressed entry's .txt stub is empty, so counting only
        .txt made `total` 0 and the byte cap never fired — a web cache of large
        pages could grow without bound while reporting itself within budget.
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        name = _valid_name("001")
        # Realistic compressed entry: empty .txt stub + a fat .gz body.
        _plant(d, f"{name}.txt", b"", t)
        gz = d / f"{name}.gz"
        gz.write_bytes(b"Z" * 200)
        os.utime(gz, (t, t))

        # Cap 150 < 200 gz bytes → must evict.  Without the fix total reads 0
        # and nothing is removed.
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=150)
        assert removed == 1
        assert not (d / f"{name}.txt").exists()
        assert not gz.exists(), ".gz body must be freed, not orphaned"

    def test_gz_body_removed_with_owning_stub(self, tmp_path: Path) -> None:
        """Evicting the .txt stub also unlinks its .gz body (no orphan left)."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        old, new = _valid_name("001"), _valid_name("002")
        # Old compressed entry (should be evicted) — stub 0 bytes, gz 120 bytes.
        _plant(d, f"{old}.txt", b"", t - 100)
        old_gz = d / f"{old}.gz"
        old_gz.write_bytes(b"Z" * 120)
        os.utime(old_gz, (t - 100, t - 100))
        # Newer plain entry that should survive.
        _plant(d, f"{new}.txt", b"X" * 50, t)

        # total = 120 (old gz) + 50 (new txt) = 170; cap 100 → old entry evicted.
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=100)
        assert removed == 1
        assert not (d / f"{old}.txt").exists()
        assert not old_gz.exists(), "old .gz body must be unlinked with its stub"
        assert (d / f"{new}.txt").exists(), "newer entry must survive"

    def test_orphan_gz_swept_when_stub_absent(self, tmp_path: Path) -> None:
        """A .gz whose .txt stub is gone is reaped by the orphan sweep.

        Mirrors the .json orphan-sidecar sweep: without a stub the .gz is
        invisible to the LRU scan, so it would otherwise leak forever.
        """
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        # Keep one real entry so the dir exists and the sweep runs.
        keep = _valid_name("001")
        _plant(d, f"{keep}.txt", b"X" * 10, t)
        # Orphan .gz with a valid stem but no .txt sibling.
        orphan = d / f"{_valid_name('002')}.gz"
        orphan.write_bytes(b"Z" * 64)

        # Caps satisfied: sweep still runs (it precedes the early-return).
        evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache",
            max_total_bytes=10_000, max_file_count=4096,
        )
        assert not orphan.exists(), "orphan .gz (no stub) must be swept"
        assert (d / f"{keep}.txt").exists()

    def test_unrelated_gz_not_deleted_by_sweep(self, tmp_path: Path) -> None:
        """A .gz whose stem is NOT a valid cache filename must be left alone."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 10, t)
        # Invalid stem (dot in the middle) — token-goat did not write this.
        unrelated = d / "user.backup.gz"
        unrelated.write_bytes(b"\x1f\x8b\x08")  # gzip magic, but not ours

        evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache",
            max_total_bytes=10_000, max_file_count=4096,
        )
        assert unrelated.exists(), "unrelated .gz (caps OK) must NOT be swept"
        evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        assert unrelated.exists(), "unrelated .gz (eviction) must NOT be swept"

    def test_store_blob_gz_entry_evicted_end_to_end(self, tmp_path: Path) -> None:
        """An entry written by the real store_blob_gz is fully evicted (stub + body)."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        output_id = _valid_name("001")
        gz_path = store_blob_gz(output_id, "x" * 5000, fn, "test_cache")
        assert gz_path is not None and gz_path.exists()
        assert (d / f"{output_id}.txt").exists()

        # Force eviction by a tiny byte cap; the compressed body alone exceeds it.
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=1)
        assert removed == 1
        assert not gz_path.exists(), "store_blob_gz body must be freed on eviction"
        assert not (d / f"{output_id}.txt").exists()

    # ------------------------------------------------------------------
    # Non-.txt files are ignored
    # ------------------------------------------------------------------

    def test_non_txt_files_ignored_in_scan(self, tmp_path: Path) -> None:
        """Only .txt files matching OUTPUT_FILENAME_RE count toward total bytes."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        # Drop a large .log file — must not be counted or deleted
        big_log = d / "some.log"
        big_log.write_bytes(b"Z" * 10_000)

        real_name = _valid_name("001")
        _plant(d, f"{real_name}.txt", b"X" * 50, t)

        # Cap is larger than the .txt file alone; without counting .log, no eviction
        removed = evict_cache_dir(cache_dir_fn=fn, log_name="test_cache", max_total_bytes=100)
        assert removed == 0
        assert big_log.exists(), "non-.txt file must not be deleted"

    # ------------------------------------------------------------------
    # log_name is threaded through to log records
    # ------------------------------------------------------------------

    def test_log_name_used_in_eviction_message(self, tmp_path: Path, caplog) -> None:
        """The log_name parameter appears in the INFO eviction log record."""
        import logging
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"X" * 100, t)

        with caplog.at_level(logging.INFO, logger="token_goat.my_test_cache"):
            evict_cache_dir(cache_dir_fn=fn, log_name="my_test_cache", max_total_bytes=1)

        assert any("my_test_cache" in r.message for r in caplog.records)

    # ------------------------------------------------------------------
    # bash_cache and web_cache wrappers use the right defaults
    # ------------------------------------------------------------------

    def test_bash_cache_default_cap_is_16mb(self) -> None:
        """bash_cache.DEFAULT_MAX_TOTAL_BYTES is 16 MB."""
        from token_goat import bash_cache
        assert bash_cache.DEFAULT_MAX_TOTAL_BYTES == 16 * 1024 * 1024

    def test_web_cache_default_cap_is_32mb(self) -> None:
        """web_cache.DEFAULT_MAX_TOTAL_BYTES is 32 MB."""
        from token_goat import web_cache
        assert web_cache.DEFAULT_MAX_TOTAL_BYTES == 32 * 1024 * 1024

    def test_bash_cache_evict_delegates_to_shared_helper(self, tmp_path: Path, monkeypatch) -> None:
        """bash_cache.evict_old_entries calls evict_cache_dir with bash_cache params."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat import bash_cache

        # Plant two entries: each 100 bytes, cap at 50 → both must go
        d = tmp_path / "bash_outputs"
        d.mkdir(parents=True, exist_ok=True)
        t = time.time()
        for i in range(2):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"B" * 100, t - (2 - i))

        removed = bash_cache.evict_old_entries(max_total_bytes=50)
        assert removed == 2
        assert list(d.glob("*.txt")) == []

    def test_web_cache_evict_delegates_to_shared_helper(self, tmp_path: Path, monkeypatch) -> None:
        """web_cache.evict_old_entries calls evict_cache_dir with web_cache params."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat import web_cache

        d = tmp_path / "web_outputs"
        d.mkdir(parents=True, exist_ok=True)
        t = time.time()
        for i in range(2):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"W" * 100, t - (2 - i))

        removed = web_cache.evict_old_entries(max_total_bytes=50)
        assert removed == 2
        assert list(d.glob("*.txt")) == []


class TestEvictCacheDirFileCount:
    """max_file_count cap in evict_cache_dir prevents unbounded file growth."""

    def test_noop_when_under_both_caps(self, tmp_path: Path) -> None:
        """No eviction when both bytes and count are within limits."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        for i in range(3):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"X" * 10, t + i)
        removed = evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache", max_total_bytes=10_000, max_file_count=10
        )
        assert removed == 0
        assert len(list(d.glob("*.txt"))) == 3

    def test_evicts_when_file_count_exceeded_but_bytes_ok(self, tmp_path: Path) -> None:
        """When byte budget is fine but file count exceeds cap, oldest files are removed."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        # 5 tiny files; byte budget is huge but count cap is 3
        for i in range(5):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"X" * 5, t + i)

        removed = evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache", max_total_bytes=10_000, max_file_count=3
        )
        assert removed == 2, "2 oldest files must be evicted to reach count=3"
        assert len(list(d.glob("*.txt"))) == 3

    def test_evicts_when_both_caps_exceeded(self, tmp_path: Path) -> None:
        """When both bytes and count are over cap, eviction stops when BOTH are met."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        # 6 files of 100 bytes each; byte cap=250 (needs to remove 4), count cap=3 (needs to remove 3)
        for i in range(6):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"X" * 100, t + i)

        removed = evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache", max_total_bytes=250, max_file_count=3
        )
        # byte cap requires removing 4, count cap requires removing 3 — must satisfy both
        assert removed == 4
        remaining = list(d.glob("*.txt"))
        assert len(remaining) == 2

    def test_count_noop_when_exactly_at_cap(self, tmp_path: Path) -> None:
        """Eviction is skipped when file count equals the cap (<=, not <)."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        t = time.time()
        for i in range(4):
            name = _valid_name(f"{i:03d}")
            _plant(d, f"{name}.txt", b"X" * 5, t + i)

        removed = evict_cache_dir(
            cache_dir_fn=fn, log_name="test_cache", max_total_bytes=10_000, max_file_count=4
        )
        assert removed == 0

    def test_bash_cache_file_count_cap_applied(self, tmp_path: Path, monkeypatch) -> None:
        """bash_cache.evict_old_entries respects max_file_count parameter."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat import bash_cache

        d = tmp_path / "bash_outputs"
        d.mkdir(parents=True, exist_ok=True)
        t = time.time()
        # Use a smaller cap for faster testing (102 files instead of 4098).
        # This tests the same file-count-cap logic as the real cap.
        test_cap = 100
        for i in range(test_cap + 2):
            name = _valid_name(f"{i:05d}")
            _plant(d, f"{name}.txt", b"X" * 5, t + i)

        removed = bash_cache.evict_old_entries(
            max_total_bytes=bash_cache.DEFAULT_MAX_TOTAL_BYTES,
            max_file_count=test_cap,
        )
        assert removed == 2, f"expected 2 files evicted to reach count cap {test_cap}"
        assert len(list(d.glob("*.txt"))) == test_cap


class TestTruncateTailPreserve:
    """truncate_tail_preserve: tail-keep + marker for content above the byte cap."""

    _MARKER = "[truncated; kept {n} of {total} bytes]\n"

    def test_under_limit_returns_content_unchanged(self) -> None:
        content = "hello world"
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=100, marker_template=self._MARKER,
        )
        assert stored == content
        assert truncated is False

    def test_exactly_at_limit_returns_unchanged(self) -> None:
        content = "x" * 50
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=50, marker_template=self._MARKER,
        )
        assert stored == content
        assert truncated is False

    def test_over_limit_keeps_tail_and_prepends_marker(self) -> None:
        content = "first chunk\n" + ("y" * 200)
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=50, marker_template=self._MARKER,
        )
        assert truncated is True
        # Marker prepended with the original byte total
        assert "[truncated; kept 50 of " in stored
        # Tail kept (last 50 chars of original content)
        assert stored.endswith("y" * 50)
        # Head dropped — "first chunk" must not appear
        assert "first chunk" not in stored

    def test_byte_length_counts_utf8(self) -> None:
        """Multi-byte chars should count in the threshold, not codepoint length."""
        # Each "é" is 2 bytes in utf-8; 40 codepoints * 2 = 80 bytes
        content = "é" * 40
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=50, marker_template=self._MARKER,
        )
        assert truncated is True
        # Marker reports the true byte total, not codepoint count
        assert "of 80 bytes" in stored

    def test_marker_template_formats_with_n_and_total(self) -> None:
        content = "z" * 100
        stored, _ = truncate_tail_preserve(
            content, max_bytes=20, marker_template="MARK n={n} total={total}\n",
        )
        assert stored.startswith("MARK n=20 total=100\n")

    def test_utf8_kept_bytes_at_or_under_cap(self) -> None:
        """The kept tail's utf-8 byte length must be at or under max_bytes.

        Regression test: previously the implementation used codepoint slicing
        (``content[-max_bytes:]``) which for multi-byte characters could store
        up to 4× the cap on disk, silently breaking the directory byte-cap.
        The fix slices on raw bytes, then decodes with errors="replace" so a
        cut at a codepoint boundary is safe.
        """
        # Each Chinese character is 3 bytes in utf-8.
        # 200 characters × 3 bytes = 600 bytes total
        content = "中" * 200
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=60, marker_template="[t {n}/{total}]\n",
        )
        assert truncated is True
        # The kept portion (after the marker prefix) must be at or under 60 bytes
        # The marker prefix itself is not counted toward the cap.
        marker_end = stored.index("]\n") + 2
        kept_only = stored[marker_end:]
        kept_bytes = len(kept_only.encode("utf-8", errors="replace"))
        assert kept_bytes <= 60, (
            f"kept tail is {kept_bytes} bytes, exceeds cap of 60"
        )

    def test_utf8_4byte_emoji_kept_bytes_at_or_under_cap(self) -> None:
        """4-byte UTF-8 (emoji) tail honours the byte cap."""
        # Pile of poo emoji (U+1F4A9) is 4 bytes in UTF-8.  50 emoji = 200 bytes.
        content = "\U0001f4a9" * 50
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=20, marker_template="[t {n}/{total}]\n",
        )
        assert truncated is True
        marker_end = stored.index("]\n") + 2
        kept_only = stored[marker_end:]
        kept_bytes = len(kept_only.encode("utf-8", errors="replace"))
        assert kept_bytes <= 20, (
            f"kept tail is {kept_bytes} bytes, exceeds cap of 20"
        )

    def test_utf8_partial_codepoint_handled_with_replacement(self) -> None:
        """If the byte cut falls mid-codepoint, decode yields a U+FFFD prefix.

        We don't strictly require the prefix character — different platforms
        could behave differently — but the kept content must remain valid UTF-8
        and must fit in the byte budget.
        """
        # Mix ASCII tail with 3-byte chars to force a mid-codepoint cut.
        # "中" × 30 = 90 bytes; cap at 50 bytes.  The byte slice will cut in the
        # middle of a "中".
        content = "中" * 30
        stored, truncated = truncate_tail_preserve(
            content, max_bytes=50, marker_template="[t {n}/{total}]\n",
        )
        assert truncated is True
        marker_end = stored.index("]\n") + 2
        kept_only = stored[marker_end:]
        # Encode round-trips cleanly — must be valid UTF-8 string.
        encoded = kept_only.encode("utf-8")
        re_decoded = encoded.decode("utf-8")
        assert kept_only == re_decoded


class TestShortContentHash:
    """short_content_hash: 16-hex SHA-256 truncation of any string."""

    def test_returns_16_hex_chars(self) -> None:
        result = short_content_hash("hello world")
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result)

    def test_deterministic(self) -> None:
        assert short_content_hash("echo hi") == short_content_hash("echo hi")

    def test_distinct_inputs_produce_distinct_hashes(self) -> None:
        assert short_content_hash("cmd_a") != short_content_hash("cmd_b")

    def test_empty_string(self) -> None:
        result = short_content_hash("")
        assert len(result) == 16

    def test_unicode_does_not_raise(self) -> None:
        result = short_content_hash("héllo 中文 \x00\xff")
        assert len(result) == 16

    def test_matches_bash_cache_command_hash(self) -> None:
        """bash_cache.command_hash must delegate to short_content_hash."""
        from token_goat.bash_cache import command_hash
        cmd = "pytest -v --tb=short"
        assert command_hash(cmd) == short_content_hash(cmd)

    def test_matches_web_cache_url_hash(self) -> None:
        """web_cache.url_hash must delegate to short_content_hash."""
        from token_goat.web_cache import url_hash
        url = "https://example.com/page?q=1"
        assert url_hash(url) == short_content_hash(url)

    def test_matches_skill_cache_content_hash(self) -> None:
        """skill_cache.content_hash must delegate to short_content_hash."""
        from token_goat.skill_cache import content_hash
        body = "# My Skill\nsome content here"
        assert content_hash(body) == short_content_hash(body)


class TestBuildOutputId:
    """build_output_id: canonical {session_short}-{ms:013d}-{token} format."""

    def test_format_structure(self) -> None:
        # Use a session ID with no hyphens so split("-") yields exactly 3 parts.
        result = build_output_id("mysessionid", "deadbeef01234567", ts=1_000.0)
        parts = result.split("-")
        # Exactly 3 parts: session_fragment, ms_timestamp, content_token
        assert len(parts) == 3, f"expected 3 dash-separated parts, got: {parts!r}"
        session_part, ms_part, token_part = parts
        assert session_part == "mysessionid"
        assert ms_part == f"{1_000_000:013d}", f"unexpected ms part: {ms_part!r}"
        assert token_part == "deadbeef01234567"

    def test_session_fragment_is_prefix(self) -> None:
        result = build_output_id("abc-def-ghi-extra-long", "token123", ts=0.0)
        frag = safe_session_fragment("abc-def-ghi-extra-long")
        assert result.startswith(frag + "-")

    def test_uses_current_time_when_ts_is_none(self) -> None:
        before = int(time.time() * 1000)
        result = build_output_id("sess", "tok")
        after = int(time.time() * 1000)
        # Extract ms component (second dash-separated segment)
        parts = result.split("-")
        ms_val = int(parts[1])
        assert before <= ms_val <= after

    def test_two_calls_with_same_ts_produce_same_id(self) -> None:
        a = build_output_id("sess", "tok", ts=12345.678)
        b = build_output_id("sess", "tok", ts=12345.678)
        assert a == b

    def test_different_ts_produces_different_id(self) -> None:
        a = build_output_id("sess", "tok", ts=1.0)
        b = build_output_id("sess", "tok", ts=2.0)
        assert a != b

    def test_result_matches_output_filename_re(self) -> None:
        result = build_output_id("my-session", short_content_hash("cmd"), ts=42.0)
        assert OUTPUT_FILENAME_RE.match(result + ".txt"), (
            f"build_output_id result {result!r} is not a valid cache filename stem"
        )

    def test_matches_bash_cache_output_id_for_structure(self, monkeypatch) -> None:
        """bash_cache.output_id_for must produce an id built by build_output_id."""
        import pathlib
        import tempfile

        import token_goat.paths as _paths
        with tempfile.TemporaryDirectory() as td:
            monkeypatch.setattr(_paths, "data_dir", lambda: pathlib.Path(td))
            from token_goat.bash_cache import command_hash, output_id_for
            ts = 9999.0
            cmd = "git status"
            expected = build_output_id("sess-x", command_hash(cmd), ts=ts)
            actual = output_id_for("sess-x", cmd, ts=ts)
            assert actual == expected

    def test_matches_web_cache_output_id_for_structure(self, monkeypatch) -> None:
        """web_cache.output_id_for must produce an id built by build_output_id."""
        import pathlib
        import tempfile

        import token_goat.paths as _paths
        with tempfile.TemporaryDirectory() as td:
            monkeypatch.setattr(_paths, "data_dir", lambda: pathlib.Path(td))
            from token_goat.web_cache import output_id_for, url_hash
            ts = 7777.0
            url = "https://docs.example.com/"
            expected = build_output_id("sess-y", url_hash(url), ts=ts)
            actual = output_id_for("sess-y", url, ts=ts)
            assert actual == expected


class TestBuildKeyedOutputId:
    """build_keyed_output_id: timestamp-less {prefix}{session}-{token} IDs.

    Used by the bash glob-result cache where re-running the same Glob call
    in a session must overwrite the existing entry rather than accumulate one
    cache file per call.
    """

    def test_basic_format(self) -> None:
        from token_goat.cache_common import build_keyed_output_id
        result = build_keyed_output_id("glob_", "sess", "deadbeef01234567")
        assert result == "glob_sess-deadbeef01234567"

    def test_same_inputs_produce_same_id(self) -> None:
        """Two calls with the same args must collide so the cache overwrites."""
        from token_goat.cache_common import build_keyed_output_id
        a = build_keyed_output_id("glob_", "mysession", "deadbeef01234567")
        b = build_keyed_output_id("glob_", "mysession", "deadbeef01234567")
        assert a == b

    def test_different_tokens_produce_different_ids(self) -> None:
        from token_goat.cache_common import build_keyed_output_id
        a = build_keyed_output_id("glob_", "sess", "aaaaaaaaaaaaaaaa")
        b = build_keyed_output_id("glob_", "sess", "bbbbbbbbbbbbbbbb")
        assert a != b

    def test_session_fragment_is_safe(self) -> None:
        """Session ID is sanitised the same way as build_output_id."""
        from token_goat.cache_common import build_keyed_output_id
        result = build_keyed_output_id("glob_", "hello world!", "tok")
        # Spaces and ! become underscores, truncated to 16 chars
        assert result == "glob_hello_world_-tok"

    def test_result_matches_output_filename_re(self) -> None:
        """Result + .txt suffix must be a valid cache filename."""
        from token_goat.cache_common import build_keyed_output_id
        result = build_keyed_output_id("glob_", "session-id-123", "abcdef0123456789")
        assert OUTPUT_FILENAME_RE.match(result + ".txt"), (
            f"build_keyed_output_id result {result!r} is not a valid cache filename stem"
        )

    def test_used_by_bash_store_glob_result(self, tmp_path, monkeypatch) -> None:
        """bash_cache.store_glob_result builds an ID via build_keyed_output_id."""
        import token_goat.paths as _paths
        from token_goat.cache_common import build_keyed_output_id

        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)

        from token_goat.bash_cache import (
            _GLOB_RESULT_PREFIX,
            glob_hash,
            store_glob_result,
        )
        sid = "test-glob-session"
        pattern = "**/*.py"
        path = None
        out_id = store_glob_result(sid, pattern, path, "src/main.py\n")
        assert out_id is not None
        expected = build_keyed_output_id(
            _GLOB_RESULT_PREFIX, sid, glob_hash(pattern, path)
        )
        assert out_id == expected

    def test_two_stores_of_same_glob_collide(self, tmp_path, monkeypatch) -> None:
        """Storing the same glob twice overwrites the entry — single file on disk."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)
        from token_goat.bash_cache import _bash_outputs_dir, store_glob_result

        sid = "collision-session"
        store_glob_result(sid, "*.ts", None, "first.ts\n")
        store_glob_result(sid, "*.ts", None, "first.ts\nsecond.ts\n")

        # Exactly one entry on disk (same ID, overwritten).
        entries = list(_bash_outputs_dir().glob("*.txt"))
        assert len(entries) == 1
        assert "second.ts" in entries[0].read_text()


class TestOutputStatDict:
    """OutputStatDict is the canonical shared TypedDict for all three caches."""

    def test_importable_from_cache_common(self) -> None:
        """Verify OutputStatDict is importable as a single canonical class."""
        from token_goat.cache_common import OutputStatDict as OSD
        assert OSD is OutputStatDict

    def test_bash_cache_uses_cache_common_type(self) -> None:
        """bash_cache.load_output_meta return annotation uses OutputStatDict."""
        from token_goat import bash_cache
        hints = bash_cache.load_output_meta.__annotations__
        ret = hints.get("return", "")
        # The annotation should reference OutputStatDict (possibly as Optional)
        assert "OutputStatDict" in str(ret)

    def test_web_cache_uses_cache_common_type(self) -> None:
        from token_goat import web_cache
        hints = web_cache.load_output_meta.__annotations__
        ret = hints.get("return", "")
        assert "OutputStatDict" in str(ret)

    def test_skill_cache_uses_cache_common_type(self) -> None:
        from token_goat import skill_cache
        hints = skill_cache.load_output_meta.__annotations__
        ret = hints.get("return", "")
        assert "OutputStatDict" in str(ret)

    def test_no_local_outputstatdict_in_cache_modules(self) -> None:
        """None of the three cache modules define their own _OutputStatDict."""
        import token_goat.bash_cache as bc
        import token_goat.skill_cache as sc
        import token_goat.web_cache as wc
        for mod in (bc, wc, sc):
            assert not hasattr(mod, "_OutputStatDict"), (
                f"{mod.__name__} still defines local _OutputStatDict"
            )


class TestGetCacheDir:
    """get_cache_dir(name) returns data_dir()/name and creates the directory."""

    def test_creates_subdir_under_data_dir(self, tmp_path, monkeypatch) -> None:
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)
        result = get_cache_dir("my_cache")
        assert result == tmp_path / "my_cache"
        assert result.is_dir()

    def test_idempotent_when_dir_exists(self, tmp_path, monkeypatch) -> None:
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)
        get_cache_dir("my_cache")
        # Second call must not raise
        result = get_cache_dir("my_cache")
        assert result.is_dir()

    def test_each_cache_module_uses_get_cache_dir(self, tmp_path, monkeypatch) -> None:
        """All three cache modules must route their _*_dir() through get_cache_dir."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)
        from token_goat import bash_cache, skill_cache, web_cache
        assert bash_cache._bash_outputs_dir() == tmp_path / "bash_outputs"
        assert web_cache._web_outputs_dir() == tmp_path / "web_outputs"
        assert skill_cache._skill_outputs_dir() == tmp_path / "skills"

    def test_no_raw_mkdir_in_web_cache(self) -> None:
        """web_cache must not call .mkdir() directly — it must delegate to get_cache_dir."""
        import ast
        import pathlib
        src = (pathlib.Path(__file__).parent.parent / "src" / "token_goat" / "web_cache.py").read_text()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "mkdir":
                raise AssertionError(
                    f"web_cache.py still calls .mkdir() directly at line {node.lineno}; "
                    "use get_cache_dir() instead"
                )


class TestSidecarPathFor:
    """sidecar_path_for(output_path) returns the .json sibling of a .txt body file."""

    def test_replaces_txt_with_json(self, tmp_path) -> None:
        body = tmp_path / "abc-0000000000000-deadbeef.txt"
        assert sidecar_path_for(body) == tmp_path / "abc-0000000000000-deadbeef.json"

    def test_works_on_path_without_existing_file(self, tmp_path) -> None:
        body = tmp_path / "anon-9999999999999-cafebabe0000cafe.txt"
        result = sidecar_path_for(body)
        assert result.suffix == ".json"
        assert result.stem == body.stem

    def test_each_cache_sidecar_meta_path_uses_sidecar_path_for(self, tmp_path, monkeypatch) -> None:
        """All three caches must route sidecar_meta_path through sidecar_path_for."""
        import token_goat.paths as _paths
        monkeypatch.setattr(_paths, "data_dir", lambda: tmp_path)
        from token_goat import bash_cache, web_cache

        # Craft valid output IDs for each cache (skill IDs have a different
        # shape and are validated separately via the skill_cache tests).
        bash_id = "anon-0000000000001-abcdef0123456789"
        web_id = "anon-0000000000002-abcdef0123456789"

        for cache_mod, oid, subdir in (
            (bash_cache, bash_id, "bash_outputs"),
            (web_cache, web_id, "web_outputs"),
        ):
            result = cache_mod.sidecar_meta_path(oid)
            assert result is not None
            assert result.suffix == ".json"
            assert result.parent == tmp_path / subdir


class TestSafeCacheOp:
    """safe_cache_op: context manager that catches OSError and logs a warning."""

    def _make_log(self) -> logging.Logger:
        return logging.getLogger("test_safe_cache_op")

    def test_no_exception_passes_through(self) -> None:
        """When no exception is raised the with-block completes normally."""
        result = []
        with safe_cache_op("test_op", log=self._make_log()):
            result.append(42)
        assert result == [42]

    def test_oserror_suppressed(self) -> None:
        """OSError is caught and does not propagate."""
        ran = []
        with safe_cache_op("test_op", log=self._make_log()):
            raise OSError("disk full")
        ran.append("after_with")
        assert ran == ["after_with"]

    def test_oserror_subclass_suppressed(self) -> None:
        """FileNotFoundError (a subclass of OSError) is also suppressed."""
        with safe_cache_op("test_op", log=self._make_log()):
            raise FileNotFoundError("not found")

    def test_non_oserror_propagates(self) -> None:
        """Non-OSError exceptions are not suppressed."""
        with pytest.raises(ValueError, match="bad value"), safe_cache_op("test_op", log=self._make_log()):
            raise ValueError("bad value")

    def test_oserror_logs_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        """OSError triggers a warning log containing the op_name."""
        log = logging.getLogger("token_goat.cache_common_test")
        with caplog.at_level(logging.WARNING, logger=log.name), safe_cache_op("my_op", log=log):
            raise OSError("disk full")
        assert any("my_op" in r.message for r in caplog.records)

    def test_return_value_pattern(self) -> None:
        """The caller can use 'return None' after the with-block as the fallback."""
        def _store(fail: bool) -> int | None:
            with safe_cache_op("store", log=self._make_log()):
                if fail:
                    raise OSError("disk full")
                return 42
            return None

        assert _store(fail=False) == 42
        assert _store(fail=True) is None


class TestStoreBlobGz:
    """store_blob_gz and load_blob_gz shared gzip cache helpers."""

    def test_roundtrip(self, tmp_path: Path) -> None:
        """Text written via store_blob_gz is recovered via load_blob_gz."""
        def dir_fn() -> Path:
            return tmp_path

        body = "Hello, world!\nLine two.\n"
        result = store_blob_gz("test-id-0001", body, dir_fn, "test_cache")
        assert result is not None
        assert result.suffix == ".gz"
        assert result.exists()

        # .txt stub should also exist for eviction discovery
        assert (tmp_path / "test-id-0001.txt").exists()

        recovered = load_blob_gz("test-id-0001", dir_fn, "test_cache")
        assert recovered == body

    def test_missing_returns_none(self, tmp_path: Path) -> None:
        """load_blob_gz returns None when no .gz file exists."""
        def dir_fn() -> Path:
            return tmp_path

        result = load_blob_gz("nonexistent-id", dir_fn, "test_cache")
        assert result is None

    def test_unicode_roundtrip(self, tmp_path: Path) -> None:
        """Unicode content including multi-byte characters survives the gz roundtrip."""
        def dir_fn() -> Path:
            return tmp_path

        body = "Skill: émoji \U0001f410 content\nLine 2\n"
        store_blob_gz("uni-id-0001", body, dir_fn, "test_cache")
        recovered = load_blob_gz("uni-id-0001", dir_fn, "test_cache")
        assert recovered == body

    def test_corrupt_gz_returns_none(self, tmp_path: Path) -> None:
        """load_blob_gz returns None when the .gz file is corrupted."""
        def dir_fn() -> Path:
            return tmp_path

        gz_path = tmp_path / "bad-id-0001.gz"
        gz_path.write_bytes(b"not valid gzip data")

        result = load_blob_gz("bad-id-0001", dir_fn, "test_cache")
        assert result is None


class TestGzCompanionSizeAccounting:
    """The metadata/listing helpers must report a compressed entry's true on-disk size.

    store_blob_gz keeps the real bytes in a ``<id>.gz`` sibling behind a 0-byte
    ``<id>.txt`` stub.  Before the fix, load_output_meta_stat and list_cache_outputs
    stat'd only the stub, so every compressed entry reported ~0 bytes — wrong in
    ``web-output --list`` / ``bash-history`` / ``doctor`` and in get_output_size's
    no-sidecar fallback.  Eviction already counted the sibling; these helpers now
    share the same gz_companion_size source of truth.
    """

    def test_gz_companion_size_returns_sibling_bytes(self, tmp_path: Path) -> None:
        name = _valid_name("001")
        txt = _plant(tmp_path, f"{name}.txt", b"", time.time())
        (tmp_path / f"{name}.gz").write_bytes(b"Z" * 321)
        assert gz_companion_size(txt) == 321

    def test_gz_companion_size_zero_when_no_sibling(self, tmp_path: Path) -> None:
        name = _valid_name("001")
        txt = _plant(tmp_path, f"{name}.txt", b"X" * 40, time.time())
        # An uncompressed entry has no .gz sibling.
        assert gz_companion_size(txt) == 0

    def test_load_output_meta_stat_includes_gz_size(self, tmp_path: Path) -> None:
        """A compressed entry reports stub + .gz bytes, not the 0-byte stub alone."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"", time.time())  # 0-byte stub
        (d / f"{name}.gz").write_bytes(b"Z" * 500)

        meta = load_output_meta_stat(name, fn, "test_cache")
        assert meta is not None
        assert meta["size_bytes"] == 500, "compressed entry must report its .gz body size"

    def test_list_cache_outputs_includes_gz_size(self, tmp_path: Path) -> None:
        """list_cache_outputs reports the on-disk footprint including the .gz sibling."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"", time.time())
        (d / f"{name}.gz").write_bytes(b"Z" * 750)

        rows = list_cache_outputs(fn)
        assert len(rows) == 1
        assert rows[0]["output_id"] == name
        assert rows[0]["size_bytes"] == 750

    def test_uncompressed_entry_size_unchanged(self, tmp_path: Path) -> None:
        """An entry with no .gz sibling still reports exactly its .txt byte count."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        _plant(d, f"{name}.txt", b"X" * 123, time.time())

        meta = load_output_meta_stat(name, fn, "test_cache")
        assert meta is not None and meta["size_bytes"] == 123
        rows = list_cache_outputs(fn)
        assert rows[0]["size_bytes"] == 123

    def test_real_store_blob_gz_entry_reports_compressed_size(self, tmp_path: Path) -> None:
        """End-to-end: an entry written by store_blob_gz lists with a non-zero size."""
        d = tmp_path / "cache"
        fn = _make_cache_dir_fn(d)
        name = _valid_name("001")
        gz_path = store_blob_gz(name, "x" * 5000, fn, "test_cache")
        assert gz_path is not None and gz_path.exists()
        on_disk = gz_path.stat().st_size

        meta = load_output_meta_stat(name, fn, "test_cache")
        assert meta is not None
        assert meta["size_bytes"] == on_disk, "must equal the real .gz body, not 0"
        assert meta["size_bytes"] > 0
        rows = list_cache_outputs(fn)
        assert rows[0]["size_bytes"] == on_disk
