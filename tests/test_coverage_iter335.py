"""Tests for RsyncFilter and CrystalFilter — both had zero test coverage."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# RsyncFilter
# ---------------------------------------------------------------------------

_RSYNC = bc.RsyncFilter()

_RSYNC_TYPICAL = """\
sending incremental file list
path/to/file1.txt
path/to/file2.py
dir/subdir/asset.png
another/file.json
sent 12345 bytes  received 456 bytes  25602.00 bytes/sec
total size is 9876543  speedup is 751.23
"""

_RSYNC_MANY_FILES = "\n".join(
    [f"path/to/file{i}.txt" for i in range(200)]
    + [
        "sent 1000000 bytes  received 5000 bytes  670000.00 bytes/sec",
        "total size is 50000000  speedup is 49.50",
    ]
)

_RSYNC_WITH_ERRORS = """\
rsync: [sender] link_stat "/nonexistent" failed: No such file or directory (2)
rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1330)
sent 0 bytes  received 8 bytes  16.00 bytes/sec
total size is 0  speedup is 0.00
"""

_RSYNC_PROGRESS = """\
sending incremental file list
bigfile.tar.gz
    10,485,760 100%   10.00MB/s    0:00:01 (xfr#1, to-chk=0/1)
sent 10485760 bytes  received 35 bytes  6990530.67 bytes/sec
total size is 10485760  speedup is 1.00
"""


class TestRsyncFilterMatches:
    def test_rsync_bare(self) -> None:
        assert _RSYNC.matches(["rsync"])

    def test_rsync_with_flags(self) -> None:
        assert _RSYNC.matches(["rsync", "-avz", "src/", "dest/"])

    def test_rsync_remote(self) -> None:
        assert _RSYNC.matches(["rsync", "-e", "ssh", "user@host:/src", "/dst"])

    def test_non_rsync_no_match(self) -> None:
        assert not _RSYNC.matches(["rclone"])
        assert not _RSYNC.matches(["scp"])
        assert not _RSYNC.matches([])

    def test_dispatch_routes_to_rsync(self) -> None:
        f = bc.select_filter(["rsync", "-av", "src/", "dst/"])
        assert f is not None
        assert f.name == "rsync"

    def test_rsync_in_all(self) -> None:
        assert "RsyncFilter" in bc.__all__


class TestRsyncFilterSummaryPreserved:
    def test_sent_received_summary_kept(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_TYPICAL, argv=["rsync", "-av"])
        assert "sent 12345 bytes" in result

    def test_total_size_summary_kept(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_TYPICAL, argv=["rsync", "-av"])
        assert "total size is 9876543" in result

    def test_sending_incremental_header_kept(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_TYPICAL, argv=["rsync", "-av"])
        assert "sending incremental file list" in result


class TestRsyncFilterFileDrop:
    def test_per_file_lines_dropped(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_TYPICAL, argv=["rsync", "-av"])
        assert "path/to/file1.txt" not in result
        assert "path/to/file2.py" not in result
        assert "dir/subdir/asset.png" not in result

    def test_collapsed_count_note_emitted(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_TYPICAL, argv=["rsync", "-av"])
        # Should mention how many files were collapsed
        assert "collapsed" in result
        assert "per-file" in result

    def test_collapse_count_is_accurate(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_MANY_FILES, argv=["rsync", "-av"])
        # 200 file lines should be collapsed
        assert "200" in result

    def test_output_shorter_than_input(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_MANY_FILES, argv=["rsync", "-av"])
        assert len(result) < len(_RSYNC_MANY_FILES)


class TestRsyncFilterErrorPreserved:
    def test_rsync_error_line_kept(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_WITH_ERRORS, argv=["rsync"])
        assert "rsync error" in result.lower()

    def test_link_stat_failure_kept(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_WITH_ERRORS, argv=["rsync"])
        assert "No such file or directory" in result


class TestRsyncFilterProgressBars:
    def test_progress_bar_lines_dropped(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_PROGRESS, argv=["rsync", "-av", "--progress"])
        # The "100%" progress bar line should not appear
        assert "10.00MB/s" not in result

    def test_summary_still_kept_with_progress(self) -> None:
        result = _apply(_RSYNC, stdout=_RSYNC_PROGRESS, argv=["rsync", "-av", "--progress"])
        assert "sent 10485760 bytes" in result


class TestRsyncFilterEdgeCases:
    def test_empty_stdout(self) -> None:
        result = _apply(_RSYNC, stdout="", argv=["rsync"])
        assert isinstance(result, str)

    def test_no_files_no_collapse_note(self) -> None:
        # Only summary lines — no files transferred
        stdout = (
            "sending incremental file list\n"
            "sent 100 bytes  received 20 bytes  240.00 bytes/sec\n"
            "total size is 0  speedup is 0.00\n"
        )
        result = _apply(_RSYNC, stdout=stdout, argv=["rsync", "-av"])
        assert "collapsed" not in result

    def test_passthrough_on_error_exit(self) -> None:
        result = _apply(_RSYNC, stdout="", stderr="rsync error: code 11", exit_code=11, argv=["rsync"])
        assert "rsync error" in result


# ---------------------------------------------------------------------------
# CrystalFilter
# ---------------------------------------------------------------------------

_CRYSTAL = bc.CrystalFilter()

_CRYSTAL_SPEC_PASSING = """\
Compiling MyApp (release)
Compiling spec_helper.cr
Linking crystal spec
✓ user can log in (2ms)
✓ user can log out (1ms)
✓ cart calculates totals correctly (3ms)
5 examples, 0 failures, 0 errors in 1.23s
"""

_CRYSTAL_SPEC_DOTS = """\
Compiling MyApp
Linking crystal spec
.......
5 examples, 0 failures, 0 errors in 0.45s
"""

_CRYSTAL_SPEC_WITH_FAILURE = """\
Compiling MyApp
Linking crystal spec
.F.
Failures:

  1) cart calculates totals correctly
     Failure/Error: expect(cart.total).to eq(100)

       Expected: 100
            got: 99

