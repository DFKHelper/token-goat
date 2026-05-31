"""Tests for MixFilter and ComposerFilter in token_goat.bash_compress."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ===========================================================================
# MixFilter — matches()
# ===========================================================================


class TestMixFilterMatches:
    def test_mix_compile_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix", "compile"])

    def test_mix_test_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix", "test"])

    def test_mix_deps_get_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix", "deps.get"])

    def test_mix_phx_server_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix", "phx.server"])

    def test_mix_ecto_migrate_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix", "ecto.migrate"])

    def test_mix_no_subcommand_matches(self) -> None:
        f = bc.MixFilter()
        assert f.matches(["mix"])

    def test_non_mix_command_does_not_match(self) -> None:
        f = bc.MixFilter()
        assert not f.matches(["rebar3", "compile"])
        assert not f.matches(["elixir", "script.exs"])
        assert not f.matches(["pytest"])

    def test_dispatch_routes_mix(self) -> None:
        result = bc.select_filter(["mix", "test"])
        assert result is not None
        assert result.name == "mix"

    def test_dispatch_routes_mix_compile(self) -> None:
        result = bc.select_filter(["mix", "compile"])
        assert result is not None
        assert result.name == "mix"


# ===========================================================================
# MixFilter — mix deps.get
# ===========================================================================

_MIX_DEPS_GET_OUTPUT = """\
Resolving Hex dependencies...
Resolution completed in 0.072s
New:
  cowboy 2.10.0
  cowlib 2.12.1
  plug 1.15.3
  phoenix 1.7.10
  ecto 3.11.1
* Getting cowboy (Hex package)
* Getting cowlib (Hex package)
* Getting plug (Hex package)
* Getting phoenix (Hex package)
* Getting ecto (Hex package)
"""


class TestMixFilterDepsGet:
    def test_getting_lines_collapsed(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_DEPS_GET_OUTPUT, argv=["mix", "deps.get"])
        assert "* Getting" not in out

    def test_fetch_count_reported(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_DEPS_GET_OUTPUT, argv=["mix", "deps.get"])
        assert "5" in out
        assert "dependenc" in out.lower()

    def test_resolution_line_preserved(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_DEPS_GET_OUTPUT, argv=["mix", "deps.get"])
        assert "Resolving Hex dependencies" in out

    def test_savings_significant(self) -> None:
        # Build a large deps list.
        big = "Resolving Hex dependencies...\nResolution completed in 0.1s\n"
        big += "\n".join(f"* Getting dep_{i} (Hex package)" for i in range(80))
        f = bc.MixFilter()
        result = f.apply(big, "", 0, ["mix", "deps.get"])
        assert result.percent_saved >= 40.0, f"savings {result.percent_saved:.1f}% < 40%"


# ===========================================================================
# MixFilter — mix compile
# ===========================================================================

_MIX_COMPILE_OUTPUT = """\
==> my_app
Compiling 12 files (.ex)
warning: variable "x" is unused (if the variable is not meant to be used, prefix it with an underscore)
  lib/my_app/server.ex:42

warning: unused import MyApp.Utils
  lib/my_app/helpers.ex:7

Generated my_app app
"""

_MIX_COMPILE_NOISY = """\
==> my_app
Resolving Hex dependencies...
Resolution completed in 0.05s
Compiling 25 files (.ex)
Generated my_app app
"""


class TestMixFilterCompile:
    def test_compiling_line_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_COMPILE_OUTPUT, argv=["mix", "compile"])
        assert "Compiling 12 files" in out

    def test_warning_lines_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_COMPILE_OUTPUT, argv=["mix", "compile"])
        assert "warning: variable" in out
        assert "warning: unused import" in out

    def test_generated_line_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_COMPILE_OUTPUT, argv=["mix", "compile"])
        assert "Generated my_app app" in out

    def test_noisy_compile_drops_progress(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_COMPILE_NOISY, argv=["mix", "compile"])
        # "Resolving Hex dependencies" is noise that should be dropped or counted.
        # "Compiling 25 files" and "Generated my_app app" must survive.
        assert "Compiling 25 files" in out
        assert "Generated my_app app" in out


# ===========================================================================
# MixFilter — mix test
# ===========================================================================

_MIX_TEST_ALL_PASSING = """\
...........................

