"""Tests for NixFilter, HaskellFilter, and RCmdFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# NixFilter
# ---------------------------------------------------------------------------

_NIX_BUILD_SUCCESS = """\
these 5 paths will be fetched (12.34 MiB download, 45.67 MiB unpacked):
  /nix/store/aaaa-hello-2.12.1
  /nix/store/bbbb-glibc-2.35
fetching path '/nix/store/aaaa-hello-2.12.1'...
[1/5 (2.1 MiB DL)]
[2/5 (4.3 MiB DL)]
fetching path '/nix/store/bbbb-glibc-2.35'...
[3/5 (8.9 MiB DL)]
[4/5 (10.1 MiB DL)]
[5/5 (12.3 MiB DL)]
building '/nix/store/cccc-hello-2.12.1.drv'...
running phase 'buildPhase'
source $stdenv/setup
building '/nix/store/dddd-hello-wrapper.drv'...
/nix/store/eeee-hello-2.12.1
"""

_NIX_FLAKE_UPDATE = """\
Updated input 'nixpkgs':
  'github:NixOS/nixpkgs/abc123' (2024-01-01)
→ 'github:NixOS/nixpkgs/def456' (2024-01-10)
Updated input 'flake-utils':
  'github:numtide/flake-utils/111' (2023-12-01)
→ 'github:numtide/flake-utils/222' (2024-01-05)
writing modified lock file '/path/to/flake.lock'
"""

_NIX_ERROR = """\
building '/nix/store/xxxx-my-pkg.drv'...
error: builder for '/nix/store/xxxx-my-pkg.drv' failed with exit code 1;
       last 10 log lines:
       configure: error: cannot find required header
"""


class TestNixFilter:
    F = bc.NixFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_nix(self) -> None:
        assert self.F.matches(["nix", "build"])

    def test_matches_nix_build(self) -> None:
        assert self.F.matches(["nix-build", "."])

    def test_matches_nix_shell(self) -> None:
        assert self.F.matches(["nix-shell", "-p", "python3"])

    def test_matches_nix_env(self) -> None:
        assert self.F.matches(["nix-env", "-iA", "nixpkgs.hello"])

    def test_matches_nixos_rebuild(self) -> None:
        assert self.F.matches(["nixos-rebuild", "switch"])

    def test_no_match_make(self) -> None:
        assert not self.F.matches(["make", "all"])

    def test_no_match_npm(self) -> None:
        assert not self.F.matches(["npm", "install"])

    # --- select -----------------------------------------------------------

    def test_select_nix_build(self) -> None:
        assert isinstance(bc.select_filter(["nix-build", "."]), bc.NixFilter)

    def test_select_nix_shell(self) -> None:
        assert isinstance(bc.select_filter(["nix-shell"]), bc.NixFilter)

    # --- compress: success path -------------------------------------------

    def test_fetch_count_collapsed(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        assert "fetched/substituted" in out
        assert "2" in out  # two fetch lines

    def test_build_count_collapsed(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        assert "built" in out and "derivation" in out

    def test_progress_lines_dropped(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        # [1/5 ...] progress lines should be gone
        assert "[1/5" not in out
        assert "[5/5" not in out

    def test_sandbox_noise_dropped(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        assert "running phase" not in out
        assert "source $stdenv" not in out

    def test_result_store_path_kept(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        # The final result /nix/store/... line must be kept
        assert "/nix/store/eeee-hello-2.12.1" in out

    def test_paths_summary_kept(self) -> None:
        out = _compress(self.F, _NIX_BUILD_SUCCESS)
        assert "these 5 paths will be fetched" in out

    def test_flake_update_collapsed(self) -> None:
        out = _compress(self.F, _NIX_FLAKE_UPDATE)
        assert "flake lock update" in out or "collapsed" in out

    # --- compress: error path -------------------------------------------

    def test_error_preserved_on_failure(self) -> None:
        out = _compress(self.F, _NIX_ERROR, exit_code=1)
        assert "error: builder for" in out

    def test_error_signal_always_kept(self) -> None:
        out = _compress(self.F, _NIX_ERROR, exit_code=0)
        assert "error:" in out.lower()


# ---------------------------------------------------------------------------
# HaskellFilter
# ---------------------------------------------------------------------------

_CABAL_BUILD_SUCCESS = """\
Resolving dependencies...
Downloading servant-0.20 from Hackage...
Downloading base-4.17.0 from Hackage...
Configuring servant-0.20...
Configuring base-compat-0.13...
Preprocessing library for servant-0.20..
[ 1 of 42] Compiling Servant.API ()
[ 2 of 42] Compiling Servant.API.Alternative ()
[ 3 of 42] Compiling Servant.API.ContentTypes ()
[15 of 42] Compiling Servant.Server.Internal ()
[42 of 42] Compiling Servant ()
Linking dist/build/servant/servant ...
Installing library in /home/user/.cabal/lib/servant-0.20
Registering library
Completed 3 action(s).
"""

_STACK_BUILD_FAIL = """\
Resolving package versions...
[ 1 of 10] Compiling MyLib.Types
[ 2 of 10] Compiling MyLib.Api

