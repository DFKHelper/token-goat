"""Tests for _handle_bash_grep_dedup content-serve path (iter 7).

When the native Grep tool ran the same (pattern, path) recently and the result
is in bash_cache, _handle_bash_grep_dedup injects the cached content rather than
only emitting a dedup hint.
"""
from __future__ import annotations


def _ctx(result: dict) -> str:
    return result.get("hookSpecificOutput", {}).get("additionalContext", "")


def _seed_grep_cache(sid: str, pattern: str, path: str | None, result_text: str, output_mode: str | None = "content") -> None:
    """Store a grep result in bash_cache and mark the session grep entry."""
    import token_goat.bash_cache as bc
    import token_goat.session as sess

    sess.mark_grep(sid, pattern, path)
    bc.store_grep_result(sid, pattern, path, None, None, output_mode, result_text)


class TestBashGrepResultCacheHit:
    def test_serves_cached_content_for_bash_grep(self, tmp_data_dir):
        """After native Grep caches a result, a Bash grep for same pattern+path serves the content."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-hit-1"
        pattern = "def foo"
        path = "src/utils.py"
        result_text = "src/utils.py:12:def foo(x):\nsrc/utils.py:45:def foobar():\n"
        _seed_grep_cache(sid, pattern, path, result_text, output_mode="content")

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"grep '{pattern}' {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is not None, "should serve cached content"
        ctx = _ctx(result)
        assert "def foo" in ctx
        assert "src/utils.py" in ctx
        assert "Serving from cache" in ctx
        assert result.get("action") != "deny"

    def test_serves_files_with_matches_fallback(self, tmp_data_dir):
        """Falls back to files_with_matches output_mode (None) when content mode has no entry."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-fwm-1"
        pattern = "TODO"
        path = "src/"
        result_text = "src/api.py\nsrc/utils.py\n"
        _seed_grep_cache(sid, pattern, path, result_text, output_mode=None)

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"grep -r '{pattern}' {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is not None, "should serve files_with_matches cached result"
        ctx = _ctx(result)
        assert "src/api.py" in ctx
        assert "Serving from cache" in ctx

    def test_result_count_shown_in_hint(self, tmp_data_dir):
        """result_count from the grep entry appears in the hint."""
        import token_goat.bash_cache as bc
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-count-1"
        pattern = "import os"
        path = "src/"
        sess.mark_grep(sid, pattern, path, result_count=7)
        bc.store_grep_result(sid, pattern, path, None, None, "content", "src/a.py:1:import os\n")

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"rg '{pattern}' {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is not None
        ctx = _ctx(result)
        assert "7" in ctx

    def test_no_prior_grep_returns_none(self, tmp_data_dir):
        """No prior native Grep session entry → no content serve, falls through."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        payload = {
            "session_id": "bgrc-miss-1",
            "tool_name": "Bash",
            "tool_input": {"command": "grep 'class Foo' src/models.py"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        # May return a dedup hint or None, but must NOT serve cached content
        if result is not None:
            assert "Serving from cache" not in _ctx(result)

    def test_path_mismatch_no_content_serve(self, tmp_data_dir):
        """Grep entry for path A does not match Bash grep targeting path B."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-pathmiss-1"
        _seed_grep_cache(sid, "raise ValueError", "src/a.py", "src/a.py:10:raise ValueError\n")

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": "grep 'raise ValueError' src/b.py"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        if result is not None:
            assert "Serving from cache" not in _ctx(result)

    def test_non_grep_command_returns_none(self, tmp_data_dir):
        """Non-grep Bash commands are not handled."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        payload = {
            "session_id": "bgrc-ngrep-1",
            "tool_name": "Bash",
            "tool_input": {"command": "npm install"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is None

    def test_non_bash_tool_returns_none(self, tmp_data_dir):
        """Payloads from non-Bash tools return None."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        payload = {
            "session_id": "bgrc-notbash-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO", "path": "src/"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is None


class TestBashGrepPathNormalization:
    def test_trailing_slash_variant_matches(self, tmp_data_dir):
        """Grep cached with 'src/' is served when Bash grep targets 'src' (no trailing slash)."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-norm-1"
        pattern = "class Base"
        _seed_grep_cache(sid, pattern, "src/", "src/base.py:1:class Base:\n")

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"rg '{pattern}' src"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is not None, "trailing-slash variant must match via normalization"
        assert "Serving from cache" in _ctx(result)

    def test_dot_prefix_variant_matches(self, tmp_data_dir):
        """Grep cached with './src' is served when Bash grep targets 'src'."""
        from token_goat.hooks_read import _handle_bash_grep_dedup

        sid = "bgrc-norm-2"
        pattern = "async def"
        _seed_grep_cache(sid, pattern, "./src", "src/api.py:5:async def handler():\n")

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"grep -r '{pattern}' src"},
            "cwd": "/proj",
        }
        result = _handle_bash_grep_dedup(payload)
        assert result is not None, "./src variant must match 'src' via normalization"
        assert "Serving from cache" in _ctx(result)


class TestBashGrepResultCacheStatGroup:
    def test_bash_grep_result_cache_hit_in_bash_group(self):
        from token_goat.render.stats_renderer import _kind_group_label
        assert _kind_group_label("bash_grep_result_cache_hit") == "Bash"
