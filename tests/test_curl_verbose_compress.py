"""Tests for curl -v verbose output compression (Iter 37)."""
from __future__ import annotations

import textwrap
from unittest.mock import patch

from token_goat.bash_compress import (
    _has_curl_verbose_output,
    _is_curl_verbose_cmd,
    compress_curl_verbose,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FULL_CURL_VERBOSE = textwrap.dedent("""\
    *   Trying 93.184.216.34:443...
    * Connected to example.com (93.184.216.34) port 443 (#0)
    * ALPN: offers h2,http/1.1
    * TLSv1.3 (OUT), TLS handshake, Client hello (1):
    * TLSv1.3 (IN), TLS handshake, Server hello (2):
    * TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):
    * TLSv1.3 (IN), TLS handshake, Finished (20):
    * SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
    * Server certificate:
    *  subject: CN=example.com
    *  expire date: Dec 14 23:59:59 2024 GMT
    *  SSL certificate verify ok.
    > GET /api/v1/data HTTP/2
    > Host: api.example.com
    > user-agent: curl/8.1.2
    > accept: */*
    >
    < HTTP/2 200
    < content-type: application/json; charset=utf-8
    < date: Sat, 14 Jun 2026 02:00:00 GMT
    < cache-control: max-age=3600
    < x-request-id: abc123
    < content-length: 1234
    <
    {"data": "the actual response body here"}
""")


# ---------------------------------------------------------------------------
# _is_curl_verbose_cmd
# ---------------------------------------------------------------------------

class TestIsCurlVerboseCmd:
    def test_short_verbose_flag(self):
        assert _is_curl_verbose_cmd(["curl", "-v", "https://example.com"]) is True

    def test_long_verbose_flag(self):
        assert _is_curl_verbose_cmd(["curl", "--verbose", "https://example.com"]) is True

    def test_combined_flags_vL(self):
        assert _is_curl_verbose_cmd(["curl", "-vL", "https://example.com"]) is True

    def test_combined_flags_separate_minus_v(self):
        assert _is_curl_verbose_cmd(["curl", "-L", "-v", "https://example.com"]) is True

    def test_combined_flags_svL(self):
        # -s (silent progress) + -v (verbose) + -L (follow redirect)
        assert _is_curl_verbose_cmd(["curl", "-svL", "https://example.com"]) is True

    def test_no_verbose_flag(self):
        assert _is_curl_verbose_cmd(["curl", "https://example.com"]) is False

    def test_silent_flag_only(self):
        assert _is_curl_verbose_cmd(["curl", "-s", "https://example.com"]) is False

    def test_not_curl(self):
        assert _is_curl_verbose_cmd(["wget", "-v", "https://example.com"]) is False

    def test_empty_argv(self):
        assert _is_curl_verbose_cmd([]) is False

    def test_curl_with_output_flag(self):
        assert _is_curl_verbose_cmd(["curl", "-v", "-o", "out.json", "https://example.com"]) is True

    def test_curl_location_verbose_order(self):
        # --verbose before URL
        assert _is_curl_verbose_cmd(["curl", "--verbose", "--location", "https://example.com"]) is True

    def test_wget_not_curl(self):
        assert _is_curl_verbose_cmd(["wget", "--verbose", "url"]) is False

    def test_curl_exe_extension(self):
        assert _is_curl_verbose_cmd(["curl.exe", "-v", "https://example.com"]) is True


# ---------------------------------------------------------------------------
# _has_curl_verbose_output
# ---------------------------------------------------------------------------

class TestHasCurlVerboseOutput:
    def test_full_verbose_output(self):
        assert _has_curl_verbose_output(FULL_CURL_VERBOSE) is True

    def test_star_lines_only(self):
        output = "* Trying 1.2.3.4...\n* Connected\n* SSL ok\n"
        assert _has_curl_verbose_output(output) is True

    def test_req_and_resp_lines(self):
        output = "> GET /foo HTTP/2\n> Host: example.com\n< HTTP/2 200\n< content-type: text/plain\n"
        assert _has_curl_verbose_output(output) is True

    def test_plain_text_no_markers(self):
        output = "Hello world\nThis is plain text\nNo curl markers here\n"
        assert _has_curl_verbose_output(output) is False

    def test_json_body_only(self):
        output = '{"key": "value"}\n'
        assert _has_curl_verbose_output(output) is False

    def test_empty_string(self):
        assert _has_curl_verbose_output("") is False


# ---------------------------------------------------------------------------
# compress_curl_verbose
# ---------------------------------------------------------------------------

class TestCompressCurlVerbose:
    def _run(self, text: str) -> tuple[str, int]:
        return compress_curl_verbose(text)

    def test_star_lines_removed(self):
        compressed, removed = self._run(FULL_CURL_VERBOSE)
        assert removed > 0
        assert not any(line.startswith("* ") for line in compressed.splitlines())

    def test_request_line_kept(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        assert "> GET /api/v1/data HTTP/2" in compressed

    def test_request_headers_removed(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        lines = compressed.splitlines()
        # Host, user-agent, accept headers should be stripped
        assert not any("> Host:" in ln for ln in lines)
        assert not any("> user-agent:" in ln for ln in lines)
        assert not any("> accept:" in ln for ln in lines)

    def test_status_line_kept(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        assert "< HTTP/2 200" in compressed

    def test_content_type_kept(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        assert "< content-type: application/json; charset=utf-8" in compressed

    def test_redundant_response_headers_removed(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        lines = compressed.splitlines()
        assert not any("< date:" in ln for ln in lines)
        assert not any("< cache-control:" in ln for ln in lines)
        assert not any("< x-request-id:" in ln for ln in lines)
        assert not any("< content-length:" in ln for ln in lines)

    def test_body_kept_verbatim(self):
        compressed, _ = self._run(FULL_CURL_VERBOSE)
        assert '{"data": "the actual response body here"}' in compressed

    def test_lines_removed_count_correct(self):
        compressed, removed = self._run(FULL_CURL_VERBOSE)
        original_count = len(FULL_CURL_VERBOSE.splitlines())
        compressed_count = len(compressed.splitlines())
        assert removed == original_count - compressed_count

    def test_lines_removed_positive(self):
        _, removed = self._run(FULL_CURL_VERBOSE)
        assert removed > 0

    def test_progress_meter_removed(self):
        output = (
            "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n"
            "                                 Dload  Upload   Total   Spent    Left  Speed\n"
            "100  1234  100  1234    0     0  56789      0 --:--:-- --:--:-- --:--:-- 56789\n"
            '{"result": "ok"}\n'
        )
        compressed, removed = self._run(output)
        assert removed == 3, f"expected 3 progress lines removed, got {removed}"
        assert "% Total" not in compressed
        assert "Dload  Upload" not in compressed
        assert "56789" not in compressed
        assert '{"result": "ok"}' in compressed

    def test_http1_status_kept(self):
        output = (
            "* Connected to example.com\n"
            "> GET /foo HTTP/1.1\n"
            "> Host: example.com\n"
            "< HTTP/1.1 200 OK\n"
            "< content-type: text/html\n"
            "< server: nginx\n"
            "<\n"
            "<html>body</html>\n"
        )
        compressed, _ = self._run(output)
        assert "< HTTP/1.1 200 OK" in compressed
        assert "< content-type: text/html" in compressed
        assert "< server: nginx" not in compressed

    def test_post_request_line_kept(self):
        output = (
            "* Trying 1.2.3.4...\n"
            "> POST /submit HTTP/2\n"
            "> Host: api.example.com\n"
            "> content-type: application/json\n"
            "<\n"
            "< HTTP/2 201\n"
            "< location: /resource/42\n"
            "<\n"
            '{"id": 42}\n'
        )
        compressed, _ = self._run(output)
        assert "> POST /submit HTTP/2" in compressed
        assert "< HTTP/2 201" in compressed
        assert '{"id": 42}' in compressed

    def test_plain_output_no_change(self):
        plain = "Hello world\nThis is text\n"
        compressed, removed = self._run(plain)
        assert removed == 0
        assert compressed == plain

    def test_empty_input(self):
        compressed, removed = self._run("")
        assert compressed == ""
        assert removed == 0

    def test_tls_handshake_lines_all_removed(self):
        output = FULL_CURL_VERBOSE
        compressed, removed = self._run(output)
        for tls_phrase in ("TLSv1.3", "TLS handshake", "Server certificate", "SSL connection"):
            assert tls_phrase not in compressed

    def test_status_404_kept(self):
        output = (
            "* Trying 1.2.3.4...\n"
            "> GET /missing HTTP/2\n"
            "> Host: example.com\n"
            ">  \n"
            "< HTTP/2 404\n"
            "< content-type: application/json\n"
            "< x-error: not-found\n"
            "<\n"
            '{"error": "not found"}\n'
        )
        compressed, _ = self._run(output)
        assert "< HTTP/2 404" in compressed
        assert "< content-type: application/json" in compressed
        assert "< x-error: not-found" not in compressed


# ---------------------------------------------------------------------------
# post_bash integration (via hook payload)
# ---------------------------------------------------------------------------

def _make_payload(command: str, stdout: str, exit_code: int = 0) -> dict:
    return {
        "session_id": "test-session-id",
        "cwd": "/tmp",
        "tool_input": {"command": command},
        "tool_response": {
            "output": stdout,
            "stderr": "",
            "exit_code": exit_code,
        },
    }


class TestPostBashCurlIntegration:
    """Integration tests for the curl verbose block inside post_bash.

    Session ID is intentionally empty so post_bash returns CONTINUE() before
    the `assert _sess_mod is not None` guard that fires when session_id is
    truthy but _get_session() is mocked to None.  The curl compression block
    fires regardless of session_id (it only skips bash-cache storage).
    """

    def _call_post_bash(self, command: str, stdout: str, exit_code: int = 0):
        from token_goat.hooks_read import post_bash
        payload = _make_payload(command, stdout, exit_code)
        with (
            patch("token_goat.hooks_read._get_session", return_value=None),
            # Empty session_id → no session ops; post_bash returns CONTINUE() before the
            # `assert _sess_mod is not None` guard at the bash-cache section.
            patch("token_goat.hooks_read.get_session_context", return_value=("", "/tmp")),
            patch("token_goat.hooks_read._unwrap_compress_command", side_effect=lambda x: x),
            patch("token_goat.hooks_read._extract_bash_response", return_value=(stdout, "", exit_code)),
            patch("token_goat.hooks_read._sanitize_surrogates", side_effect=lambda x: x),
            patch("token_goat.hooks_read._apply_output_size_cap", return_value=(stdout, "", False)),
            patch("token_goat.hooks_read._check_ignored_bash_hint"),
            patch("token_goat.hooks_read._is_recon_command", return_value=False),
        ):
            return post_bash(payload)

    def test_curl_verbose_triggers_compression(self):
        result = self._call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE)
        assert result.get("continue") is True
        msg = result.get("systemMessage", "")
        assert "verbose lines stripped" in msg

    def test_non_verbose_curl_not_triggered(self):
        plain_output = '{"data": "hello"}'
        result = self._call_post_bash("curl https://example.com", plain_output)
        # Should not trigger curl verbose path; systemMessage absent or no "verbose lines stripped"
        msg = result.get("systemMessage", "")
        assert "verbose lines stripped" not in msg

    def test_wget_not_triggered(self):
        result = self._call_post_bash("wget -v https://example.com", FULL_CURL_VERBOSE)
        msg = result.get("systemMessage", "")
        assert "verbose lines stripped" not in msg

    def test_curl_failure_passes_through(self):
        # exit_code=1 means curl error; should NOT compress
        result = self._call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "verbose lines stripped" not in msg

    def test_compressed_message_contains_status(self):
        result = self._call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE)
        msg = result.get("systemMessage", "")
        assert "200" in msg

    def test_compressed_output_contains_request_line(self):
        result = self._call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE)
        msg = result.get("systemMessage", "")
        assert "> GET /api/v1/data HTTP/2" in msg

    def test_compressed_output_contains_body(self):
        result = self._call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE)
        msg = result.get("systemMessage", "")
        assert '{"data": "the actual response body here"}' in msg


class TestRedirectChain:
    """Regression tests for curl -vL redirect chains (Bug: in_body never reset)."""

    REDIRECT_OUTPUT = (
        "* Connected to example.com port 443 (#0)\n"
        "> GET /old HTTP/2\n"
        "> Host: example.com\n"
        ">\n"
        "< HTTP/2 301\n"
        "< location: https://example.com/new\n"
        "< content-length: 0\n"
        "<\n"
        "* Issue another request to this URL: https://example.com/new\n"
        "* Connected to example.com port 443 (#1)\n"
        "> GET /new HTTP/2\n"
        "> Host: example.com\n"
        ">\n"
        "< HTTP/2 200\n"
        "< content-type: application/json\n"
        "< content-length: 18\n"
        "<\n"
        '{"status": "ok"}\n'
    )

    def _run(self, stdout: str) -> tuple[str, int]:
        from token_goat.bash_compress import compress_curl_verbose
        return compress_curl_verbose(stdout)

    def test_tls_noise_in_second_connection_suppressed(self):
        """* lines from the second connection must not appear in compressed output."""
        compressed, _ = self._run(self.REDIRECT_OUTPUT)
        assert "* Connected to example.com port 443 (#1)" not in compressed

    def test_issue_another_request_suppressed(self):
        """The redirect `* Issue another request` line must be suppressed."""
        compressed, _ = self._run(self.REDIRECT_OUTPUT)
        assert "* Issue another request" not in compressed

    def test_final_status_200_kept(self):
        """The final HTTP 200 status must appear in compressed output."""
        compressed, _ = self._run(self.REDIRECT_OUTPUT)
        assert "< HTTP/2 200" in compressed

    def test_final_body_kept(self):
        """The response body after the final redirect must be present."""
        compressed, _ = self._run(self.REDIRECT_OUTPUT)
        assert '{"status": "ok"}' in compressed

    def test_lines_removed_positive(self):
        """At least some lines must have been removed from the redirect output."""
        _, removed = self._run(self.REDIRECT_OUTPUT)
        assert removed > 0