src/MyLib/Api.hs:42:5: error:
    • Couldn't match type 'Int' with 'Text'
      Expected: Text
        Actual: Int
   |
42 |     myField = 42
   |               ^^
"""

_CABAL_WARNINGS = """\
Preprocessing library for mylib-0.1.0.0..
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Completed 1 action(s).
"""


class TestHaskellFilter:
    F = bc.HaskellFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_cabal(self) -> None:
        assert self.F.matches(["cabal", "build"])

    def test_matches_stack(self) -> None:
        assert self.F.matches(["stack", "build"])

    def test_matches_ghc(self) -> None:
        assert self.F.matches(["ghc", "Main.hs"])

    def test_matches_runghc(self) -> None:
        assert self.F.matches(["runghc", "script.hs"])

    def test_no_match_cargo(self) -> None:
        assert not self.F.matches(["cargo", "build"])

    def test_no_match_make(self) -> None:
        assert not self.F.matches(["make"])

    # --- select -----------------------------------------------------------

    def test_select_cabal(self) -> None:
        assert isinstance(bc.select_filter(["cabal", "build"]), bc.HaskellFilter)

    def test_select_stack(self) -> None:
        assert isinstance(bc.select_filter(["stack", "build"]), bc.HaskellFilter)

    # --- compress: success path -------------------------------------------

    def test_module_compilation_collapsed(self) -> None:
        out = _compress(self.F, _CABAL_BUILD_SUCCESS)
        assert "compiled" in out.lower() and "module" in out.lower()

    def test_resolve_download_collapsed(self) -> None:
        out = _compress(self.F, _CABAL_BUILD_SUCCESS)
        assert "dependency" in out.lower() or "resolution" in out.lower()

    def test_success_summary_kept(self) -> None:
        out = _compress(self.F, _CABAL_BUILD_SUCCESS)
        assert "Completed 3 action(s)" in out

    def test_linking_collapsed(self) -> None:
        out = _compress(self.F, _CABAL_BUILD_SUCCESS)
        # Linking / installing / registering are collapsed — not dropped silently
        assert "linking" in out.lower() or "collapsed" in out.lower() or "step" in out.lower()

    def test_individual_module_lines_removed(self) -> None:
        out = _compress(self.F, _CABAL_BUILD_SUCCESS)
        # Individual "[N of M] Compiling" lines should be collapsed
        assert "[ 1 of 42] Compiling" not in out
        assert "[42 of 42] Compiling" not in out

    # --- compress: failure path -------------------------------------------

    def test_ghc_error_kept(self) -> None:
        out = _compress(self.F, _STACK_BUILD_FAIL, exit_code=1)
        assert "Couldn't match type" in out
        assert "42:5: error" in out

    def test_error_preserved_on_failure(self) -> None:
        out = _compress(self.F, _STACK_BUILD_FAIL, exit_code=1)
        assert "error" in out.lower()

    # --- compress: warnings deduplication -----------------------------------

    def test_warning_dedup_keeps_first_three(self) -> None:
        out = _compress(self.F, _CABAL_WARNINGS)
        # Warning appears 4 times; first 3 should be kept
        occurrences = out.count("Module 'Data.MyLib.Internal'")
        assert occurrences == 3

    def test_warning_dedup_suppresses_fourth(self) -> None:
        out = _compress(self.F, _CABAL_WARNINGS)
        # Fourth occurrence must be deduplicated (marker emitted instead)
        assert "deduplicated" in out or "repeated" in out

    def test_success_summary_after_warnings_kept(self) -> None:
        out = _compress(self.F, _CABAL_WARNINGS)
        assert "Completed 1 action(s)" in out


# ---------------------------------------------------------------------------
# RCmdFilter
# ---------------------------------------------------------------------------

_R_CMD_CHECK_PASS = """\
* using R version 4.3.1 (2023-06-16)
* using platform: x86_64-pc-linux-gnu
* using session charset: UTF-8
* checking for file 'mypkg/DESCRIPTION' ... OK
* checking extension type ... Package
* this is package 'mypkg' version '1.0.0'
* checking package namespace information ... OK
* checking package dependencies ... OK
* checking if this is a source package ... OK
* checking if there is a namespace ... OK
* checking for executable files ... OK
* checking for hidden files and directories ... OK
* checking DESCRIPTION meta-information ... OK
* checking top-level files ... OK
* checking for left-over files ... OK
* checking index information ... OK
* checking package subdirectories ... OK
* checking R files for non-ASCII characters ... OK
* checking R files for syntax errors ... OK
* checking whether the package can be loaded ... OK
* checking whether the package can be loaded with stated dependencies ... OK
Loading required package: testthat
Attaching package: 'testthat'
* checking whether the package can be unloaded cleanly ... OK
* checking whether the namespace can be loaded with stated dependencies ... OK
* checking whether the namespace can be unloaded cleanly ... OK
* checking loading without being on the library search path ... OK
* checking use of SHLIB_EXT in Makefiles ... OK
* checking installed files from 'inst/doc' ... SKIPPED
* checking examples ... OK
* DONE (mypkg)

