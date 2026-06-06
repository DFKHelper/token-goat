"""Tests for WranglerFilter, HardhatFilter, and ServerlessFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# WranglerFilter
# ---------------------------------------------------------------------------

_WRANGLER_DEPLOY_LARGE = """\
wrangler 3.45.0
Building...
Bundling with esbuild...
+ /index.html (1234 bytes)
+ /styles/main.css (5678 bytes)
+ /assets/logo.png (23456 bytes)
+ /assets/hero.jpg (98765 bytes)
+ /js/app.js (45678 bytes)
+ /js/vendor.js (123456 bytes)
Total Upload: 298.3 KiB / gzip: 79.4 KiB
Uploaded my-worker (0.47 sec)
Deployed my-worker
  https://my-worker.example.workers.dev
"""

_WRANGLER_SKIP_ASSETS = """\
wrangler 3.45.0
3 assets already up to date
Uploaded my-worker (0.12 sec)
Deployed my-worker
  https://my-worker.example.workers.dev
"""

_WRANGLER_ERROR = """\
wrangler 3.45.0
Building...
"""


class TestWranglerFilter:
    F = bc.WranglerFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_wrangler(self) -> None:
        assert self.F.matches(["wrangler", "deploy"])

    def test_matches_wrangler2(self) -> None:
        assert self.F.matches(["wrangler2", "publish"])

    def test_no_match_npm(self) -> None:
        assert not self.F.matches(["npm", "run", "deploy"])

    def test_no_match_cdk(self) -> None:
        assert not self.F.matches(["cdk", "deploy"])

    # --- select ------------------------------------------------------------

    def test_select_wrangler(self) -> None:
        assert isinstance(bc.select_filter(["wrangler", "deploy"]), bc.WranglerFilter)

    def test_select_wrangler2(self) -> None:
        assert isinstance(bc.select_filter(["wrangler2", "publish"]), bc.WranglerFilter)

    # --- compress: upload lines collapsed ----------------------------------

    def test_upload_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_DEPLOY_LARGE)
        assert "6 asset upload line(s) collapsed" in out

    def test_upload_lines_not_in_output(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_DEPLOY_LARGE)
        # Individual file paths should not appear
        assert "/index.html" not in out
        assert "/assets/logo.png" not in out

    def test_build_step_noise_dropped(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_DEPLOY_LARGE)
        assert "Building..." not in out
        assert "Bundling with esbuild" not in out

    def test_summary_lines_kept(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_DEPLOY_LARGE)
        assert "Total Upload:" in out
        assert "Deployed my-worker" in out
        assert "workers.dev" in out

    def test_skip_assets_collapsed(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_SKIP_ASSETS)
        assert "skip" in out.lower() or "already up to date" in out or "asset-skip" in out

    def test_error_output_preserved(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_ERROR, stderr="Error: Script not found", exit_code=1)
        assert "Error: Script not found" in out

    def test_error_on_exit_code_nonzero(self) -> None:
        out = _compress(self.F, stdout="wrangler 3.45.0\n", stderr="Error: invalid config", exit_code=1)
        assert "Error: invalid config" in out

    def test_build_step_note_in_output(self) -> None:
        out = _compress(self.F, stdout=_WRANGLER_DEPLOY_LARGE)
        assert "build-step noise" in out


# ---------------------------------------------------------------------------
# HardhatFilter
# ---------------------------------------------------------------------------

_HARDHAT_COMPILE_OUTPUT = """\
Compiling 12 files with Solc 0.8.24
Compiling 3 files with Solc 0.8.20
Solc 0.8.24 finished in 4.50s
Solc 0.8.20 finished in 1.20s
Compilation finished successfully
"""

_HARDHAT_TEST_OUTPUT = """\
Compiling 5 files with Solc 0.8.24
Solc 0.8.24 finished in 2.10s
Compilation finished successfully

  Token
    Deployment
      ✓ should transfer tokens (45ms)
      ✓ should fail on zero address (12ms)
      ✓ should emit Transfer event (31ms)
    Admin
      ✓ should set owner (8ms)

  4 passing (2s)
