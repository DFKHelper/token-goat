"""Tests for directory-recon streak consolidation (Iter 11).

Covers:
  - _is_recon_command detects ls, eza, tree, fd variants
  - _is_recon_command rejects grep, pytest, cat, rg
  - post_bash increments @recon_seen in hints_seen per recon command
  - post_bash does NOT inject map on first two recon commands
  - post_bash injects map on the 3rd recon command (returncode 0 mock)
  - post_bash skips injection when map subprocess fails (returncode != 0)
  - post_bash injects map at most once per session (@recon_map gate)
  - non-recon commands do not increment @recon_seen
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Unit: _is_recon_command
# ---------------------------------------------------------------------------

class TestIsReconCommand:
    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.hooks_read import _is_recon_command
        self.fn = _is_recon_command

    def test_ls(self):
        assert self.fn("ls")

    def test_ls_with_flags(self):
        assert self.fn("ls -la src/")

    def test_ll_alias(self):
        assert self.fn("ll")

    def test_eza(self):
        assert self.fn("eza --git --long")

    def test_exa(self):
        assert self.fn("exa --tree")

    def test_tree(self):
        assert self.fn("tree src/")

    def test_fd(self):
        assert self.fn("fd . src/")

    def test_fdfind(self):
        assert self.fn("fdfind .")

    def test_absolute_path_ls(self):
        # /usr/bin/ls → base=ls → match
        assert self.fn("/usr/bin/ls -la")

    def test_absolute_path_eza(self):
        assert self.fn("/usr/local/bin/eza --tree")

    def test_not_grep(self):
        assert not self.fn("grep -r TODO src/")

    def test_not_rg(self):
        assert not self.fn("rg TODO src/")

    def test_not_pytest(self):
        assert not self.fn("pytest tests/")

    def test_not_cat(self):
        assert not self.fn("cat src/foo.py")

    def test_not_git(self):
        assert not self.fn("git status")

    def test_not_find_with_exec(self):
        # find is not in our list; would be a false positive anyway
        assert not self.fn("find . -name '*.py' -exec grep TODO {} +")

    def test_empty_string(self):
        assert not self.fn("")

    def test_only_spaces(self):
        assert not self.fn("   ")


# ---------------------------------------------------------------------------
# Integration: post_bash recon tracking and injection
# ---------------------------------------------------------------------------

def _make_bash_payload(sid, cmd, stdout="dir1\ndir2\n", *, exit_code=0, cwd="/proj"):
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


class TestPostBashReconTracking:
    """Verify @recon_seen increments and map injection behaviour."""

    def _run(self, sid, cmd, stdout="a\nb\n"):
        from token_goat.hooks_read import post_bash
        return post_bash(_make_bash_payload(sid, cmd, stdout))

    def test_recon_seen_increments(self, tmp_data_dir):
        from token_goat.session import safe_load
        sid = "rc-inc"
        self._run(sid, "ls src/")
        cache = safe_load(sid)
        assert cache is not None
        count = cache.hints_seen.get("@recon_seen", 0)
        assert count == 1

    def test_non_recon_does_not_increment(self, tmp_data_dir):
        from token_goat.session import safe_load
        sid = "rc-non"
        self._run(sid, "git status")
        cache = safe_load(sid)
        assert cache is not None
        count = cache.hints_seen.get("@recon_seen", 0)
        assert count == 0

    def test_no_injection_on_first_two(self, tmp_data_dir):
        sid = "rc-first2"
        r1 = self._run(sid, "ls src/")
        r2 = self._run(sid, "eza --tree")
        assert r1.get("systemMessage") is None
        assert r2.get("systemMessage") is None

    def test_injection_on_third_recon(self, tmp_data_dir):
        sid = "rc-third"
        self._run(sid, "ls src/")
        self._run(sid, "eza --tree")
        _map_output = "# token-goat (10,python)\n10 files: 8 .py, 2 .md\n"
        _mock = MagicMock()
        _mock.returncode = 0
        _mock.stdout = _map_output
        with patch("subprocess.run", return_value=_mock) as mock_run:
            r3 = self._run(sid, "tree")
        assert r3.get("systemMessage") is not None
        msg = r3["systemMessage"]
        assert "Project map" in msg
        assert _map_output.strip() in msg
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert "map" in args
        assert "--compact" in args

    def test_no_injection_when_map_fails(self, tmp_data_dir):
        sid = "rc-fail"
        self._run(sid, "ls src/")
        self._run(sid, "eza --tree")
        _mock = MagicMock()
        _mock.returncode = 1
        _mock.stdout = ""
        with patch("subprocess.run", return_value=_mock):
            r3 = self._run(sid, "tree")
        assert r3.get("systemMessage") is None

    def test_injection_at_most_once(self, tmp_data_dir):
        sid = "rc-once"
        self._run(sid, "ls")
        self._run(sid, "eza")
        _mock = MagicMock()
        _mock.returncode = 0
        _mock.stdout = "# map\n"
        with patch("subprocess.run", return_value=_mock):
            r3 = self._run(sid, "tree")
            r4 = self._run(sid, "ls src/")
        assert r3.get("systemMessage") is not None
        assert r4.get("systemMessage") is None  # @recon_map gate fires; no second injection

    def test_no_retry_after_map_failure(self, tmp_data_dir):
        """@recon_map_fail sentinel prevents repeated subprocess calls after a failure."""
        sid = "rc-no-retry"
        self._run(sid, "ls")
        self._run(sid, "eza")
        _fail = MagicMock()
        _fail.returncode = 1
        _fail.stdout = ""
        _fail.stderr = "map error"
        _ok = MagicMock()
        _ok.returncode = 0
        _ok.stdout = "# map\n"
        with patch("subprocess.run", return_value=_fail):
            r3 = self._run(sid, "tree")   # 3rd recon; map fails → sets @recon_map_fail
        with patch("subprocess.run", return_value=_ok) as mock_ok:
            r4 = self._run(sid, "ls")   # 4th recon; fail gate blocks retry
        assert r3.get("systemMessage") is None
        assert r4.get("systemMessage") is None
        mock_ok.assert_not_called()  # subprocess never attempted again

    def test_failed_exit_code_recon_not_counted(self, tmp_data_dir):
        """ls with exit_code != 0 (path not found) should not increment @recon_seen."""
        from token_goat.session import safe_load
        sid = "rc-exit-fail"
        # Run ls with exit_code=2 (no such directory)
        from token_goat.hooks_read import post_bash
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": "ls /nonexistent"},
            "tool_response": {"stdout": "", "stderr": "ls: /nonexistent: No such file or directory", "exit_code": 2},
            "cwd": "/proj",
        }
        post_bash(payload)
        cache = safe_load(sid)
        assert cache is not None
        count = cache.hints_seen.get("@recon_seen", 0)
        assert count == 0  # failed ls must not count

    def test_quoted_binary_detected(self):
        """Commands with quoted binary name like '"ls" -la' should still be detected."""
        from token_goat.hooks_read import _is_recon_command
        assert _is_recon_command('"ls" -la src/')

    def test_shlex_error_fallback(self):
        """Malformed shlex input falls back to split(); still detects ls."""
        from token_goat.hooks_read import _is_recon_command
        # Unclosed quote — shlex raises ValueError; fallback uses str.split
        # 'ls' is the first token either way
        assert _is_recon_command("ls 'unclosed")