Status: OK
"""

_R_CMD_CHECK_NOTE = """\
* checking for file 'mypkg/DESCRIPTION' ... OK
* checking package dependencies ... OK
* checking if this is a source package ... OK
* checking R files for syntax errors ... OK
* checking whether the package can be loaded ... OK
Loading required package: dplyr
Attaching package: 'dplyr'
* checking examples ... OK
* DONE (mypkg)

Status: 1 NOTE
* checking DESCRIPTION meta-information ... NOTE
Non-standard license specification:
  MIT + file LICENSE
Standardizable: FALSE
"""

_R_CMD_CHECK_ERROR = """\
* checking for file 'mypkg/DESCRIPTION' ... OK
* checking package dependencies ... OK
* checking whether the package can be loaded ... OK
* running examples for arch 'x86_64'
  Running 'example.R' ... ERROR
Running examples in 'mypkg-Ex.R' failed
The error most likely occurred in:

> base::assign(".ptime", proc.time(), pos = "CheckExEnv")
> ### Name: my_function
> ### Title: My function
> my_function(NULL)
Error in my_function(NULL) : argument must not be NULL
"""


class TestRCmdFilter:
    F = bc.RCmdFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_r_cmd(self) -> None:
        assert self.F.matches(["R", "CMD", "check", "mypkg"])

    def test_matches_r_cmd_install(self) -> None:
        assert self.F.matches(["R", "CMD", "INSTALL", "."])

    def test_matches_rscript(self) -> None:
        assert self.F.matches(["Rscript", "-e", "devtools::check()"])

    def test_no_match_r_without_cmd(self) -> None:
        # Plain `R` without CMD should not match
        assert not self.F.matches(["R"])

    def test_no_match_ruby(self) -> None:
        assert not self.F.matches(["ruby", "script.rb"])

    def test_no_match_ruff(self) -> None:
        assert not self.F.matches(["ruff", "check"])

    # --- select -----------------------------------------------------------

    def test_select_r_cmd_check(self) -> None:
        assert isinstance(bc.select_filter(["R", "CMD", "check"]), bc.RCmdFilter)

    def test_select_rscript(self) -> None:
        assert isinstance(bc.select_filter(["Rscript", "-e", "devtools::check()"]), bc.RCmdFilter)

    # --- compress: passing run -------------------------------------------

    def test_ok_lines_collapsed(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_PASS)
        assert "OK/SKIPPED" in out or "checking" in out.lower()
        # Individual "checking ... OK" lines should not all be present
        assert out.count("... OK") < 20  # 20 OK lines in input, should be collapsed

    def test_done_line_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_PASS)
        assert "DONE (mypkg)" in out

    def test_status_ok_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_PASS)
        assert "Status: OK" in out

    def test_namespace_loading_dropped(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_PASS)
        # "Loading required package: testthat" and "Attaching package:" should be dropped
        assert "Loading required package" not in out
        assert "Attaching package" not in out

    def test_collapsed_count_marker_present(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_PASS)
        # At least one collapsed-count marker should be emitted
        assert "token-goat" in out

    # --- compress: NOTE / WARNING / ERROR -----------------------------------

    def test_note_detail_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_NOTE)
        assert "Non-standard license" in out

    def test_status_note_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_NOTE)
        assert "Status: 1 NOTE" in out

    def test_note_header_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_NOTE)
        assert "NOTE" in out

    def test_error_section_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_ERROR, exit_code=1)
        assert "Error in my_function" in out

    def test_running_examples_kept(self) -> None:
        out = _compress(self.F, _R_CMD_CHECK_ERROR, exit_code=1)
        assert "running examples" in out.lower() or "Running 'example.R'" in out
