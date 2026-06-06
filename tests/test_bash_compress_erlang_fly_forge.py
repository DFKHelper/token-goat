"""Tests for ErlangFilter, FlyFilter, and ForgeFilter."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# ErlangFilter
# ---------------------------------------------------------------------------

_REBAR3_COMPILE_SUCCESS = """\
===> Verifying dependencies
===> Analyzing applications
===> Compiling myapp
Compiling src/myapp_sup.erl
Compiling src/myapp_app.erl
Compiling src/myapp_server.erl
Compiling src/myapp_utils.erl
Compiling src/myapp_handler.erl
"""

_REBAR3_EUNIT_SUCCESS = """\
===> Verifying dependencies
===> Compiling myapp
===> Performing EUnit tests
  myapp_server_tests:server_starts_test...ok
  myapp_server_tests:server_handles_call_test...ok
  myapp_server_tests:server_stops_test...ok
  myapp_utils_tests:format_ok_test...ok
  myapp_utils_tests:parse_ok_test...ok
All 5 tests passed.
"""

_REBAR3_CT_FAIL = """\
===> Running Common Test suites
  myapp_SUITE:test_connect...FAILED
  Reason: timeout connecting to localhost:8080
  myapp_SUITE:test_query...ok
2 tests, 1 failed
"""

_REBAR3_DEPS = """\
===> Verifying dependencies
Fetching cowboy 2.9.0
Fetching ranch 2.1.0
Downloading cowlib 2.11.0
Already up-to-date: jsx
All dependencies already locked
"""


class TestErlangFilter(FilterTestMixin):
    F = bc.ErlangFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_rebar3(self) -> None:
        assert self.F.matches(["rebar3", "compile"])

    def test_matches_rebar3_eunit(self) -> None:
        assert self.F.matches(["rebar3", "eunit"])

    def test_matches_rebar3_ct(self) -> None:
        assert self.F.matches(["rebar3", "ct"])

    def test_matches_rebar(self) -> None:
        assert self.F.matches(["rebar", "compile"])

    def test_no_match_mix(self) -> None:
        assert not self.F.matches(["mix", "compile"])

    def test_no_match_erlc(self) -> None:
        # standalone erlc is not rebar3 output
        assert not self.F.matches(["erlc", "src/foo.erl"])

    # --- select ------------------------------------------------------------

    def test_select_rebar3(self) -> None:
        assert isinstance(bc.select_filter(["rebar3", "compile"]), bc.ErlangFilter)

    def test_select_rebar3_eunit(self) -> None:
        assert isinstance(bc.select_filter(["rebar3", "eunit"]), bc.ErlangFilter)

    # --- compress: compilation lines collapsed ----------------------------

    def test_compilation_lines_collapsed(self) -> None:
        out = _compress(self.F, _REBAR3_COMPILE_SUCCESS)
        assert ".erl compilation line(s) collapsed" in out

    def test_individual_erl_files_not_in_output(self) -> None:
        out = _compress(self.F, _REBAR3_COMPILE_SUCCESS)
        assert "myapp_sup.erl" not in out
        assert "myapp_handler.erl" not in out

    def test_compile_step_noise_dropped(self) -> None:
        out = _compress(self.F, _REBAR3_COMPILE_SUCCESS)
        assert "Verifying dependencies" not in out
        assert "Analyzing applications" not in out

    # --- compress: EUnit passing tests collapsed --------------------------

    def test_passing_eunit_tests_collapsed(self) -> None:
        out = _compress(self.F, _REBAR3_EUNIT_SUCCESS)
        assert "passing test line(s)" in out

    def test_individual_pass_lines_not_in_output(self) -> None:
        out = _compress(self.F, _REBAR3_EUNIT_SUCCESS)
        assert "server_starts_test" not in out
        assert "format_ok_test" not in out

    def test_summary_line_kept(self) -> None:
        out = _compress(self.F, _REBAR3_EUNIT_SUCCESS)
        assert "All 5 tests passed" in out

    # --- compress: CT failure lines kept ---------------------------------

    def test_failure_lines_kept(self) -> None:
        out = _compress(self.F, _REBAR3_CT_FAIL, exit_code=1)
        assert "FAILED" in out

    def test_failure_reason_kept(self) -> None:
        out = _compress(self.F, _REBAR3_CT_FAIL, exit_code=1)
        assert "timeout connecting" in out

    def test_failure_summary_kept(self) -> None:
        out = _compress(self.F, _REBAR3_CT_FAIL, exit_code=1)
        assert "1 failed" in out

    # --- compress: dependency fetch lines collapsed -----------------------

    def test_dep_fetch_lines_collapsed(self) -> None:
        out = _compress(self.F, _REBAR3_DEPS)
        assert "dependency-fetch line(s) collapsed" in out

    def test_dep_names_not_in_output(self) -> None:
        out = _compress(self.F, _REBAR3_DEPS)
        assert "Fetching cowboy" not in out
        assert "Downloading cowlib" not in out

    # --- compress: empty input -------------------------------------------



# ---------------------------------------------------------------------------
# FlyFilter
# ---------------------------------------------------------------------------

_FLY_DEPLOY_SUCCESS = """\
==> Building image with Docker
Sending build context to Docker daemon  12.54kB
Step 1/8 : FROM elixir:1.14-alpine
 ---> abc123def456
