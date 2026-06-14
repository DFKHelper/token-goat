"""Tests for GemFilter — ``gem install`` / ``gem update`` output compression."""

from __future__ import annotations

from token_goat.bash_compress import GemFilter, select_filter
from token_goat.bash_detect import detect

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FILTER = GemFilter()

SINGLE_GEM_STDOUT = """\
Fetching bundler-2.5.9.gem
Successfully installed bundler-2.5.9
Parsing documentation for bundler-2.5.9
Installing ri documentation for bundler-2.5.9
Done installing documentation for bundler-2.5.9 after 5 seconds
1 gem installed
"""

# Rails install produces many transitive gems
RAILS_INSTALL_STDOUT = """\
Fetching activesupport-7.1.3.gem
Fetching actionpack-7.1.3.gem
Fetching actionview-7.1.3.gem
Fetching activemodel-7.1.3.gem
Fetching activerecord-7.1.3.gem
Fetching railties-7.1.3.gem
Fetching rails-7.1.3.gem
Building native extensions. This could take a while...
Successfully installed activesupport-7.1.3
Successfully installed actionpack-7.1.3
Successfully installed actionview-7.1.3
Successfully installed activemodel-7.1.3
Successfully installed activerecord-7.1.3
Successfully installed railties-7.1.3
Successfully installed rails-7.1.3
Parsing documentation for activesupport-7.1.3
Installing ri documentation for activesupport-7.1.3
Done installing documentation for activesupport-7.1.3 after 3 seconds
Parsing documentation for actionpack-7.1.3
Installing ri documentation for actionpack-7.1.3
Done installing documentation for actionpack-7.1.3 after 2 seconds
Parsing documentation for rails-7.1.3
Installing ri documentation for rails-7.1.3
Done installing documentation for rails-7.1.3 after 1 seconds
7 gems installed
"""

GEM_UPDATE_STDOUT = """\
Updating installed gems
Updating activesupport
Fetching activesupport-7.2.0.gem
Successfully installed activesupport-7.2.0
Parsing documentation for activesupport-7.2.0
Installing ri documentation for activesupport-7.2.0
Done installing documentation for activesupport-7.2.0 after 2 seconds
Gems updated: activesupport
"""

GEM_ERROR_STDOUT = """\
ERROR:  Could not find a valid gem 'nosuchgem' (>= 0) in any repository
ERROR:  Possible alternatives: no-such-gem
"""

GEM_PERMISSION_STDERR = """\
ERROR:  While executing gem ... (Gem::FilePermissionError)
    You don't have write permissions for the /usr/local/lib/ruby/gems directory.
"""

GEM_NOT_FOUND_STDOUT = """\
Fetching: nosuchgem (>= 0)
ERROR:  Could not find a valid gem 'nosuchgem' (>= 0) in any repository
"""

# ---------------------------------------------------------------------------
# GemFilter.matches — command detection
# ---------------------------------------------------------------------------


class TestGemFilterMatches:
    """GemFilter.matches() returns True only for the gem binary."""

    def test_gem_install(self) -> None:
        assert _FILTER.matches(["gem", "install", "rails"]) is True

    def test_gem_update(self) -> None:
        assert _FILTER.matches(["gem", "update"]) is True

    def test_gem_list(self) -> None:
        # list subcommand still matches (matches() checks binary only)
        assert _FILTER.matches(["gem", "list"]) is True

    def test_gem_uninstall(self) -> None:
        assert _FILTER.matches(["gem", "uninstall", "bundler"]) is True

    def test_gem_no_args(self) -> None:
        assert _FILTER.matches(["gem"]) is True

    def test_gem_exe_suffix(self) -> None:
        assert _FILTER.matches(["gem.exe", "install", "rails"]) is True

    def test_gem_cmd_suffix(self) -> None:
        assert _FILTER.matches(["gem.cmd", "install", "rails"]) is True

    def test_gem_full_path_windows(self) -> None:
        assert _FILTER.matches([r"C:\Ruby31\bin\gem.cmd", "install", "rails"]) is True

    def test_gem_full_path_unix(self) -> None:
        assert _FILTER.matches(["/usr/local/bin/gem", "install", "rails"]) is True

    def test_not_gemini(self) -> None:
        assert _FILTER.matches(["gemini", "run", "something"]) is False

    def test_not_python(self) -> None:
        assert _FILTER.matches(["python", "gem_tool.py"]) is False

    def test_empty_argv(self) -> None:
        assert _FILTER.matches([]) is False

    def test_not_gem_like_name(self) -> None:
        assert _FILTER.matches(["gemcraft", "run"]) is False


