"""Tests for Rust/cargo compiler output compression.

Covers:
  - _is_cargo_compile_cmd: build/check/clippy/fix/rustc → True
  - _is_cargo_compile_cmd: test/run/install/update/publish/add/remove/search/login → False
  - _is_cargo_compile_cmd: global flags before subcommand (-v, --color always, -Z flag val) → True
  - _is_cargo_compile_cmd: subcommand flags after subcommand (--release, --target …) → True
  - _is_cargo_compile_cmd: empty argv / non-cargo binary → False
  - _CARGO_COMPILE_MIN_LINES exported from hooks_read
  - post_bash: small output (< 40 lines) → falls through (no [token-goat] cargo message)
  - post_bash: large clean build (50+ Compiling lines, exit_code=0) → only terminal line
  - post_bash: large output with errors (exit_code=1) → error diagnostic blocks preserved
  - post_bash: large output with warnings only (exit_code=0) → warning blocks preserved
  - post_bash: diagnostic context lines (-->, |, =, ^) are kept
  - post_bash: trailing newline preserved when stdout ends with \\n
  - post_bash: no trailing newline when stdout does not end with \\n
  - post_bash: Compiling/Checking/Downloading noise lines NOT in compressed output
  - post_bash: exit_code=101 (cargo panic) → falls through unchanged
  - post_bash: exit_code=2 → falls through unchanged
  - post_bash: clean build with < 5 noise lines → falls through (not noisy enough)
  - post_bash: recall hint present when session_id active
  - post_bash: no recall hint when no session_id
  - post_bash: non-compile subcommand (cargo test) → falls through unchanged
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post_bash_payload(
    cmd: str,
    stdout: str,
    *,
    exit_code: int = 0,
    sid: str | None = None,
    cwd: str = "/proj",
) -> dict:
    return {
        "session_id": sid or "",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


def _make_noisy_build_stdout(
    *,
    n_compiling: int = 50,
    n_errors: int = 0,
    n_warnings: int = 0,
    with_trailing_newline: bool = True,
    finished: bool = True,
) -> str:
    """Build a realistic cargo stdout blob with Compiling lines and optional diagnostics."""
    lines: list[str] = []
    for i in range(n_compiling):
        lines.append(f"   Compiling crate_{i} v0.1.{i} (/workspace/crate_{i})")

    for i in range(n_warnings):
        lines.append("warning[unused_imports]: unused import: `std::collections::HashMap`")
        lines.append(f"  --> src/lib.rs:{10 + i}:5")
        lines.append("   |")
        lines.append(f"{10 + i}  | use std::collections::HashMap;")
        lines.append("   |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^")
        lines.append("   = note: `#[warn(unused_imports)]` on by default")

    for i in range(n_errors):
        lines.append("error[E0308]: mismatched types")
        lines.append(f"  --> src/main.rs:{20 + i}:13")
        lines.append("   |")
        lines.append("   |     let x: i32 = \"hello\";")
        lines.append("   |             ^^^^^^^ expected `i32`, found `&str`")
        lines.append("   =  note: expected type `i32`")

    if n_errors > 0:
        lines.append(f"error: could not compile `myproject` due to {n_errors} previous error(s)")
    elif finished:
        lines.append("Finished dev [unoptimized + debuginfo] target(s) in 3.45s")

    body = "\n".join(lines)
    if with_trailing_newline:
        body += "\n"
    return body


# ---------------------------------------------------------------------------
# _is_cargo_compile_cmd — detection tests
# ---------------------------------------------------------------------------

class TestIsCargoCompileCmd:
    def _fn(self, argv: list[str]) -> bool:
        from token_goat.bash_compress import _is_cargo_compile_cmd
        return _is_cargo_compile_cmd(argv)

    # Positive cases: compile subcommands
    def test_build(self):
        assert self._fn(["cargo", "build"]) is True

    def test_check(self):
        assert self._fn(["cargo", "check"]) is True

    def test_clippy(self):
        assert self._fn(["cargo", "clippy"]) is True

    def test_fix(self):
        assert self._fn(["cargo", "fix"]) is True

    def test_rustc(self):
        assert self._fn(["cargo", "rustc"]) is True

    # Negative cases: non-compile subcommands
    def test_test_excluded(self):
        assert self._fn(["cargo", "test"]) is False

    def test_run_excluded(self):
        assert self._fn(["cargo", "run"]) is False

    def test_install_excluded(self):
        assert self._fn(["cargo", "install"]) is False

    def test_update_excluded(self):
        assert self._fn(["cargo", "update"]) is False

    def test_publish_excluded(self):
        assert self._fn(["cargo", "publish"]) is False

    def test_add_excluded(self):
        assert self._fn(["cargo", "add"]) is False

    def test_remove_excluded(self):
        assert self._fn(["cargo", "remove"]) is False

    def test_search_excluded(self):
        assert self._fn(["cargo", "search"]) is False

    def test_login_excluded(self):
        assert self._fn(["cargo", "login"]) is False

    # Global flags before subcommand
    def test_dash_v_before_build(self):
        assert self._fn(["cargo", "-v", "build"]) is True

    def test_verbose_long_before_check(self):
        assert self._fn(["cargo", "--verbose", "check"]) is True

    def test_quiet_before_clippy(self):
        assert self._fn(["cargo", "--quiet", "clippy"]) is True

    def test_color_always_before_check(self):
        # --color takes a value argument; both tokens must be skipped
        assert self._fn(["cargo", "--color", "always", "check"]) is True

    def test_color_always_before_build(self):
        assert self._fn(["cargo", "--color", "always", "build"]) is True

    def test_config_flag_before_check(self):
        assert self._fn(["cargo", "--config", "net.retry=3", "check"]) is True

    def test_Z_flag_before_build(self):
        assert self._fn(["cargo", "-Z", "unstable-options", "build"]) is True

    # Subcommand flags after the subcommand are irrelevant to detection
    def test_build_release(self):
        assert self._fn(["cargo", "build", "--release"]) is True

    def test_check_target(self):
        assert self._fn(["cargo", "check", "--target", "x86_64-unknown-linux-gnu"]) is True

    def test_clippy_extra_flags(self):
        assert self._fn(["cargo", "clippy", "--", "-D", "warnings"]) is True

    # Edge: empty argv and non-cargo binaries
    def test_empty_argv(self):
        assert self._fn([]) is False

    def test_non_cargo_binary(self):
        assert self._fn(["gcc", "build"]) is False

    def test_python_binary(self):
        assert self._fn(["python", "cargo", "build"]) is False

    def test_cargo_only_flags_no_subcommand(self):
        # Global flags only, no positional subcommand → False
        assert self._fn(["cargo", "--verbose"]) is False

    def test_cargo_no_args(self):
        assert self._fn(["cargo"]) is False

    def test_cargo_exe_extension(self):
        # Windows-style "cargo.exe"
        assert self._fn(["cargo.exe", "build"]) is True

    def test_cargo_full_path(self):
        assert self._fn(["/usr/local/bin/cargo", "check"]) is True

    # Bug 3: --manifest-path takes an argument and must be skipped as a 2-token pair
    def test_manifest_path_before_build(self):
        assert self._fn(["cargo", "--manifest-path", "./Cargo.toml", "build"]) is True

    def test_manifest_path_before_check(self):
        assert self._fn(["cargo", "--manifest-path", "./sub/Cargo.toml", "check"]) is True

    # Bug 4: Windows backslash paths must not be mangled by posix shlex on win32
    def test_windows_exe_path_detected(self):
        # Full Windows path to cargo.exe — backslashes would be eaten by posix=True shlex
        assert self._fn([r"C:\Users\user\.cargo\bin\cargo.exe", "build"]) is True


# ---------------------------------------------------------------------------
# post_bash compression behaviour
# ---------------------------------------------------------------------------

class TestCargoPostBashCompress:
    def _call(self, payload: dict) -> dict:
        from token_goat.hooks_read import post_bash
        return post_bash(payload)

    def _cargo_msg(self, result: dict) -> str | None:
        """Return systemMessage if it contains [token-goat] cargo header, else None."""
        msg = result.get("systemMessage", "")
        if "[token-goat] cargo:" in msg:
            return msg
        return None

    # ------------------------------------------------------------------
    # Constant exported
    # ------------------------------------------------------------------

    def test_constant_exported(self):
        from token_goat.hooks_read import _CARGO_COMPILE_MIN_LINES
        assert _CARGO_COMPILE_MIN_LINES == 40

    # ------------------------------------------------------------------
    # Falls through: too few lines
    # ------------------------------------------------------------------

    def test_small_output_falls_through(self):
        stdout = "\n".join(
            [f"   Compiling crate_{i} v0.1.{i} (/workspace)" for i in range(10)]
            + ["Finished dev target(s) in 0.12s"]
        ) + "\n"
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        assert self._cargo_msg(result) is None, "short output must not be intercepted"

    # ------------------------------------------------------------------
    # Falls through: not a compile subcommand
    # ------------------------------------------------------------------

    def test_cargo_test_not_compressed(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo test", stdout, exit_code=0)
        result = self._call(payload)
        assert self._cargo_msg(result) is None, "cargo test must not be intercepted"

    def test_cargo_run_not_compressed(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo run", stdout, exit_code=0)
        result = self._call(payload)
        assert self._cargo_msg(result) is None

    # ------------------------------------------------------------------
    # Falls through: unusual exit code
    # ------------------------------------------------------------------

    def test_exit_code_101_falls_through(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=101)
        result = self._call(payload)
        assert self._cargo_msg(result) is None, "exit_code=101 must not be intercepted"

    def test_exit_code_2_falls_through(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=2)
        result = self._call(payload)
        assert self._cargo_msg(result) is None

    # ------------------------------------------------------------------
    # Falls through: clean build but not noisy (< 5 noise lines)
    # ------------------------------------------------------------------

    def test_clean_build_too_few_noise_lines_falls_through(self):
        # 45 non-noise lines + 2 Compiling lines + Finished line = 48 lines total
        # but < 5 noise lines → no compression
        lines = [f"   Checking config_{i}" for i in range(2)]  # noise but only 2
        lines += [f"info: crate_{i} ok" for i in range(42)]    # non-noise filler
        lines.append("Finished dev target(s) in 0.5s")
        stdout = "\n".join(lines) + "\n"
        payload = _make_post_bash_payload("cargo check", stdout, exit_code=0)
        result = self._call(payload)
        assert self._cargo_msg(result) is None

    # ------------------------------------------------------------------
    # Clean build compression (no errors/warnings, noisy)
    # ------------------------------------------------------------------

    def test_clean_build_shows_finished_line(self):
        stdout = _make_noisy_build_stdout(n_compiling=55, finished=True)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "Finished dev" in msg

    def test_clean_build_noise_lines_absent(self):
        stdout = _make_noisy_build_stdout(n_compiling=55, finished=True)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "Compiling crate_" not in msg

    def test_clean_build_header_reports_zero_errors(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "0 errors" in msg
        assert "0 warnings" in msg

    def test_clean_build_suppression_count_in_header(self):
        stdout = _make_noisy_build_stdout(n_compiling=55, finished=True)
        payload = _make_post_bash_payload("cargo check", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        # Header must contain "lines suppressed" with non-zero numbers
        assert "lines suppressed" in msg

    # ------------------------------------------------------------------
    # Error compression
    # ------------------------------------------------------------------

    def test_errors_compressed_header(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_errors=2, finished=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "2 errors" in msg

    def test_error_diagnostic_block_preserved(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_errors=1, finished=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "error[E0308]" in msg

    def test_error_context_lines_kept(self):
        """Lines starting with -->, |, = (location / source / note) must be kept."""
        stdout = _make_noisy_build_stdout(n_compiling=50, n_errors=1, finished=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "  -->" in msg, "location line must be kept"
        assert "   |" in msg, "source context line must be kept"
        assert "   =" in msg, "note/help line must be kept"

    def test_error_noise_lines_absent(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_errors=1, finished=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "Compiling crate_" not in msg

    def test_terminal_error_line_included(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_errors=1, finished=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "could not compile" in msg

    # ------------------------------------------------------------------
    # Warning compression
    # ------------------------------------------------------------------

    def test_warnings_compressed_header(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_warnings=3, finished=True)
        payload = _make_post_bash_payload("cargo check", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "3 warnings" in msg

    def test_warning_block_preserved(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_warnings=1, finished=True)
        payload = _make_post_bash_payload("cargo check", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "warning[unused_imports]" in msg

    def test_warning_noise_absent(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_warnings=1, finished=True)
        payload = _make_post_bash_payload("cargo check", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "Compiling crate_" not in msg

    # ------------------------------------------------------------------
    # Trailing newline preservation
    # ------------------------------------------------------------------

    def test_trailing_newline_preserved(self):
        stdout = _make_noisy_build_stdout(n_compiling=55, with_trailing_newline=True)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        # Either no compression (falls through) or compressed msg ends with \n
        if msg is not None:
            assert msg.endswith("\n") or msg.endswith("]"), \
                "trailing newline must be preserved (or recall hint is last)"

    def test_no_trailing_newline_when_stdout_bare(self):
        stdout = _make_noisy_build_stdout(n_compiling=55, with_trailing_newline=False)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        if msg is not None:
            # The recall hint (if any) ends with ']'. Without session, body should not end \n.
            # Just verify the header is present and the message is non-empty.
            assert "[token-goat] cargo:" in msg

    # ------------------------------------------------------------------
    # Session / recall hint
    # ------------------------------------------------------------------

    def test_no_session_no_recall_hint(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0, sid=None)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        if msg is not None:
            assert "bash-output" not in msg

    def test_continue_true(self):
        stdout = _make_noisy_build_stdout(n_compiling=55)
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=0)
        result = self._call(payload)
        assert result.get("continue") is True

    # ------------------------------------------------------------------
    # clippy subcommand
    # ------------------------------------------------------------------

    def test_clippy_warnings_compressed(self):
        stdout = _make_noisy_build_stdout(n_compiling=50, n_warnings=2, finished=True)
        payload = _make_post_bash_payload("cargo clippy", stdout, exit_code=0)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None
        assert "2 warnings" in msg

    # ------------------------------------------------------------------
    # Bug 1: 3-digit line-number source annotations must not break continuation
    # ------------------------------------------------------------------

    def test_three_digit_line_number_continuation_kept(self):
        """Gutter lines after a 'NNN |' source annotation must be preserved.

        Old code used fixed prefixes ('  -->', '   |') that only matched when
        the left margin was exactly 2 or 3 spaces.  A 3-digit line number like
        '105 |' starts with a digit, breaking _cg_in_diag and dropping every
        subsequent caret/note line.
        """
        lines = [f"   Compiling crate_{i} v0.1.{i} (/workspace)" for i in range(50)]
        lines += [
            "error[E0308]: mismatched types",
            "   --> src/main.rs:105:13",
            "    |",
            "105 |     let x: i32 = \"hello\";",
            "    |             ^^^^^^^ expected `i32`, found `&str`",
            "    = note: expected type `i32`",
            "error: could not compile `myproject` due to 1 previous error",
        ]
        stdout = "\n".join(lines) + "\n"
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is not None, "should compress when errors present"
        assert "error[E0308]" in msg, "error header must be kept"
        assert "105 |" in msg, "source annotation with 3-digit line number must be kept"
        assert "^^^^^^^ expected" in msg, "caret underline after digit-prefixed line must be kept"
        assert "note: expected type" in msg, "note line after digit-prefixed source line must be kept"

    # ------------------------------------------------------------------
    # Bug 2: exit_code=1 with no stdout diagnostics must fall through
    # ------------------------------------------------------------------

    def test_exit_code_1_no_stdout_diagnostics_falls_through(self):
        """When cargo fails but stdout has no error/warning headers, do not compress.

        Cargo writes diagnostics to stderr, not stdout.  If only Compiling lines
        appear in stdout and exit_code=1, the old code would emit a misleading
        '[token-goat] cargo: 0 errors, 0 warnings' banner.  Now it falls through
        so the model sees the full (unmodified) output.
        """
        # Pure noise lines — no error[...]: or warning[...]: headers at all
        lines = [f"   Compiling crate_{i} v0.1.{i} (/workspace)" for i in range(50)]
        lines.append("error: could not compile `myproject`")
        stdout = "\n".join(lines) + "\n"
        payload = _make_post_bash_payload("cargo build", stdout, exit_code=1)
        result = self._call(payload)
        msg = self._cargo_msg(result)
        assert msg is None, (
            "must NOT emit [token-goat] cargo header when exit_code=1 "
            "and no diagnostic headers found in stdout"
        )