Step 2/8 : RUN mix deps.get
 ---> Using cache
 ---> def456abc789
Step 3/8 : COPY . .
 ---> 789abc123def
#4 CACHED [stage-1 5/6]
#5 DONE 2.1s
Successfully built deadbeef12ab
Successfully tagged registry.fly.io/myapp:latest
==> Releasing image
--> Waiting for machine 1234abcd to start
 Machine 1234abcd is now in a started state
--> Waiting for machine 5678efgh to start
 Machine 5678efgh is now in a started state
==> Monitoring deployment
Monitoring deployment (Ctrl-C to stop)
Deployed myapp v3 successfully
Visit your newly deployed app at https://myapp.fly.dev
"""

_FLY_DEPLOY_ERROR = """\
==> Building image with Docker
Step 1/4 : FROM python:3.11
Error response from daemon: pull access denied for python
"""

_FLY_DNS_NOISE = """\
Checking DNS configuration for myapp.fly.dev
Waiting for IPv4 address
Waiting for IPv6 address
The above IP address may need 1-2 minutes to propagate
"""


class TestFlyFilter(FilterTestMixin):
    F = bc.FlyFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_fly_deploy(self) -> None:
        assert self.F.matches(["fly", "deploy"])

    def test_matches_flyctl(self) -> None:
        assert self.F.matches(["flyctl", "deploy"])

    def test_matches_fly_status(self) -> None:
        assert self.F.matches(["fly", "status"])

    def test_matches_fly_scale(self) -> None:
        assert self.F.matches(["fly", "scale", "count", "3"])

    def test_no_match_docker(self) -> None:
        assert not self.F.matches(["docker", "build"])

    def test_no_match_heroku(self) -> None:
        assert not self.F.matches(["heroku", "deploy"])

    # --- select ------------------------------------------------------------

    def test_select_fly(self) -> None:
        assert isinstance(bc.select_filter(["fly", "deploy"]), bc.FlyFilter)

    def test_select_flyctl(self) -> None:
        assert isinstance(bc.select_filter(["flyctl", "deploy"]), bc.FlyFilter)

    # --- compress: Docker build steps collapsed ---------------------------

    def test_build_steps_collapsed(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "Docker build step line(s) collapsed" in out

    def test_individual_step_lines_not_in_output(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "Sending build context" not in out
        assert "Step 1/8" not in out
        assert "Step 2/8" not in out

    def test_image_id_lines_not_in_output(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "Successfully built deadbeef" not in out
        assert "Successfully tagged" not in out

    # --- compress: step headers always kept -------------------------------

    def test_step_headers_kept(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "==> Building image" in out
        assert "==> Releasing image" in out

    # --- compress: per-machine wait lines collapsed -----------------------

    def test_machine_wait_lines_collapsed(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "per-machine wait line(s) collapsed" in out

    def test_machine_ids_not_in_output(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "1234abcd" not in out
        assert "5678efgh" not in out

    # --- compress: deploy summary kept ------------------------------------

    def test_deploy_summary_kept(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_SUCCESS)
        assert "Deployed myapp v3 successfully" in out or "Visit your newly deployed" in out

    # --- compress: DNS noise dropped -------------------------------------

    def test_dns_noise_dropped(self) -> None:
        out = _compress(self.F, _FLY_DNS_NOISE)
        assert "Checking DNS configuration" not in out
        assert "Waiting for IPv4" not in out
        assert "Waiting for IPv6" not in out

    def test_dns_drop_noted(self) -> None:
        out = _compress(self.F, _FLY_DNS_NOISE)
        assert "DNS" in out.lower() or "noise" in out.lower() or "dropped" in out.lower()

    # --- compress: error output preserved ---------------------------------

    def test_error_preserved(self) -> None:
        out = _compress(self.F, _FLY_DEPLOY_ERROR, exit_code=1)
        assert "pull access denied" in out

    # --- compress: empty input -------------------------------------------



# ---------------------------------------------------------------------------
# ForgeFilter
# ---------------------------------------------------------------------------

_FORGE_BUILD_SUCCESS = """\
Compiling 12 files with solc 0.8.24
Compiling 3 Solidity files
Solc 0.8.24 finished in 4.21s
Solc 0.8.19 finished in 1.02s
Compiler run successful!
"""

_FORGE_TEST_SUCCESS = """\
Compiling 5 files with solc 0.8.24
Solc 0.8.24 finished in 2.10s
Compiler run successful!

