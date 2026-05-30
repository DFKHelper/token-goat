"""Tests for `token-goat diff`."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from token_goat import cli
from token_goat.cli import _extract_diff_symbols

runner = CliRunner()


# ---------------------------------------------------------------------------
# _extract_diff_symbols unit tests
# ---------------------------------------------------------------------------

_PATCH_RUN_GIT = "token_goat.util.run_git"


def _make_run_git(stdout: str) -> Any:
    """Return a mock for run_git that yields the given stdout."""
    result = MagicMock()
    result.returncode = 0
    result.stdout = stdout
    return lambda *args, **kwargs: result


def test_extract_diff_symbols_empty():
    with patch(_PATCH_RUN_GIT, _make_run_git("")):
        assert _extract_diff_symbols("HEAD~1", "/tmp") == {}


def test_extract_diff_symbols_python():
    diff = """\
--- a/src/foo.py
+++ b/src/foo.py
@@ -10,3 +10,5 @@ def my_function(x):
+    return x + 1
@@ -50,1 +52,1 @@ class MyClass:
-    pass
+    x = 1
"""
    with patch(_PATCH_RUN_GIT, _make_run_git(diff)):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    assert "src/foo.py" in result
    syms = result["src/foo.py"]
    assert "my_function" in syms
    assert "MyClass" in syms


def test_extract_diff_symbols_deduplicates():
    diff = """\
--- a/src/bar.py
+++ b/src/bar.py
@@ -10,3 +10,5 @@ def helper():
-    old
@@ -20,2 +22,2 @@ def helper():
+    new
"""
    with patch(_PATCH_RUN_GIT, _make_run_git(diff)):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    assert result["src/bar.py"].count("helper") == 1


def test_extract_diff_symbols_multiple_files():
    diff = """\
--- a/a.py
+++ b/a.py
@@ -1,1 +1,2 @@ def alpha():
+    pass
--- a/b.py
+++ b/b.py
@@ -1,1 +1,2 @@ class Beta:
+    x = 1
"""
    with patch(_PATCH_RUN_GIT, _make_run_git(diff)):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    assert "alpha" in result["a.py"]
    assert "Beta" in result["b.py"]


def test_extract_diff_symbols_strips_keywords():
    diff = """\