"""

_HARDHAT_FAILING_TESTS = """\
Compiling 2 files with Solc 0.8.24
Compilation finished successfully

  Token
    ✓ should mint correctly (23ms)

    1) should transfer tokens

  1 passing (1s)
  1 failing

  1) Token should transfer tokens:
     AssertionError: expected 0 to equal 100
"""

_HARDHAT_DEPLOY_SCRIPT = """\
Deploying MyToken...
deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Gas used: 1234567
Transaction hash: 0xabc123def456
Block number: 12345678
MyToken deployed to: 0x5FbDB2315678afecb367f032d93F642f64180aa3
Deploying MyGovernor...
MyGovernor deployed to: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
"""


class TestHardhatFilter:
    F = bc.HardhatFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_hardhat(self) -> None:
        assert self.F.matches(["hardhat", "compile"])

    def test_matches_npx_hardhat(self) -> None:
        # After _strip_prefixes, npx hardhat → hardhat
        assert isinstance(bc.select_filter(["npx", "hardhat", "test"]), bc.HardhatFilter)

    def test_no_match_truffle(self) -> None:
        assert not self.F.matches(["truffle", "compile"])

    def test_no_match_forge(self) -> None:
        assert not self.F.matches(["forge", "test"])

    # --- select ------------------------------------------------------------

    def test_select_hardhat(self) -> None:
        assert isinstance(bc.select_filter(["hardhat", "compile"]), bc.HardhatFilter)

    def test_select_npx_hardhat(self) -> None:
        assert isinstance(bc.select_filter(["npx", "hardhat", "test"]), bc.HardhatFilter)

    # --- compile path -----------------------------------------------------

    def test_compile_step_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_COMPILE_OUTPUT)
        assert "collapsed" in out
        assert "Solidity compilation step" in out

    def test_solc_timing_collapsed(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_COMPILE_OUTPUT)
        assert "Solc per-version timing" in out

    def test_compile_finished_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_COMPILE_OUTPUT)
        assert "Compilation finished successfully" in out

    def test_compile_lines_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_COMPILE_OUTPUT)
        assert "Compiling 12 files" not in out
        assert "Solc 0.8.24 finished in 4.50s" not in out

    # --- test path --------------------------------------------------------

    def test_passing_tests_collapsed(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_TEST_OUTPUT)
        assert "passing test line(s)" in out

    def test_passing_checkmarks_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_TEST_OUTPUT)
        assert "should transfer tokens" not in out

    def test_test_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_TEST_OUTPUT)
        assert "4 passing" in out

    def test_describe_block_headers_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_TEST_OUTPUT)
        assert "Token" in out
        assert "Deployment" in out

    # --- failing tests path -----------------------------------------------

    def test_failing_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_FAILING_TESTS)
        assert "1 failing" in out

    def test_assertion_error_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_FAILING_TESTS)
        assert "AssertionError" in out

    # --- deploy script path -----------------------------------------------

    def test_deploy_header_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_DEPLOY_SCRIPT)
        assert "Deploying MyToken" in out

    def test_deployed_to_address_kept(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_DEPLOY_SCRIPT)
        assert "MyToken deployed to:" in out

    def test_tx_noise_dropped(self) -> None:
        out = _compress(self.F, stdout=_HARDHAT_DEPLOY_SCRIPT)
        assert "transaction receipt noise" in out
        # Individual noise fields should be gone
        assert "Gas used:" not in out
        assert "Transaction hash:" not in out
        assert "Block number:" not in out

    # --- error path -------------------------------------------------------

    def test_error_on_stderr_exit_code(self) -> None:
        out = _compress(
            self.F,
            stdout="",
            stderr="Error HH303: Unrecognized task run\n",
            exit_code=1,
        )
        assert "HH303" in out


# ---------------------------------------------------------------------------
# ServerlessFilter
# ---------------------------------------------------------------------------

_SLS_DEPLOY_FULL = """\
Serverless: Packaging service...
Serverless: Excluding development dependencies...
Serverless: Creating Stack...
Serverless: Checking Stack create progress...
........
Serverless: Stack create finished...
Serverless: Uploading CloudFormation file to S3...
Serverless: Uploading artifacts...
Serverless: Uploading service myservice.zip file to S3 (11.1 MB)...
Serverless: Validating template...
Serverless: Updating Stack...
Serverless: Checking Stack update progress...
.................
  UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
  CREATE_IN_PROGRESS  AWS::IAM::Role  IamRoleLambdaExecution
  CREATE_COMPLETE  AWS::IAM::Role  IamRoleLambdaExecution
  CREATE_IN_PROGRESS  AWS::Lambda::Function  hello
  CREATE_COMPLETE  AWS::Lambda::Function  hello
  UPDATE_COMPLETE  AWS::CloudFormation::Stack  myservice-dev