Running 8 tests for test/Token.t.sol:TokenTest
[PASS] testTransfer() (gas: 52341)
[PASS] testApprove() (gas: 47123)
[PASS] testTransferFrom() (gas: 63412)
[PASS] testMint() (gas: 44532)
[PASS] testBurn() (gas: 39871)
[PASS] testBalanceOf() (gas: 25234)
[PASS] testAllowance() (gas: 28654)
[PASS] testTotalSupply() (gas: 22113)
Test result: ok. 8 passed; 0 failed; 0 skipped; finished in 1.34s

Ran 1 test suite in 3.45s (3.45s CPU time): 8 tests passed, 0 failed, 0 skipped (8 total tests)
"""

_FORGE_TEST_FAIL = """\
Compiling 3 files with solc 0.8.24
Solc 0.8.24 finished in 1.10s
Compiler run successful!

Running 3 tests for test/Vault.t.sol:VaultTest
[PASS] testDeposit() (gas: 44123)
[FAIL. Counterexample: calldata=0x..., args=[0]] testWithdraw() (gas: 31000)
  [FAIL] testWithdrawAll() (gas: 0)

Test result: FAILED. 1 passed; 2 failed; 0 skipped; finished in 0.54s
"""

_FORGE_GAS_REPORT = """\
Compiler run successful!
Running 2 tests for test/MyContract.t.sol:MyContractTest
[PASS] testFoo() (gas: 12345)
[PASS] testBar() (gas: 67890)
Test result: ok. 2 passed; 0 failed; 0 skipped

| Contract Name | Deployment Cost | Deployment Size |
|---------------|-----------------|-----------------|
| MyContract    | 234567          | 1234            |

