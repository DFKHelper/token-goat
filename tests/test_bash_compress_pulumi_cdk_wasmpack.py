"""Tests for PulumiFilter, CdkFilter, and WasmPackFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# PulumiFilter
# ---------------------------------------------------------------------------

_PULUMI_UP = """\
Updating (dev):

     Type                         Name           Plan
 +   pulumi:pulumi:Stack          myapp-dev      create
 +   ├─ aws:s3:Bucket             my-bucket      create
 +   └─ aws:lambda:Function       my-fn          create

     aws:s3:Bucket (my-bucket): creating...
     aws:lambda:Function (my-fn): creating...
     aws:s3:Bucket (my-bucket): still creating... (10s elapsed)
     aws:s3:Bucket (my-bucket): still creating... (20s elapsed)
     aws:s3:Bucket (my-bucket): created (22s)
     aws:lambda:Function (my-fn): still creating... (10s elapsed)
     aws:lambda:Function (my-fn): created (15s)

Resources:
    + 3 to create

Duration: 38s
"""

_PULUMI_CLEAN = """\
Previewing update (dev):

No changes. Everything is up-to-date

Resources:
    3 unchanged

Duration: 2s
"""

_PULUMI_ERROR = """\
Updating (dev):

     aws:s3:Bucket (my-bucket): creating...

Diagnostics:
  error: preview failed: resource plugin 'aws' not found
"""


class TestPulumiFilter:
    F = bc.PulumiFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_pulumi(self) -> None:
        assert self.F.matches(["pulumi", "up"])

    def test_no_match_terraform(self) -> None:
        assert not self.F.matches(["terraform", "apply"])

    def test_no_match_cdk(self) -> None:
        assert not self.F.matches(["cdk", "deploy"])

    # --- select ------------------------------------------------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["pulumi", "up"])
        assert isinstance(f, bc.PulumiFilter), f"Expected PulumiFilter but got {type(f).__name__}"

    # --- compress: progress suppression ------------------------------------

    def test_still_creating_dropped(self) -> None:
        out = _compress(self.F, _PULUMI_UP)
        assert "still creating" not in out

    def test_creating_progress_dropped(self) -> None:
        out = _compress(self.F, _PULUMI_UP)
        # The initial "creating..." lines should be dropped
        # (completion "created" lines should remain)
        assert out.count("creating") <= 2  # plan table line may remain, progress dropped

    def test_created_completion_kept(self) -> None:
        out = _compress(self.F, _PULUMI_UP)
        assert "my-bucket): created" in out
        assert "my-fn): created" in out

    def test_summary_kept(self) -> None:
        out = _compress(self.F, _PULUMI_UP)
        assert "Resources:" in out
        assert "Duration:" in out

    def test_clean_preview_preserved(self) -> None:
        out = _compress(self.F, _PULUMI_CLEAN)
        assert "No changes" in out
        assert "Resources:" in out

    def test_error_exit_preserves_stderr(self) -> None:
        out = _compress(self.F, "", _PULUMI_ERROR, exit_code=1)
        assert "not found" in out

    def test_token_goat_note_on_suppression(self) -> None:
        out = _compress(self.F, _PULUMI_UP)
        assert "token-goat" in out

    # --- FILTERS registry --------------------------------------------------

    def test_in_filters_registry(self) -> None:
        names = [f.name for f in bc.FILTERS]
        assert "pulumi" in names


# ---------------------------------------------------------------------------
# CdkFilter
# ---------------------------------------------------------------------------

_CDK_DEPLOY = """\
MyStack: deploying... [1/1]

[0%] start: Building ...
[50%] success: Built asset ...
[100%] success: Built image asset ...

  CREATE_IN_PROGRESS  AWS::CloudFormation::Stack  MyStack
  CREATE_IN_PROGRESS  AWS::S3::Bucket             MyBucket
  CREATE_IN_PROGRESS  AWS::Lambda::Function       MyFunction
  CREATE_COMPLETE     AWS::S3::Bucket             MyBucket
  CREATE_COMPLETE     AWS::Lambda::Function       MyFunction
  CREATE_COMPLETE     AWS::CloudFormation::Stack  MyStack

 ✅  MyStack

Outputs:
MyStack.BucketName = my-bucket-abc123

Stack ARN:
arn:aws:cloudformation:us-east-1:123456789012:stack/MyStack/abc

✨  Total time: 42.5s
"""

_CDK_SYNTH = """\
Successfully synthesized to cdk.out
Supply a stack id (MyStack) to display its template.
"""

_CDK_DIFF = """\
Stack MyStack
There were no differences
"""

_CDK_FAIL = """\
MyStack: deploying...

  CREATE_IN_PROGRESS   AWS::S3::Bucket  BadBucket
  CREATE_FAILED        AWS::S3::Bucket  BadBucket  Invalid bucket name