# ---------------------------------------------------------------------------
# bash_detect integration
# ---------------------------------------------------------------------------


class TestBashDetect:
    def test_detect_gem(self) -> None:
        assert detect(["gem", "install", "rails"]) == "gem"

    def test_detect_gem_exe(self) -> None:
        assert detect(["gem.exe", "install", "rails"]) == "gem"

    def test_detect_gem_cmd(self) -> None:
        assert detect(["gem.cmd", "update"]) == "gem"

    def test_select_filter_routes_to_gem(self) -> None:
        f = select_filter(["gem", "install", "rails"])
        assert f is not None
        assert isinstance(f, GemFilter)


# ---------------------------------------------------------------------------
# Content detection helpers (regression guards for regex patterns)
# ---------------------------------------------------------------------------


class TestGemRegexPatterns:
    """Direct regex pattern coverage checks."""

    from token_goat.bash_compress import (
        _GEM_DOC_RE,
        _GEM_ERROR_RE,
        _GEM_FETCH_RE,
        _GEM_SUCCESS_RE,
    )

    def test_fetch_re_matches_gem_file(self) -> None:
        from token_goat.bash_compress import _GEM_FETCH_RE
        assert _GEM_FETCH_RE.match("Fetching rails-7.1.3.gem")

    def test_fetch_re_matches_no_gem_extension(self) -> None:
        # "Fetching X" without .gem suffix should still match
        from token_goat.bash_compress import _GEM_FETCH_RE
        assert _GEM_FETCH_RE.match("Fetching bundler-2.5.9")

    def test_fetch_re_no_match_other(self) -> None:
        from token_goat.bash_compress import _GEM_FETCH_RE
        assert not _GEM_FETCH_RE.match("Successfully installed bundler-2.5.9")

    def test_doc_re_parsing(self) -> None:
        from token_goat.bash_compress import _GEM_DOC_RE
        assert _GEM_DOC_RE.match("Parsing documentation for rails-7.1.3")

    def test_doc_re_installing_ri(self) -> None:
        from token_goat.bash_compress import _GEM_DOC_RE
        assert _GEM_DOC_RE.match("Installing ri documentation for rails-7.1.3")

    def test_doc_re_done(self) -> None:
        from token_goat.bash_compress import _GEM_DOC_RE
        assert _GEM_DOC_RE.match("Done installing documentation for rails-7.1.3 after 2 seconds")

    def test_doc_re_no_match_success(self) -> None:
        from token_goat.bash_compress import _GEM_DOC_RE
        assert not _GEM_DOC_RE.match("Successfully installed rails-7.1.3")

    def test_success_re_matches(self) -> None:
        from token_goat.bash_compress import _GEM_SUCCESS_RE
        assert _GEM_SUCCESS_RE.match("Successfully installed rails-7.1.3")

    def test_error_re_matches_error_colon(self) -> None:
        from token_goat.bash_compress import _GEM_ERROR_RE
        assert _GEM_ERROR_RE.match("ERROR:  Could not find gem")

    def test_error_re_matches_no_write_perms(self) -> None:
        from token_goat.bash_compress import _GEM_ERROR_RE
        assert _GEM_ERROR_RE.match("You don't have write permissions for /usr/local")

    def test_error_re_matches_gem_colon(self) -> None:
        from token_goat.bash_compress import _GEM_ERROR_RE
        assert _GEM_ERROR_RE.match("gem: command failed")


# ---------------------------------------------------------------------------
# GemFilter.compress — main compression tests
# ---------------------------------------------------------------------------