| Function Name | min  | avg  | median | max  | # calls |
|---------------|------|------|--------|------|---------|
| foo           | 1234 | 1567 | 1400   | 2100 | 5       |
| bar           | 4321 | 4800 | 4600   | 5200 | 3       |
"""


class TestForgeFilter(FilterTestMixin):
    F = bc.ForgeFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_forge_build(self) -> None:
        assert self.F.matches(["forge", "build"])

    def test_matches_forge_test(self) -> None:
        assert self.F.matches(["forge", "test"])

    def test_matches_forge_script(self) -> None:
        assert self.F.matches(["forge", "script", "script/Deploy.s.sol"])

    def test_matches_forge_compile(self) -> None:
        assert self.F.matches(["forge", "compile"])

    def test_no_match_hardhat(self) -> None:
        assert not self.F.matches(["hardhat", "compile"])

    def test_no_match_npx_hardhat(self) -> None:
        assert not self.F.matches(["npx", "hardhat", "compile"])

    def test_no_match_foundry_cast(self) -> None:
        # cast is a different foundry binary — not forge
        assert not self.F.matches(["cast", "call"])

    # --- select ------------------------------------------------------------

    def test_select_forge(self) -> None:
        assert isinstance(bc.select_filter(["forge", "build"]), bc.ForgeFilter)

    def test_select_forge_test(self) -> None:
        assert isinstance(bc.select_filter(["forge", "test"]), bc.ForgeFilter)

    # --- compress: compilation lines collapsed ----------------------------

    def test_compile_step_lines_collapsed(self) -> None:
        out = _compress(self.F, _FORGE_BUILD_SUCCESS)
        assert "Solidity compilation step line(s) collapsed" in out

    def test_solc_timing_lines_collapsed(self) -> None:
        out = _compress(self.F, _FORGE_BUILD_SUCCESS)
        # Solc timing lines should be collapsed into the same counter
        assert "Compiling 12 files with solc" not in out
        assert "Solc 0.8.24 finished in" not in out

    def test_compile_done_kept(self) -> None:
        out = _compress(self.F, _FORGE_BUILD_SUCCESS)
        assert "Compiler run successful" in out

    # --- compress: passing tests collapsed --------------------------------

    def test_passing_tests_collapsed(self) -> None:
        out = _compress(self.F, _FORGE_TEST_SUCCESS)
        assert "passing test line(s)" in out

    def test_individual_pass_lines_not_in_output(self) -> None:
        out = _compress(self.F, _FORGE_TEST_SUCCESS)
        assert "[PASS] testTransfer()" not in out
        assert "[PASS] testMint()" not in out

    def test_test_suite_header_kept(self) -> None:
        out = _compress(self.F, _FORGE_TEST_SUCCESS)
        assert "Running 8 tests for" in out

    def test_test_summary_kept(self) -> None:
        out = _compress(self.F, _FORGE_TEST_SUCCESS)
        assert "Test result: ok" in out or "8 passed" in out

    def test_footer_kept(self) -> None:
        out = _compress(self.F, _FORGE_TEST_SUCCESS)
        assert "Ran 1 test suite" in out

    # --- compress: failure path -------------------------------------------

    def test_fail_lines_kept(self) -> None:
        out = _compress(self.F, _FORGE_TEST_FAIL, exit_code=1)
        assert "[FAIL" in out

    def test_fail_summary_kept(self) -> None:
        out = _compress(self.F, _FORGE_TEST_FAIL, exit_code=1)
        assert "2 failed" in out

    def test_pass_lines_collapsed_even_on_partial_failure(self) -> None:
        out = _compress(self.F, _FORGE_TEST_FAIL, exit_code=1)
        assert "[PASS] testDeposit()" not in out

    # --- compress: gas report table separator rows dropped ----------------

    def test_gas_table_separator_rows_dropped(self) -> None:
        out = _compress(self.F, _FORGE_GAS_REPORT)
        # Pure separator rows (|---|---|) should be gone
        assert "| MyContract    |" in out  # data row kept
        assert "|-----------" not in out   # separator dropped

    def test_gas_table_header_row_kept(self) -> None:
        out = _compress(self.F, _FORGE_GAS_REPORT)
        # "| Function Name | min | avg ..." header row is structural — kept
        assert "Function Name" in out

    def test_gas_separator_note_emitted(self) -> None:
        out = _compress(self.F, _FORGE_GAS_REPORT)
        assert "gas-report table separator row(s)" in out

    # --- compress: empty input -------------------------------------------