Serverless: Stack update finished...
Service deployed to stack myservice-dev (42s)

Service Information
service: myservice
stage: dev
region: us-east-1
stack: myservice-dev
endpoints:
  GET - https://abc123.execute-api.us-east-1.amazonaws.com/dev/hello
functions:
  hello: myservice-dev-hello
"""

_SLS_DEPLOY_FAILURE = """\
Serverless: Packaging service...
Serverless: Updating Stack...
  UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
  CREATE_FAILED  AWS::Lambda::Function  hello  Resource handler returned message: "Invalid code"
  UPDATE_ROLLBACK_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
"""


class TestServerlessFilter:
    F = bc.ServerlessFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_serverless(self) -> None:
        assert self.F.matches(["serverless", "deploy"])

    def test_matches_sls(self) -> None:
        assert self.F.matches(["sls", "deploy"])

    def test_no_match_cdk(self) -> None:
        assert not self.F.matches(["cdk", "deploy"])

    def test_no_match_pulumi(self) -> None:
        assert not self.F.matches(["pulumi", "up"])

    # --- select ------------------------------------------------------------

    def test_select_serverless(self) -> None:
        assert isinstance(bc.select_filter(["serverless", "deploy"]), bc.ServerlessFilter)

    def test_select_sls(self) -> None:
        assert isinstance(bc.select_filter(["sls", "deploy"]), bc.ServerlessFilter)

    # --- compress: step lines ---------------------------------------------

    def test_step_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "Serverless deploy step line(s)" in out

    def test_packaging_line_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "Serverless: Packaging service" not in out

    def test_uploading_line_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "Serverless: Uploading CloudFormation" not in out

    # --- compress: CF events ----------------------------------------------

    def test_in_progress_events_dropped(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        # Individual IN_PROGRESS event lines should not appear verbatim;
        # the compression note mentions "_IN_PROGRESS" in a summary line, that is fine.
        # Check that the actual event lines (with leading spaces and resource types) are gone.
        assert "CREATE_IN_PROGRESS  AWS::IAM::Role" not in out
        assert "UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack" not in out

    def test_complete_events_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "CREATE_COMPLETE" in out
        assert "UPDATE_COMPLETE" in out

    def test_dot_progress_dropped(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "polling dot" in out

    # --- compress: service info -------------------------------------------

    def test_deploy_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "Service deployed to stack myservice-dev" in out

    def test_service_info_section_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "Service Information" in out
        assert "service: myservice" in out
        assert "stage: dev" in out

    def test_endpoint_url_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "execute-api.us-east-1.amazonaws.com" in out

    def test_function_list_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FULL)
        assert "hello: myservice-dev-hello" in out

    # --- compress: failure path -------------------------------------------

    def test_failed_cf_event_kept(self) -> None:
        out = _compress(self.F, stdout=_SLS_DEPLOY_FAILURE)
        assert "CREATE_FAILED" in out
        assert "Invalid code" in out

    def test_error_on_stderr_exit_code(self) -> None:
        out = _compress(
            self.F,
            stdout="",
            stderr="Error: Your AWS credentials are invalid\n",
            exit_code=1,
        )
        assert "AWS credentials" in out

    # --- compression ratio ------------------------------------------------

    def test_significant_compression(self) -> None:
        result = bc.ServerlessFilter().apply(_SLS_DEPLOY_FULL, "", 0, ["serverless"])
        # At least 30% reduction on a typical full deploy output
        assert result.compressed_bytes < result.original_bytes * 0.75