class TestCompressGemInstall:
    """Core compression behaviour for gem install/update."""

    def test_empty_output_passthrough(self) -> None:
        result = _FILTER.compress("", "", 0, ["gem", "install", "rails"])
        assert result.strip() == ""

    def test_single_gem_fetching_dropped(self) -> None:
        result = _FILTER.compress(SINGLE_GEM_STDOUT, "", 0, ["gem", "install", "bundler"])
        assert not any(line.startswith("Fetching ") for line in result.splitlines())

    def test_single_gem_doc_noise_dropped(self) -> None:
        result = _FILTER.compress(SINGLE_GEM_STDOUT, "", 0, ["gem", "install", "bundler"])
        assert "Parsing documentation" not in result
        assert "Installing ri documentation" not in result
        assert "Done installing documentation" not in result

    def test_single_gem_success_kept(self) -> None:
        result = _FILTER.compress(SINGLE_GEM_STDOUT, "", 0, ["gem", "install", "bundler"])
        assert "Successfully installed bundler-2.5.9" in result

    def test_single_gem_summary_kept(self) -> None:
        result = _FILTER.compress(SINGLE_GEM_STDOUT, "", 0, ["gem", "install", "bundler"])
        assert "1 gem installed" in result

    def test_rails_fetching_dropped(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert not any(line.startswith("Fetching ") for line in result.splitlines())

    def test_rails_doc_noise_dropped(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "Parsing documentation" not in result
        assert "Installing ri documentation" not in result
        assert "Done installing documentation" not in result

    def test_rails_native_extension_kept(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "Building native extensions" in result

    def test_rails_summary_kept(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "7 gems installed" in result

    def test_rails_success_collapsed_with_marker(self) -> None:
        # 7 "Successfully installed" lines → first 2 + marker + last 1
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "Successfully installed activesupport-7.1.3" in result
        assert "Successfully installed actionpack-7.1.3" in result
        # Middle 4 elided
        assert "more installed" in result
        assert "Successfully installed rails-7.1.3" in result

    def test_rails_lines_removed(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        original_lines = [ln for ln in RAILS_INSTALL_STDOUT.splitlines() if ln]
        result_lines = [ln for ln in result.splitlines() if ln]
        assert len(result_lines) < len(original_lines)

    def test_compression_note_mentions_fetching(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "token-goat" in result
        assert "Fetching" in result

    def test_compression_note_mentions_documentation(self) -> None:
        result = _FILTER.compress(RAILS_INSTALL_STDOUT, "", 0, ["gem", "install", "rails"])
        assert "documentation" in result

    def test_gem_update_fetching_dropped(self) -> None:
        result = _FILTER.compress(GEM_UPDATE_STDOUT, "", 0, ["gem", "update"])
        # Progress lines start with "Fetching X"; note line says "dropped N Fetching lines"
        assert not any(line.startswith("Fetching ") for line in result.splitlines())

    def test_gem_update_success_kept(self) -> None:
        result = _FILTER.compress(GEM_UPDATE_STDOUT, "", 0, ["gem", "update"])
        assert "Successfully installed activesupport-7.2.0" in result

    def test_gem_update_summary_kept(self) -> None:
        result = _FILTER.compress(GEM_UPDATE_STDOUT, "", 0, ["gem", "update"])
        assert "Gems updated: activesupport" in result

    def test_error_output_kept(self) -> None:
        result = _FILTER.compress(GEM_ERROR_STDOUT, "", 1, ["gem", "install", "nosuchgem"])
        assert "Could not find a valid gem" in result

    def test_permission_error_in_stderr_kept(self) -> None:
        result = _FILTER.compress("", GEM_PERMISSION_STDERR, 1, ["gem", "install", "rails"])
        assert "write permissions" in result

    def test_not_found_error_line_kept(self) -> None:
        result = _FILTER.compress(GEM_NOT_FOUND_STDOUT, "", 1, ["gem", "install", "nosuchgem"])
        assert "Could not find a valid gem" in result

    def test_gem_list_passes_through(self) -> None:
        # gem list is not install/update, should pass through (capped)
        output = "*** LOCAL GEMS ***\n\nbundler (2.5.9)\nrails (7.1.3)\n"
        result = _FILTER.compress(output, "", 0, ["gem", "list"])
        assert "bundler" in result
        assert "rails" in result

    def test_gem_uninstall_passes_through(self) -> None:
        output = "Successfully uninstalled rails-7.1.3\n"
        result = _FILTER.compress(output, "", 0, ["gem", "uninstall", "rails"])
        assert "Successfully uninstalled" in result

    def test_few_gems_no_collapse(self) -> None:
        # Exactly 4 "Successfully installed" lines → all kept without collapse
        output = "\n".join([
            "Fetching a-1.0.gem",
            "Fetching b-1.0.gem",
            "Fetching c-1.0.gem",
            "Fetching d-1.0.gem",
            "Successfully installed a-1.0",
            "Successfully installed b-1.0",
            "Successfully installed c-1.0",
            "Successfully installed d-1.0",
            "4 gems installed",
        ]) + "\n"
        result = _FILTER.compress(output, "", 0, ["gem", "install", "a"])
        assert "Successfully installed a-1.0" in result
        assert "Successfully installed b-1.0" in result
        assert "Successfully installed c-1.0" in result
        assert "Successfully installed d-1.0" in result
        assert "more installed" not in result


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestGemFilterRegressions:
    """Edge cases and potential regression traps."""

    def test_gem_install_no_doc_flag_still_compresses(self) -> None:
        # --no-document suppresses doc lines; filter should still drop fetching
        output = (
            "Fetching rails-7.1.3.gem\n"
            "Successfully installed rails-7.1.3\n"
            "1 gem installed\n"
        )
        result = _FILTER.compress(output, "", 0, ["gem", "install", "--no-document", "rails"])
        # Progress lines start with "Fetching X"; note line says "dropped N Fetching lines"
        assert not any(line.startswith("Fetching ") for line in result.splitlines())
        assert "Successfully installed rails-7.1.3" in result
        assert "1 gem installed" in result

    def test_gem_install_already_installed_kept(self) -> None:
        # When gem is already installed, output is short and should pass through intact
        output = "Gem 'bundler' is already installed.\n"
        result = _FILTER.compress(output, "", 0, ["gem", "install", "bundler"])
        assert "already installed" in result

    def test_error_signal_line_kept_regardless_of_exit_code(self) -> None:
        # Even exit_code=0 should keep error-signal lines (inconsistent but possible)
        output = "ERROR:  Checksum mismatch for rails-7.1.3.gem\n"
        result = _FILTER.compress(output, "", 0, ["gem", "install", "rails"])
        assert "Checksum mismatch" in result

    def test_gem_upgrade_treated_as_install(self) -> None:
        output = (
            "Fetching bundler-2.6.0.gem\n"
            "Successfully installed bundler-2.6.0\n"
            "1 gem installed\n"
        )
        result = _FILTER.compress(output, "", 0, ["gem", "upgrade", "bundler"])
        assert not any(line.startswith("Fetching ") for line in result.splitlines())
        assert "Successfully installed bundler-2.6.0" in result

    def test_summary_line_follows_success_lines_in_output(self) -> None:
        """Regression: "N gems installed" must appear AFTER the success block.

        Deferred insertion of collapsed success_lines must not push them past
        summary lines that already landed in `kept` during the loop.
        """
        output = (
            "Fetching activesupport-7.1.3.gem\n"
            "Fetching rails-7.1.3.gem\n"
            "Successfully installed activesupport-7.1.3\n"
            "Successfully installed rails-7.1.3\n"
            "2 gems installed\n"
        )
        result = _FILTER.compress(output, "", 0, ["gem", "install", "rails"])
        lines = [ln for ln in result.splitlines() if ln.strip()]
        # Find positions of success and summary lines
        success_idx = next(i for i, ln in enumerate(lines) if "Successfully installed activesupport" in ln)
        summary_idx = next(i for i, ln in enumerate(lines) if "2 gems installed" in ln)
        assert success_idx < summary_idx, (
            f"Expected success lines before summary, got success_idx={success_idx} summary_idx={summary_idx}:\n"
            + "\n".join(lines)
        )

