"""Tests for the pre_screenshot hook handler (T3 — MCP screenshot deny-redirect)."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import assert_deny as _assert_deny

from token_goat import hooks_cli


class TestPreScreenshotDenyWithoutFilePath:
    """MCP screenshot calls without filePath are denied with a redirect."""

    def test_chrome_devtools_screenshot_denied(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
            "tool_input": {},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_deny(result)

    def test_playwright_screenshot_denied(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_playwright_playwright__browser_take_screenshot",
            "tool_input": {"type": "png"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_deny(result)

    def test_deny_message_mentions_file_path(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
            "tool_input": {},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_deny(result)
        hso = result.get("hookSpecificOutput", {})
        output = hso.get("additionalContext", "") + " " + hso.get("permissionDecisionReason", "")
        assert "filePath" in output or "file_path" in output

    def test_deny_message_mentions_both_param_variants(self, tmp_data_dir):
        # Deny message must show both "filePath" (chrome-devtools) and "filename" (playwright).
        payload = {
            "tool_name": "mcp__plugin_playwright_playwright__browser_take_screenshot",
            "tool_input": {},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_deny(result)
        hso = result.get("hookSpecificOutput", {})
        output = hso.get("additionalContext", "") + " " + hso.get("permissionDecisionReason", "")
        assert "filePath" in output
        assert "filename" in output

    def test_deny_message_mentions_image_shrink(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_playwright_playwright__browser_take_screenshot",
            "tool_input": {},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_deny(result)
        hso = result.get("hookSpecificOutput", {})
        output = hso.get("additionalContext", "") + " " + hso.get("permissionDecisionReason", "")
        # Message should explain the redirect to image-shrink path
        assert "image" in output.lower() or "compress" in output.lower() or "shrink" in output.lower()


class TestPreScreenshotAllowWithFilePath:
    """MCP screenshot calls that already include filePath are allowed through."""

    def test_chrome_devtools_with_file_path_allowed(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
            "tool_input": {"filePath": "/tmp/shot.png"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_playwright_with_filename_allowed(self, tmp_data_dir):
        # Playwright uses "filename", not "filePath" — this is the critical escape path.
        payload = {
            "tool_name": "mcp__plugin_playwright_playwright__browser_take_screenshot",
            "tool_input": {"filename": "/tmp/shot.png", "type": "png"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_playwright_file_path_also_accepted(self, tmp_data_dir):
        # filePath is accepted for all tools as a belt-and-suspenders fallback.
        payload = {
            "tool_name": "mcp__plugin_playwright_playwright__browser_take_screenshot",
            "tool_input": {"filePath": "/tmp/shot.png", "type": "png"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_snake_case_file_path_allowed(self, tmp_data_dir):
        # Some MCP variants may use file_path instead of filePath
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
            "tool_input": {"file_path": "/tmp/shot.png"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)


class TestPreScreenshotNonScreenshotTools:
    """Non-screenshot MCP tools and standard tools are unaffected."""

    def test_read_tool_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "some_file.txt"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_bash_tool_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_mcp_navigate_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page",
            "tool_input": {"url": "https://example.com"},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)

    def test_empty_payload_passes_through(self, tmp_data_dir):
        result = hooks_cli.pre_screenshot({})
        _assert_continue(result)


class TestPreScreenshotConfigDisabled:
    """When screenshot_redirect is disabled in config, all calls pass through."""

    def test_disabled_config_passes_through(self, tmp_data_dir, monkeypatch):
        import copy

        from token_goat import config as cfg_mod

        original_load = cfg_mod.load

        def patched_load():
            cfg_copy = copy.deepcopy(original_load())
            cfg_copy.image_shrink.screenshot_redirect = False
            return cfg_copy

        monkeypatch.setattr(cfg_mod, "load", patched_load)
        payload = {
            "tool_name": "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
            "tool_input": {},
        }
        result = hooks_cli.pre_screenshot(payload)
        _assert_continue(result)