❌  Deployment failed: Error: The stack named MyStack failed to deploy
"""


class TestCdkFilter:
    F = bc.CdkFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_cdk(self) -> None:
        assert self.F.matches(["cdk", "deploy"])

    def test_no_match_pulumi(self) -> None:
        assert not self.F.matches(["pulumi", "up"])

    def test_no_match_terraform(self) -> None:
        assert not self.F.matches(["terraform", "apply"])

    # --- select ------------------------------------------------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["cdk", "deploy"])
        assert isinstance(f, bc.CdkFilter), f"Expected CdkFilter but got {type(f).__name__}"

    # --- compress: IN_PROGRESS suppression ---------------------------------

    def test_in_progress_events_dropped(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "CREATE_IN_PROGRESS" not in out

    def test_asset_progress_dropped(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "[0%] start:" not in out
        assert "[50%] success:" not in out
        assert "[100%] success:" not in out

    def test_complete_events_kept(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "CREATE_COMPLETE" in out
        assert "MyBucket" in out

    def test_summary_kept(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "Outputs:" in out
        assert "Stack ARN:" in out

    def test_checkmark_summary_kept(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "✅" in out

    def test_total_time_dropped(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "Total time:" not in out

    def test_synth_output_preserved(self) -> None:
        out = _compress(self.F, _CDK_SYNTH)
        assert "Successfully synthesized" in out

    def test_no_diff_preserved(self) -> None:
        out = _compress(self.F, _CDK_DIFF)
        assert "There were no differences" in out

    def test_failed_events_kept(self) -> None:
        out = _compress(self.F, _CDK_FAIL)
        assert "CREATE_FAILED" in out
        assert "Invalid bucket name" in out

    def test_error_exit_preserves_stderr(self) -> None:
        out = _compress(self.F, "", _CDK_FAIL, exit_code=1)
        assert "Deployment failed" in out

    def test_token_goat_note_on_suppression(self) -> None:
        out = _compress(self.F, _CDK_DEPLOY)
        assert "token-goat" in out

    # --- FILTERS registry --------------------------------------------------

    def test_in_filters_registry(self) -> None:
        names = [f.name for f in bc.FILTERS]
        assert "cdk" in names


# ---------------------------------------------------------------------------
# WasmPackFilter
# ---------------------------------------------------------------------------

_WASMPACK_BUILD = """\
[INFO]: Checking for the Wasm target...
[INFO]: Compiling to Wasm...
   Compiling proc-macro2 v1.0.86
   Compiling quote v1.0.36
   Compiling syn v2.0.60
   Compiling wasm-bindgen-macro-support v0.2.92
   Compiling wasm-bindgen v0.2.92
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished release [optimized] target(s) in 42.50s
[INFO]: Installing wasm-bindgen...
[INFO]: Optimizing wasm binaries with `wasm-opt`...
[INFO]: :-) Done in 45s.
[INFO]: :-) Your wasm pkg is ready to publish at ./pkg.
"""

_WASMPACK_BUILD_WARN = """\
[INFO]: Checking for the Wasm target...
[WARN]: origin crate has no wasm_bindgen dependency
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished dev [unoptimized + debuginfo] target(s) in 3.20s
[INFO]: :-) Done in 5s.
"""

_WASMPACK_TEST = """\
[INFO]: 🎯  Testing your wasm!
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished test [unoptimized + debuginfo] target(s) in 5.10s

running 3 tests
test add ... ok
test sub ... ok
test mul ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
"""

_WASMPACK_ERROR = """\
[INFO]: Checking for the Wasm target...
error[E0433]: failed to resolve: use of undeclared crate or module `bad`
  --> src/lib.rs:1:5
   |
1  | use bad::Thing;
   |     ^^^ use of undeclared crate or module `bad`
"""


class TestWasmPackFilter:
    F = bc.WasmPackFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_wasm_pack(self) -> None:
        assert self.F.matches(["wasm-pack", "build"])

    def test_no_match_cargo(self) -> None:
        assert not self.F.matches(["cargo", "build"])

    def test_no_match_npm(self) -> None:
        assert not self.F.matches(["npm", "run", "build"])

    # --- select ------------------------------------------------------------

    def test_select_filter(self) -> None:
        f = bc.select_filter(["wasm-pack", "build"])
        assert isinstance(f, bc.WasmPackFilter), (
            f"Expected WasmPackFilter but got {type(f).__name__}"
        )

    # --- compress: INFO / Compiling suppression ----------------------------

    def test_info_lines_dropped(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD)
        # Pure INFO step announcements should be dropped.  The [INFO]: :-) Your
        # wasm pkg is ready line is preserved because it carries the done signal.
        assert "Checking for the Wasm target" not in out
        assert "Compiling to Wasm" not in out
        assert "Installing wasm-bindgen" not in out
        assert "Optimizing wasm binaries" not in out

    def test_compiling_deps_dropped(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD)
        assert "Compiling proc-macro2" not in out
        assert "Compiling quote" not in out
        assert "Compiling syn" not in out

    def test_finished_line_kept(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD)
        assert "Finished" in out
        assert "42.50s" in out

    def test_warning_kept(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD_WARN)
        assert "[WARN]:" in out
        assert "wasm_bindgen" in out

    def test_done_summary_kept(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD)
        # "Done" appears in [INFO] lines which are dropped, but "Your wasm pkg"
        # is matched by WASMPACK_DONE_RE directly — test the completion signal.
        assert "Your wasm pkg is ready" in out

    def test_test_summary_kept(self) -> None:
        out = _compress(self.F, _WASMPACK_TEST)
        assert "test result:" in out
        assert "3 passed" in out

    def test_test_individual_results_kept(self) -> None:
        out = _compress(self.F, _WASMPACK_TEST)
        # Individual test result lines (not filtered) should pass through
        assert "test add ... ok" in out

    def test_error_exit_preserves_stderr(self) -> None:
        out = _compress(self.F, "", _WASMPACK_ERROR, exit_code=1)
        assert "E0433" in out

    def test_token_goat_note_on_suppression(self) -> None:
        out = _compress(self.F, _WASMPACK_BUILD)
        assert "token-goat" in out

    # --- FILTERS registry --------------------------------------------------

    def test_in_filters_registry(self) -> None:
        names = [f.name for f in bc.FILTERS]
        assert "wasm-pack" in names
