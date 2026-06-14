"""Tests for package manager install output compression.

Covers:
  - _is_pkg_install_cmd: detection for pip, cargo, npm, yarn, uv; negatives
  - post_bash integration: >= 30 lines → compressed systemMessage
  - post_bash integration: < 30 lines → NOT compressed (passes through)
  - post_bash integration: non-install subcommand → NOT compressed
  - post_bash integration: exit_code=2 → NOT compressed
  - post_bash integration: exit_code=1 with errors → compressed, errors preserved
  - post_bash integration: summary line present in message
  - post_bash integration: error lines present in message
  - post_bash integration: recall hint (bash-output <id>) present when session active
  - post_bash integration: line count present in message
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _is_pkg_install_cmd
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    stderr: str = "",
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


def _make_pip_output(n_packages: int, *, error: str = "") -> str:
    """Generate realistic pip install output for n_packages."""
    lines: list[str] = []
    for i in range(n_packages):
        lines += [
            f"Collecting package-{i}>=1.{i}",
            f"  Downloading package_{i}-1.{i}-py3-none-any.whl (42 kB)",
            "     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 42.0/42.0 kB 1.2 MB/s eta 0:00:00",
            f"Installing collected packages: package-{i}",
        ]
    if error:
        lines.append(error)
    lines.append("Successfully installed " + " ".join(f"package-{i}-1.{i}" for i in range(n_packages)))
    return "\n".join(lines)


def _make_cargo_output(n_crates: int, *, error: str = "") -> str:
    """Generate realistic cargo build output for n_crates."""
    lines: list[str] = [f"   Compiling crate-{i} v1.{i}.0" for i in range(n_crates)]
    if error:
        lines.append(error)
    lines.append("    Finished `release` profile [optimized] target(s) in 12.34s")
    return "\n".join(lines)


def _make_npm_output(n_packages: int) -> str:
    """Generate realistic npm install output for n_packages."""
    lines: list[str] = []
    for i in range(n_packages):
        lines += [
            f"npm warn deprecated dep-{i}@0.{i}: Use newer version",
            f"Downloading dep-{i} from registry...",
        ]
    lines.append(f"added {n_packages} packages in 5.2s")
    return "\n".join(lines)


def _make_uv_sync_output(n_packages: int) -> str:
    """Generate realistic uv sync output."""
    lines: list[str] = []
    for i in range(n_packages):
        lines += [
            f"Resolved {n_packages} packages in 0.{i:02d}s",
            f"   Built package-{i} @ 0.{i}.0",
            f"Downloading package-{i} (42 kB)",
            f"Installing package-{i}==0.{i}.0",
        ]
    lines.append(f"Installed {n_packages} packages in 1.23s")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# _is_pkg_install_cmd unit tests
# ---------------------------------------------------------------------------


class TestIsPkgInstallCmd:
    def test_pip_install(self):
        assert _is_pkg_install_cmd(["pip", "install", "requests"]) is True

    def test_pip3_install(self):
        assert _is_pkg_install_cmd(["pip3", "install", "-r", "requirements.txt"]) is True

    def test_pip_download(self):
        assert _is_pkg_install_cmd(["pip", "download", "flask"]) is True

    def test_pip_show_excluded(self):
        assert _is_pkg_install_cmd(["pip", "show", "requests"]) is False

    def test_pip_list_excluded(self):
        assert _is_pkg_install_cmd(["pip", "list"]) is False

    def test_cargo_build(self):
        assert _is_pkg_install_cmd(["cargo", "build", "--release"]) is False

    def test_cargo_install(self):
        assert _is_pkg_install_cmd(["cargo", "install", "ripgrep"]) is True

    def test_cargo_check(self):
        assert _is_pkg_install_cmd(["cargo", "check"]) is False

    def test_cargo_test(self):
        assert _is_pkg_install_cmd(["cargo", "test"]) is False

    def test_cargo_fmt_excluded(self):
        assert _is_pkg_install_cmd(["cargo", "fmt"]) is False

    def test_cargo_clippy_excluded(self):
        assert _is_pkg_install_cmd(["cargo", "clippy"]) is False

    def test_npm_install(self):
        assert _is_pkg_install_cmd(["npm", "install"]) is True

    def test_npm_i_shorthand(self):
        assert _is_pkg_install_cmd(["npm", "i", "lodash"]) is True

    def test_npm_ci(self):
        assert _is_pkg_install_cmd(["npm", "ci"]) is True

    def test_npm_update(self):
        assert _is_pkg_install_cmd(["npm", "update"]) is True

    def test_npm_test_excluded(self):
        assert _is_pkg_install_cmd(["npm", "test"]) is False

    def test_npm_run_excluded(self):
        assert _is_pkg_install_cmd(["npm", "run", "build"]) is False

    def test_yarn_install(self):
        assert _is_pkg_install_cmd(["yarn", "install"]) is True

    def test_yarn_add(self):
        assert _is_pkg_install_cmd(["yarn", "add", "axios"]) is True

    def test_yarn_upgrade(self):
        assert _is_pkg_install_cmd(["yarn", "upgrade"]) is True

    def test_yarn_remove_excluded(self):
        assert _is_pkg_install_cmd(["yarn", "remove", "axios"]) is False

    def test_uv_sync(self):
        assert _is_pkg_install_cmd(["uv", "sync"]) is True

    def test_uv_add(self):
        assert _is_pkg_install_cmd(["uv", "add", "httpx"]) is True

    def test_uv_install(self):
        assert _is_pkg_install_cmd(["uv", "install"]) is True

    def test_uv_pip_install(self):
        assert _is_pkg_install_cmd(["uv", "pip", "install", "-r", "requirements.txt"]) is True

    def test_uv_pip_sync(self):
        assert _is_pkg_install_cmd(["uv", "pip", "sync", "requirements.txt"]) is True

    def test_uv_pip_show_excluded(self):
        assert _is_pkg_install_cmd(["uv", "pip", "show", "requests"]) is False

    def test_uv_run_excluded(self):
        assert _is_pkg_install_cmd(["uv", "run", "pytest"]) is False

    def test_empty_argv(self):
        assert _is_pkg_install_cmd([]) is False

    def test_single_token(self):
        assert _is_pkg_install_cmd(["pip"]) is False

    def test_pip_exe_suffix(self):
        # Windows pip.exe
        assert _is_pkg_install_cmd(["pip.exe", "install", "requests"]) is True

    def test_pip_full_path(self):
        assert _is_pkg_install_cmd(["/usr/bin/pip", "install", "flask"]) is True

    def test_cargo_with_global_flag(self):
        # cargo -C /some/path install → should detect "install"
        assert _is_pkg_install_cmd(["cargo", "-C", "/some/path", "install", "ripgrep"]) is True

    def test_npm_with_prefix_flag(self):
        assert _is_pkg_install_cmd(["npm", "--prefix", "/app", "install"]) is True

    def test_unknown_command(self):
        assert _is_pkg_install_cmd(["apt", "install"]) is False

    def test_echo_install(self):
        assert _is_pkg_install_cmd(["echo", "install"]) is False

    def test_uv_global_flag_then_pip_install(self) -> None:
        # uv --directory <path> pip install: global flag pushes sub_idx to 3,
        # exercising the two-level dispatch path where sub_idx > 1
        assert _is_pkg_install_cmd(
            ["uv", "--directory", "/srv/myproject", "pip", "install", "requests"]
        ) is True


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------


class TestPkgInstallPostBashIntegration:
    def test_pip_install_large_compressed(self, tmp_path, tmp_data_dir):
        """pip install with >= 30 lines of Collecting/Downloading output → compressed."""
        sid = "sess-pkg-1"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)  # 10 packages × 4 lines + summary = 41 lines
        assert len(stdout.splitlines()) >= 30
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_cargo_build_large_compressed(self, tmp_path, tmp_data_dir):
        """cargo build is NOT a pkg-install command → large output is NOT compressed."""
        sid = "sess-pkg-2"
        _bootstrap_session(sid)
        stdout = _make_cargo_output(35)
        assert len(stdout.splitlines()) >= 30
        payload = _make_payload(sid, "cargo build --release", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_npm_install_large_compressed(self, tmp_path, tmp_data_dir):
        """npm install with progress lines → compressed."""
        sid = "sess-pkg-3"
        _bootstrap_session(sid)
        stdout = _make_npm_output(20)  # 20 packages × 2 lines + summary = 41 lines
        assert len(stdout.splitlines()) >= 30
        payload = _make_payload(sid, "npm install", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_uv_sync_compressed(self, tmp_path, tmp_data_dir):
        """uv sync → compressed."""
        sid = "sess-pkg-4"
        _bootstrap_session(sid)
        stdout = _make_uv_sync_output(10)  # 10 packages × 4 lines + summary = 41 lines
        assert len(stdout.splitlines()) >= 30
        payload = _make_payload(sid, "uv sync", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_short_output_not_compressed(self, tmp_path, tmp_data_dir):
        """< 30 lines → NOT compressed, passes through unchanged."""
        sid = "sess-pkg-5"
        _bootstrap_session(sid)
        stdout = _make_pip_output(5)  # 5 packages × 4 lines + summary = 21 lines
        assert len(stdout.splitlines()) < 30
        payload = _make_payload(sid, "pip install requests flask", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_pip_show_not_compressed(self, tmp_path, tmp_data_dir):
        """pip show is not an install command → NOT compressed."""
        sid = "sess-pkg-6"
        _bootstrap_session(sid)
        stdout = "\n".join([f"line {i}" for i in range(40)])
        payload = _make_payload(sid, "pip show requests", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_cargo_fmt_not_compressed(self, tmp_path, tmp_data_dir):
        """cargo fmt is not in install subcommands → NOT compressed."""
        sid = "sess-pkg-7"
        _bootstrap_session(sid)
        stdout = "\n".join([f"line {i}" for i in range(40)])
        payload = _make_payload(sid, "cargo fmt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_exit_code_2_not_compressed(self, tmp_path, tmp_data_dir):
        """exit_code=2 (not in (None, 0, 1)) → NOT compressed."""
        sid = "sess-pkg-8"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, "pip install requests", stdout, str(tmp_path), exit_code=2)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_exit_code_1_with_errors_compressed(self, tmp_path, tmp_data_dir):
        """exit_code=1 (partial-install failure) → compressed, errors preserved."""
        sid = "sess-pkg-9"
        _bootstrap_session(sid)
        stdout = _make_pip_output(8, error="ERROR: Could not find a version that satisfies pkg-x")
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path), exit_code=1)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg
        assert "ERROR: Could not find a version" in msg

    def test_summary_line_in_message(self, tmp_path, tmp_data_dir):
        """The last non-empty line (summary) appears in the systemMessage."""
        sid = "sess-pkg-10"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "Successfully installed" in msg

    def test_cargo_finished_line_in_message(self, tmp_path, tmp_data_dir):
        """cargo install 'Finished ...' summary line appears in message."""
        sid = "sess-pkg-11"
        _bootstrap_session(sid)
        stdout = _make_cargo_output(35)
        payload = _make_payload(sid, "cargo install ripgrep", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "Finished" in msg

    def test_error_lines_preserved_in_message(self, tmp_path, tmp_data_dir):
        """Error lines in stdout appear verbatim in the systemMessage."""
        sid = "sess-pkg-12"
        _bootstrap_session(sid)
        error_line = "ERROR: Could not find a version that satisfies the requirement bogus-pkg"
        stdout = _make_pip_output(8, error=error_line)
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path), exit_code=1)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert error_line in msg

    def test_recall_hint_present_with_session(self, tmp_path, tmp_data_dir):
        """When a session is active, systemMessage contains a bash-output recall hint."""
        sid = "sess-pkg-13"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "bash-output" in msg

    def test_line_count_in_message(self, tmp_path, tmp_data_dir):
        """The total line count appears in the systemMessage header."""
        sid = "sess-pkg-14"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        n_lines = len(stdout.splitlines())
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert str(n_lines) in msg

    def test_uv_pip_install_compressed(self, tmp_path, tmp_data_dir):
        """uv pip install (two-level subcommand) → compressed."""
        sid = "sess-pkg-15"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, "uv pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_yarn_add_compressed(self, tmp_path, tmp_data_dir):
        """yarn add → compressed."""
        sid = "sess-pkg-16"
        _bootstrap_session(sid)
        lines = [f"Fetching package {i} from registry..." for i in range(40)]
        lines.append("Done in 3.21s.")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "yarn add axios", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_cmd_short_in_message_header(self, tmp_path, tmp_data_dir):
        """First 60 chars of command appear in the header."""
        sid = "sess-pkg-17"
        _bootstrap_session(sid)
        cmd = "pip install -r requirements.txt"
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, cmd, stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert cmd[:60] in msg

    def test_warning_lines_preserved(self, tmp_path, tmp_data_dir):
        """Lines containing 'warning:' are captured as error/warning lines."""
        sid = "sess-pkg-18"
        _bootstrap_session(sid)
        warning = "warning: unused variable `x` [-Wunused-variable]"
        stdout = _make_cargo_output(30, error=warning)
        payload = _make_payload(sid, "cargo install my-tool", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert warning in msg

    def test_pip_full_path_compressed(self, tmp_path, tmp_data_dir):
        """/usr/bin/pip install → detection works with full path."""
        sid = "sess-pkg-19"
        _bootstrap_session(sid)
        stdout = _make_pip_output(10)
        payload = _make_payload(sid, "/usr/bin/pip install -r requirements.txt", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_npm_ci_compressed(self, tmp_path, tmp_data_dir):
        """npm ci (clean install) → compressed."""
        sid = "sess-pkg-20"
        _bootstrap_session(sid)
        stdout = _make_npm_output(20)
        payload = _make_payload(sid, "npm ci", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_exactly_threshold_lines_compressed(self, tmp_path, tmp_data_dir):
        """Exactly _PKG_INSTALL_MIN_LINES (30) lines → compressed."""
        sid = "sess-pkg-21"
        _bootstrap_session(sid)
        stdout = "\n".join([f"Collecting package-{i}" for i in range(29)] + ["Successfully installed pkg-0.1"])
        assert len(stdout.splitlines()) == 30
        payload = _make_payload(sid, "pip install some-pkg", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg

    def test_one_below_threshold_not_compressed(self, tmp_path, tmp_data_dir):
        """29 lines (one below threshold) → NOT compressed."""
        sid = "sess-pkg-22"
        _bootstrap_session(sid)
        stdout = "\n".join([f"Collecting package-{i}" for i in range(28)] + ["Successfully installed pkg-0.1"])
        assert len(stdout.splitlines()) == 29
        payload = _make_payload(sid, "pip install some-pkg", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_cargo_build_not_detected(self, tmp_path, tmp_data_dir):
        """cargo build with 30+ Compiling lines is NOT compressed (only cargo install is a pkg-install cmd)."""
        sid = "sess-pkg-23"
        _bootstrap_session(sid)
        stdout = _make_cargo_output(35)
        assert len(stdout.splitlines()) >= 30
        payload = _make_payload(sid, "cargo build --release", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" not in msg

    def test_npm_err_detected_in_error_lines(self, tmp_path, tmp_data_dir):
        """npm ERR! lines appear in the compressed output error section."""
        sid = "sess-pkg-24"
        _bootstrap_session(sid)
        lines = [f"Downloading dep-{i} from registry..." for i in range(30)]
        lines.append("npm ERR! 404 Not Found - GET https://registry.npmjs.org/bogus-pkg")
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "npm install bogus-pkg", stdout, str(tmp_path), exit_code=1)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg
        assert "npm ERR! 404 Not Found" in msg

    def test_summary_not_duplicated_when_error(self, tmp_path, tmp_data_dir):
        """When the last line is an error line it must appear only once in systemMessage."""
        sid = "sess-pkg-25"
        _bootstrap_session(sid)
        error_line = "ERROR: Could not install packages due to an OSError"
        lines = [f"Collecting package-{i}" for i in range(30)]
        lines.append(error_line)
        stdout = "\n".join(lines)
        payload = _make_payload(sid, "pip install -r requirements.txt", stdout, str(tmp_path), exit_code=1)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] pkg install:" in msg
        assert msg.count(error_line) == 1