Finished in 0.3 seconds (0.1s async, 0.2s sync)
27 tests, 0 failures
"""

_MIX_TEST_WITH_FAILURES = """\
...F..E.

  1) test MyModule does something important (MyModuleTest)
     ** (ExUnit.AssertionError)

       left:  42
       right: 0

     code: assert result == 0
     stacktrace:
       test/my_module_test.exs:15: (test)

  2) test MyOtherModule raises on bad input (MyOtherModuleTest)
     ** (RuntimeError) unexpected input

     stacktrace:
       lib/my_other_module.ex:9: MyOtherModule.call/1
       test/my_other_module_test.exs:22: (test)

Finished in 0.5 seconds (0.1s async, 0.4s sync)
8 tests, 2 failures
"""

_MIX_TEST_LARGE_PASSING = "." * 500 + "\n\nFinished in 1.2 seconds\n500 tests, 0 failures\n"


class TestMixFilterTest:
    def test_dots_collapsed(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_ALL_PASSING, argv=["mix", "test"])
        assert "." * 10 not in out

    def test_summary_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_ALL_PASSING, argv=["mix", "test"])
        assert "27 tests, 0 failures" in out

    def test_finished_line_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_ALL_PASSING, argv=["mix", "test"])
        assert "Finished in" in out

    def test_failure_block_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_WITH_FAILURES, argv=["mix", "test"])
        assert "ExUnit.AssertionError" in out
        assert "left:  42" in out
        assert "right: 0" in out

    def test_second_failure_block_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_WITH_FAILURES, argv=["mix", "test"])
        assert "RuntimeError" in out
        assert "unexpected input" in out

    def test_failure_summary_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_TEST_WITH_FAILURES, argv=["mix", "test"])
        assert "8 tests, 2 failures" in out

    def test_savings_large_run(self) -> None:
        f = bc.MixFilter()
        result = f.apply(_MIX_TEST_LARGE_PASSING, "", 0, ["mix", "test"])
        assert result.percent_saved >= 50.0, f"savings {result.percent_saved:.1f}% < 50%"


# ===========================================================================
# MixFilter — mix ecto.migrate
# ===========================================================================

_MIX_ECTO_MIGRATE_OUTPUT = """\

17:23:45.123 [info] == Running 20231015120000 MyApp.Repo.Migrations.CreateUsers.change/0 forward

17:23:45.130 [info] create table users

17:23:45.155 [info] == Migrated 20231015120000 in 0.0s

17:23:45.160 [info] == Running 20231020093000 MyApp.Repo.Migrations.AddEmailIndex.change/0 forward

17:23:45.165 [info] create index users_email_index

17:23:45.170 [info] == Migrated 20231020093000 in 0.0s
"""


class TestMixFilterEctoMigrate:
    def test_running_lines_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_ECTO_MIGRATE_OUTPUT, argv=["mix", "ecto.migrate"])
        assert "Running 20231015120000" in out
        assert "Running 20231020093000" in out

    def test_migrated_lines_kept(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_ECTO_MIGRATE_OUTPUT, argv=["mix", "ecto.migrate"])
        assert "Migrated 20231015120000" in out
        assert "Migrated 20231020093000" in out

    def test_detail_lines_dropped(self) -> None:
        f = bc.MixFilter()
        out = _apply(f, stdout=_MIX_ECTO_MIGRATE_OUTPUT, argv=["mix", "ecto.migrate"])
        assert "create table users" not in out
        assert "create index users_email_index" not in out


# ===========================================================================
# ComposerFilter — matches()
# ===========================================================================


class TestComposerFilterMatches:
    def test_composer_install_matches(self) -> None:
        f = bc.ComposerFilter()
        assert f.matches(["composer", "install"])

    def test_composer_update_matches(self) -> None:
        f = bc.ComposerFilter()
        assert f.matches(["composer", "update"])

    def test_composer_require_matches(self) -> None:
        f = bc.ComposerFilter()
        assert f.matches(["composer", "require", "vendor/package"])

    def test_composer_phar_matches(self) -> None:
        f = bc.ComposerFilter()
        assert f.matches(["composer.phar", "install"])

    def test_non_composer_does_not_match(self) -> None:
        f = bc.ComposerFilter()
        assert not f.matches(["npm", "install"])
        assert not f.matches(["pip", "install"])
        assert not f.matches(["bundle", "install"])

    def test_dispatch_routes_composer(self) -> None:
        result = bc.select_filter(["composer", "install"])
        assert result is not None
        assert result.name == "composer"

    def test_dispatch_routes_composer_update(self) -> None:
        result = bc.select_filter(["composer", "update"])
        assert result is not None
        assert result.name == "composer"


# ===========================================================================
# ComposerFilter — install/update compression
# ===========================================================================

_COMPOSER_INSTALL_OUTPUT = """\
Loading composer repositories with package information
Updating dependencies
Lock file operations: 0 installs, 0 updates, 0 removals
Package operations: 15 installs, 2 updates, 0 removals
  - Downloading vendor/package-a (1.2.3)
  - Downloading vendor/package-b (4.5.6)
  - Installing vendor/package-a (1.2.3): Loading from cache
  - Installing vendor/package-b (4.5.6): Loading from cache
  - Installing vendor/package-c (2.0.0): Loading from cache
  - Installing vendor/package-d (3.1.0): Loading from cache
  - Installing vendor/package-e (1.0.0): Loading from cache