--- a/x.go
+++ b/x.go
@@ -5,3 +5,4 @@ func DoThing(a int) {
+    a++
"""
    with patch(_PATCH_RUN_GIT, _make_run_git(diff)):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    assert "DoThing" in result["x.go"]
    # "func " prefix must be stripped
    assert not any("func" in s for s in result["x.go"])


def test_extract_diff_symbols_no_header_context():
    """Hunk with no trailing name after @@ is ignored gracefully."""
    diff = """\
--- a/c.py
+++ b/c.py
@@ -1,3 +1,4 @@
+new line
"""
    with patch(_PATCH_RUN_GIT, _make_run_git(diff)):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    # Either empty or an empty list — no crash.
    assert result.get("c.py", []) == []


def test_extract_diff_symbols_git_failure():
    failed = MagicMock()
    failed.returncode = 128
    failed.stdout = ""
    with patch(_PATCH_RUN_GIT, lambda *a, **kw: failed):
        result = _extract_diff_symbols("HEAD~1", "/tmp")
    assert result == {}


# ---------------------------------------------------------------------------
# CLI integration: session mode
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_session(monkeypatch: pytest.MonkeyPatch):
    """Inject a fake session with two edited files."""
    monkeypatch.setattr(
        "token_goat.session.validate_session_id",
        lambda sid: None,
    )
    monkeypatch.setattr(
        "token_goat.session.list_edited",
        lambda sid: {"src/alpha.py": 3, "src/beta.py": 1},
    )


def test_diff_session_mode_plain(fake_session: None):
    result = runner.invoke(cli.app, ["diff", "--session", "abc123def456abc1"])
    assert result.exit_code == 0
    assert "abc123de" in result.stdout  # first 8 chars
    assert "src/alpha.py" in result.stdout
    assert "src/beta.py" in result.stdout
    assert "3 edit" in result.stdout


def test_diff_session_mode_json(fake_session: None):
    result = runner.invoke(cli.app, ["diff", "--session", "abc123def456abc1", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["mode"] == "session"
    paths = [f["path"] for f in data["files"]]
    assert "src/alpha.py" in paths
    assert "src/beta.py" in paths


def test_diff_session_empty(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("token_goat.session.validate_session_id", lambda sid: None)
    monkeypatch.setattr("token_goat.session.list_edited", lambda sid: {})
    result = runner.invoke(cli.app, ["diff", "--session", "abc123def456abc1"])
    assert result.exit_code == 0
    assert "no files" in result.stdout.lower()


# ---------------------------------------------------------------------------
# CLI integration: git diff mode
# ---------------------------------------------------------------------------

def _patch_git(monkeypatch: pytest.MonkeyPatch, stat_stdout: str, diff_stdout: str = "") -> None:
    """Patch run_git to return controlled outputs for rev-parse, diff --stat, and diff --unified=0."""
    def _fake_run_git(args: list[str], **kwargs: Any) -> MagicMock:
        m = MagicMock()
        m.stderr = ""
        if "rev-parse" in args:
            m.returncode = 0
            m.stdout = "abc1234\n"
        elif "--stat" in args:
            m.returncode = 0
            m.stdout = stat_stdout
        elif "--unified=0" in args:
            m.returncode = 0
            m.stdout = diff_stdout
        else:
            m.returncode = 0
            m.stdout = ""
        return m

    monkeypatch.setattr("token_goat.util.run_git", _fake_run_git)


_STAT_STDOUT = """\
 src/foo.py | 10 ++++------
 src/bar.py |  2 +-
 2 files changed, 6 insertions(+), 6 deletions(-)
"""


def test_diff_git_plain(monkeypatch: pytest.MonkeyPatch):
    _patch_git(monkeypatch, _STAT_STDOUT)
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1"])
    assert result.exit_code == 0
    assert "src/foo.py" in result.stdout
    assert "src/bar.py" in result.stdout
    assert "2 files changed" in result.stdout


def test_diff_git_json(monkeypatch: pytest.MonkeyPatch):
    _patch_git(monkeypatch, _STAT_STDOUT)
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["mode"] == "git"
    assert data["since"] == "HEAD~1"
    paths = [f["path"] for f in data["files"]]
    assert "src/foo.py" in paths
    assert "src/bar.py" in paths


def test_diff_git_symbols(monkeypatch: pytest.MonkeyPatch):
    diff_stdout = """\
--- a/src/foo.py
+++ b/src/foo.py
@@ -5,3 +5,4 @@ def process(x):
+    x += 1
"""
    _patch_git(monkeypatch, _STAT_STDOUT, diff_stdout)
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1", "--symbols"])
    assert result.exit_code == 0
    assert "process" in result.stdout


def test_diff_git_symbols_json(monkeypatch: pytest.MonkeyPatch):
    diff_stdout = """\
--- a/src/foo.py
+++ b/src/foo.py
@@ -5,3 +5,4 @@ def process(x):
+    x += 1
"""
    _patch_git(monkeypatch, _STAT_STDOUT, diff_stdout)
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1", "--symbols", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    foo = next(f for f in data["files"] if f["path"] == "src/foo.py")
    assert "process" in foo["symbols"]


def test_diff_git_no_changes(monkeypatch: pytest.MonkeyPatch):
    _patch_git(monkeypatch, "")
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1"])
    assert result.exit_code == 0
    assert "No changes" in result.stdout


def test_diff_git_no_changes_json(monkeypatch: pytest.MonkeyPatch):
    _patch_git(monkeypatch, "")
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["files"] == []


def test_diff_bad_ref(monkeypatch: pytest.MonkeyPatch):
    def _fake_run_git(args: list[str], **kwargs: Any) -> MagicMock:
        m = MagicMock()
        m.returncode = 128
        m.stdout = ""
        m.stderr = "fatal: ambiguous argument"
        return m

    monkeypatch.setattr("token_goat.util.run_git", _fake_run_git)
    result = runner.invoke(cli.app, ["diff", "--since", "nonexistent-ref"])
    assert result.exit_code == 1
    assert "not found" in result.output


def test_diff_rename_notation(monkeypatch: pytest.MonkeyPatch):
    stat_with_rename = """\
 {old => new}/file.py | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
"""
    _patch_git(monkeypatch, stat_with_rename)
    result = runner.invoke(cli.app, ["diff", "--since", "HEAD~1"])
    assert result.exit_code == 0
    # Should not crash on rename notation
    assert "1 file changed" in result.stdout