5 examples, 1 failure, 0 errors in 0.87s
"""

_CRYSTAL_SHARDS_OUTPUT = """\
Fetching https://github.com/amberframework/amber.git
Using crystal-db (0.10.0)
Using pg (0.24.0)
Fetching https://github.com/crystal-lang/crystal-mysql.git
Installing ameba (0.12.0)
Shards are up to date.
"""


class TestCrystalFilterMatches:
    def test_crystal_bare(self) -> None:
        assert _CRYSTAL.matches(["crystal"])

    def test_crystal_spec(self) -> None:
        assert _CRYSTAL.matches(["crystal", "spec"])

    def test_shards(self) -> None:
        assert _CRYSTAL.matches(["shards"])

    def test_shards_install(self) -> None:
        assert _CRYSTAL.matches(["shards", "install"])

    def test_non_crystal_no_match(self) -> None:
        assert not _CRYSTAL.matches(["ruby"])
        assert not _CRYSTAL.matches(["gem"])
        assert not _CRYSTAL.matches([])

    def test_dispatch_routes_to_crystal(self) -> None:
        f = bc.select_filter(["crystal", "spec"])
        assert f is not None
        assert f.name == "crystal"

    def test_shards_routes_to_crystal(self) -> None:
        f = bc.select_filter(["shards", "install"])
        assert f is not None
        assert f.name == "crystal"

    def test_crystal_in_all(self) -> None:
        assert "CrystalFilter" in bc.__all__


class TestCrystalFilterPassingSpec:
    def test_summary_line_kept(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_PASSING, argv=["crystal", "spec"])
        assert "5 examples, 0 failures" in result

    def test_compilation_lines_collapsed(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_PASSING, argv=["crystal", "spec"])
        # Should not show raw compile lines
        assert "Compiling MyApp" not in result
        assert "Linking crystal spec" not in result

    def test_compilation_count_emitted(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_PASSING, argv=["crystal", "spec"])
        # Should emit a note about collapsed compilation lines
        assert "compilation" in result.lower() or "compil" in result.lower()

    def test_verbose_spec_lines_collapsed(self) -> None:
        # ✓ lines with timing must be suppressed, not passed through
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_PASSING, argv=["crystal", "spec"])
        assert "✓ user can log in" not in result

    def test_verbose_spec_collapse_note_emitted(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_PASSING, argv=["crystal", "spec"])
        assert "passing Crystal spec line" in result

    def test_dot_progress_dropped(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_DOTS, argv=["crystal", "spec"])
        assert "......." not in result

    def test_output_shorter_than_large_input(self) -> None:
        # Use a large spec run so collapse notes don't inflate the output
        large_stdout = (
            "Compiling BigApp\n" * 10
            + "Linking crystal spec\n"
            + "." * 50 + "\n"
            + "5000 examples, 0 failures, 0 errors in 30.00s\n"
        )
        result = _apply(_CRYSTAL, stdout=large_stdout, argv=["crystal", "spec"])
        assert len(result) < len(large_stdout)


class TestCrystalFilterFailure:
    def test_failure_header_kept(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_WITH_FAILURE, argv=["crystal", "spec"])
        assert "Failures:" in result

    def test_failure_detail_kept(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_WITH_FAILURE, argv=["crystal", "spec"])
        assert "Expected: 100" in result
        assert "got: 99" in result

    def test_summary_kept_on_failure(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_WITH_FAILURE, argv=["crystal", "spec"])
        assert "1 failure" in result

    def test_pure_dot_progress_dropped_even_with_failure(self) -> None:
        # A run with both dots and a failure — pure dot lines still get collapsed
        stdout_with_dots = (
            "Compiling MyApp\n"
            "........\n"  # pure dot-only progress line
            "Failures:\n\n"
            "  1) something failed\n\n"
            "5 examples, 1 failure, 0 errors in 0.87s\n"
        )
        result = _apply(_CRYSTAL, stdout=stdout_with_dots, argv=["crystal", "spec"])
        assert "........" not in result


class TestCrystalFilterShards:
    def test_shards_done_kept(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SHARDS_OUTPUT, argv=["shards", "install"])
        assert "Shards are up to date" in result

    def test_shards_progress_collapsed(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SHARDS_OUTPUT, argv=["shards", "install"])
        assert "Using crystal-db" not in result
        assert "Fetching https://github.com/amberframework" not in result
        assert "Installing ameba" not in result

    def test_shards_progress_count_emitted(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SHARDS_OUTPUT, argv=["shards", "install"])
        # The note must specifically mention the shard dependency actions
        assert "shard dependency action" in result

    def test_shards_output_shorter_than_input(self) -> None:
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SHARDS_OUTPUT, argv=["shards", "install"])
        assert len(result) < len(_CRYSTAL_SHARDS_OUTPUT)


class TestCrystalFilterEdgeCases:
    def test_empty_input(self) -> None:
        result = _apply(_CRYSTAL, stdout="", argv=["crystal", "spec"])
        assert isinstance(result, str)

    def test_error_exit_preserves_stderr(self) -> None:
        stderr = "Error: syntax error in 'main.cr'\n"
        result = _apply(_CRYSTAL, stdout="", stderr=stderr, exit_code=1, argv=["crystal", "spec"])
        assert isinstance(result, str)
        # On non-zero exit, stderr is preserved
        assert "syntax error" in result or stderr in result

    def test_only_summary_no_collapse_notes(self) -> None:
        stdout = "1 examples, 0 failures, 0 errors in 0.01s\n"
        result = _apply(_CRYSTAL, stdout=stdout, argv=["crystal", "spec"])
        assert "1 examples" in result
        assert "collapsed" not in result

    def test_dot_f_in_failure_kept(self) -> None:
        # ".F." is the mixed dot/failure indicator — not a pure dot line, must be kept
        result = _apply(_CRYSTAL, stdout=_CRYSTAL_SPEC_WITH_FAILURE, argv=["crystal", "spec"])
        assert ".F." in result