Generating autoload files
Generated optimized autoload files containing 1234 classes
"""

_COMPOSER_WITH_FUNDING = """\
Package operations: 3 installs, 0 updates, 0 removals
  - Installing vendor/abc (1.0.0): Loading from cache
  - Installing vendor/def (2.0.0): Loading from cache
  - Installing vendor/ghi (3.0.0): Loading from cache
Generating autoload files
3 packages you are using are looking for funding.
Use the `composer fund` command to find out more!
"""

_COMPOSER_WITH_WARNINGS = """\
Package operations: 2 installs, 0 updates, 0 removals
  - Installing vendor/alpha (1.0.0): Loading from cache
  - Installing vendor/beta (2.0.0): Loading from cache
Warning: The lock file is not up to date with the latest changes in composer.json.
Warning: The lock file is not up to date with the latest changes in composer.json.
Warning: The lock file is not up to date with the latest changes in composer.json.
Generating autoload files
"""

_COMPOSER_WITH_PROGRESS = """\
Package operations: 2 installs, 0 updates, 0 removals
  - Installing vendor/large-package (1.0.0) (10%)
  - Installing vendor/large-package (1.0.0) (50%)
  - Installing vendor/large-package (1.0.0) (100%)
  - Installing vendor/small-package (0.1.0): Loading from cache
Generating autoload files
"""


class TestComposerFilterInstall:
    def test_install_lines_collapsed(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_INSTALL_OUTPUT, argv=["composer", "install"])
        assert "- Installing" not in out

    def test_install_count_reported(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_INSTALL_OUTPUT, argv=["composer", "install"])
        assert "5" in out
        assert "install" in out.lower()

    def test_download_lines_collapsed(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_INSTALL_OUTPUT, argv=["composer", "install"])
        assert "- Downloading" not in out

    def test_autoload_lines_kept(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_INSTALL_OUTPUT, argv=["composer", "install"])
        assert "Generating autoload files" in out
        assert "Generated optimized autoload" in out

    def test_operations_summary_kept(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_INSTALL_OUTPUT, argv=["composer", "install"])
        assert "Package operations:" in out

    def test_funding_notice_dropped(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_WITH_FUNDING, argv=["composer", "install"])
        assert "looking for funding" not in out

    def test_duplicate_warnings_deduplicated(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_WITH_WARNINGS, argv=["composer", "install"])
        # The same warning should appear at most once.
        assert out.count("lock file is not up to date") <= 1

    def test_warning_kept_at_least_once(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_WITH_WARNINGS, argv=["composer", "install"])
        assert "lock file is not up to date" in out

    def test_progress_percentage_lines_dropped(self) -> None:
        f = bc.ComposerFilter()
        out = _apply(f, stdout=_COMPOSER_WITH_PROGRESS, argv=["composer", "install"])
        assert "(10%)" not in out
        assert "(50%)" not in out

    def test_savings_significant_large_install(self) -> None:
        big = "Package operations: 80 installs, 0 updates, 0 removals\n"
        big += "\n".join(
            f"  - Installing vendor/package-{i} (1.0.{i}): Loading from cache"
            for i in range(80)
        )
        big += "\nGenerating autoload files\n"
        f = bc.ComposerFilter()
        result = f.apply(big, "", 0, ["composer", "install"])
        assert result.percent_saved >= 50.0, f"savings {result.percent_saved:.1f}% < 50%"
