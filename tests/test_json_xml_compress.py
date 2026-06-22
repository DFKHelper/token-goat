"""Tests for large JSON/XML output summarization (Iter 17).

Covers:
  - _json_structural_summary: dict top-level with sub-key expansion
  - _json_structural_summary: list top-level with first-element introspection
  - _json_structural_summary: key truncation at max_keys
  - post_bash: small JSON (<4000 bytes) passes through unchanged
  - post_bash: large dict JSON (>=4000 bytes) → structural summary in systemMessage
  - post_bash: large list JSON (>=4000 bytes) → structural summary in systemMessage
  - post_bash: large XML (>=4000 bytes) → one-liner suppression in systemMessage
  - post_bash: small XML (<4000 bytes) passes through unchanged
  - post_bash: non-JSON stdout (plain text) → not intercepted
  - post_bash: failed exit code (non-zero) → not intercepted even for large JSON
  - post_bash: JSON primitive (string/number) → not intercepted (no dict/list)
"""
from __future__ import annotations

import json

import pytest

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.hooks_read import (
    _JSON_SUMMARY_MAX_BYTES,
    _JSON_SUMMARY_MIN_BYTES,
    _json_structural_summary,
)
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_payload(
    sid: str,
    cmd: str,
    stdout: str,
    *,
    stderr: str = "",
    exit_code: int = 0,
    cwd: str = "/tmp",
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


def _large_json_dict(n_keys: int = 20, value_pad: int = 300) -> str:
    """Build a JSON dict large enough to exceed _JSON_SUMMARY_MIN_BYTES."""
    data = {f"key_{i}": "x" * value_pad for i in range(n_keys)}
    return json.dumps(data)


def _large_json_list(n_items: int = 5, item_pad: int = 1000) -> str:
    """Build a JSON list large enough to exceed _JSON_SUMMARY_MIN_BYTES."""
    item = {"id": 1, "name": "example", "data": "y" * item_pad}
    return json.dumps([item] * n_items)


def _large_xml(size: int = 5000) -> str:
    """Build a trivial XML blob that exceeds _JSON_SUMMARY_MIN_BYTES."""
    inner = "<item>data</item>" * ((size // 18) + 1)
    return f"<?xml version='1.0'?><root>{inner}</root>"


# ---------------------------------------------------------------------------
# Unit tests: _json_structural_summary
# ---------------------------------------------------------------------------

class TestJsonStructuralSummary:
    def test_dict_type_line(self):
        data = {"a": 1, "b": [1, 2]}
        out = _json_structural_summary(data)
        assert "Type: object (dict)" in out

    def test_dict_shows_key_count(self):
        data = {f"k{i}": i for i in range(5)}
        out = _json_structural_summary(data)
        assert "Keys (5):" in out

    def test_dict_expands_list_subkey(self):
        data = {"items": [1, 2, 3], "name": "test"}
        out = _json_structural_summary(data)
        assert "└── items: [list, 3 items]" in out

    def test_dict_expands_dict_subkey(self):
        data = {"metadata": {"uid": "abc", "rev": "1"}}
        out = _json_structural_summary(data)
        assert "└── metadata:" in out
        assert "uid" in out

    def test_dict_keys_truncated_at_max_keys(self):
        data = {f"key_{i}": i for i in range(20)}
        out = _json_structural_summary(data, max_keys=12)
        assert "+8 more" in out

    def test_list_type_line(self):
        data = [{"a": 1}] * 10
        out = _json_structural_summary(data)
        assert "Type: array (list)" in out

    def test_list_shows_length(self):
        data = list(range(50))
        out = _json_structural_summary(data)
        assert "Length: 50 items" in out

    def test_list_shows_first_item_keys(self):
        data = [{"id": 1, "name": "foo", "status": "ok"}]
        out = _json_structural_summary(data)
        assert "First item type: object" in out
        assert "id" in out

    def test_list_of_lists(self):
        data = [[1, 2, 3], [4, 5, 6]]
        out = _json_structural_summary(data)
        assert "First item type: array" in out

    def test_list_of_primitives(self):
        data = [42, 43, 44]
        out = _json_structural_summary(data)
        assert "First item type: int" in out

    def test_output_stays_under_20_lines(self):
        data = {f"key_{i}": {"sub": list(range(5))} for i in range(50)}
        out = _json_structural_summary(data)
        assert len(out.splitlines()) <= 20


# ---------------------------------------------------------------------------
# Integration tests: post_bash
# ---------------------------------------------------------------------------

class TestPostBashJsonXml:
    SID = "test-json-xml-iter17"

    @pytest.fixture(autouse=True)
    def _no_db_stat(self, monkeypatch):
        """Prevent db.record_stat from opening the global SQLite DB during tests."""
        monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)

    def setup_method(self):
        _bootstrap_session(self.SID)

    # ------------------------------------------------------------------
    # Small JSON — must pass through unchanged (no systemMessage from our block)
    # ------------------------------------------------------------------

    def test_small_json_passes_through(self, tmp_path):
        small = json.dumps({"key": "value"})
        assert len(small) < _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "echo '{}'", small, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Must NOT inject a structural summary for small output
        assert "structural summary" not in msg
        assert "large JSON" not in msg

    # ------------------------------------------------------------------
    # Large dict JSON — must produce structural summary
    # ------------------------------------------------------------------

    def test_large_dict_json_produces_summary(self, tmp_path):
        stdout = _large_json_dict()
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "curl http://api/data", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" in msg
        assert "structural summary" in msg
        assert "Type: object (dict)" in msg
        assert "Keys" in msg

    def test_large_dict_json_includes_recall_hint_when_session_active(self, tmp_path):
        stdout = _large_json_dict()
        payload = _make_payload(self.SID, "aws ec2 describe-instances", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Should include bash-output recall when session is active
        assert "bash-output" in msg

    # ------------------------------------------------------------------
    # Large list JSON — must produce structural summary
    # ------------------------------------------------------------------

    def test_large_list_json_produces_summary(self, tmp_path):
        stdout = _large_json_list()
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "kubectl get pods -o json", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" in msg
        assert "structural summary" in msg
        assert "Type: array (list)" in msg

    def test_large_list_json_shows_length(self, tmp_path):
        items = [{"id": i, "val": "a" * 200} for i in range(10)]
        stdout = json.dumps(items)
        if len(stdout) < _JSON_SUMMARY_MIN_BYTES:
            pytest.skip("constructed JSON too small for this threshold")
        payload = _make_payload(self.SID, "cat data.json", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "Length: 10 items" in msg

    # ------------------------------------------------------------------
    # Large XML — must produce one-liner suppression
    # ------------------------------------------------------------------

    def test_large_xml_suppressed(self, tmp_path):
        stdout = _large_xml(6000)
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "curl http://api/feed.xml", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large XML" in msg
        assert "stored" in msg

    def test_large_xml_no_structural_summary(self, tmp_path):
        stdout = _large_xml(6000)
        payload = _make_payload(self.SID, "cat large.xml", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "structural summary" not in msg

    def test_large_xml_root_element_no_declaration(self, tmp_path):
        """XML that starts with a tag (no <?xml ...?>) should also be suppressed."""
        inner = "<item>data</item>" * 300
        stdout = f"<root>{inner}</root>"
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "cat feed.xml", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large XML" in msg

    # ------------------------------------------------------------------
    # Small XML — must pass through unchanged
    # ------------------------------------------------------------------

    def test_small_xml_passes_through(self, tmp_path):
        stdout = "<?xml version='1.0'?><root><item>hi</item></root>"
        assert len(stdout) < _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "cat small.xml", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large XML" not in msg

    # ------------------------------------------------------------------
    # Non-JSON plain text — must not be intercepted
    # ------------------------------------------------------------------

    def test_plain_text_not_intercepted(self, tmp_path):
        stdout = "Hello, world!\n" * 400  # large but not JSON/XML
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "echo hello", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" not in msg
        assert "large XML" not in msg

    # ------------------------------------------------------------------
    # Failed exit code — must not be intercepted even for large JSON
    # ------------------------------------------------------------------

    def test_failed_exit_code_not_intercepted(self, tmp_path):
        stdout = _large_json_dict()
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(
            self.SID, "curl http://api/data", stdout,
            exit_code=1, cwd=str(tmp_path),
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" not in msg
        assert "structural summary" not in msg

    # ------------------------------------------------------------------
    # JSON primitive (string, number) — not intercepted (no dict/list)
    # ------------------------------------------------------------------

    def test_json_primitive_string_not_intercepted(self, tmp_path):
        stdout = json.dumps("x" * 5000)  # large JSON string, not dict/list
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "echo data", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" not in msg

    def test_json_primitive_number_not_intercepted(self, tmp_path):
        # A JSON number is never >= 4000 bytes, but guard with plain text fallback
        stdout = "42"
        payload = _make_payload(self.SID, "echo 42", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large JSON" not in msg

    # ------------------------------------------------------------------
    # Summary key truncation visible in systemMessage
    # ------------------------------------------------------------------

    def test_summary_keys_truncated_at_max_keys(self, tmp_path):
        data = {f"field_{i}": "v" * 20 for i in range(30)}
        stdout = json.dumps(data) + " " * max(0, _JSON_SUMMARY_MIN_BYTES - len(json.dumps(data)))
        # Ensure it is valid JSON still
        if not stdout.strip().endswith("}"):
            # pad inside the JSON instead
            data["padding"] = "p" * (_JSON_SUMMARY_MIN_BYTES * 2)
            stdout = json.dumps(data)
        assert len(stdout) >= _JSON_SUMMARY_MIN_BYTES
        payload = _make_payload(self.SID, "cat big.json", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # max_keys=12 default → "+N more" suffix for 30 keys
        assert "more" in msg

    def test_oversized_json_not_parsed(self, tmp_path):
        """JSON blobs above _JSON_SUMMARY_MAX_BYTES must not be parsed (memory guard)."""
        # Build a string that exceeds the max — use repeated whitespace so json.loads would
        # succeed if we erroneously tried it, but the guard should prevent that.
        # We can't actually allocate _JSON_SUMMARY_MAX_BYTES + 1 bytes of valid JSON easily,
        # so we test with a mock: patch len to simulate an oversized blob.
        import json as _json
        data = {"key": "value"}
        stdout = _json.dumps(data)
        # Pad to exactly MAX+1 bytes
        stdout = stdout + " " * (_JSON_SUMMARY_MAX_BYTES - len(stdout) + 1)
        # The content is still valid JSON if we strip, but the raw string len > MAX.
        assert len(stdout) > _JSON_SUMMARY_MAX_BYTES
        payload = _make_payload(self.SID, "curl api", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Should NOT produce a large-JSON summary (guard must have fired)
        assert "large JSON" not in msg
