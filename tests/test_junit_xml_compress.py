"""Tests for JUnit XML detection and summarisation in post_bash."""
from __future__ import annotations

import textwrap

from token_goat import bash_compress as bc
from token_goat.hooks_read import _summarize_junit_xml

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post_bash(cmd: str, stdout: str, *, exit_code: int = 0) -> dict:
    """Run post_bash with a minimal sessionless payload."""
    from token_goat.hooks_read import post_bash
    return post_bash({
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
    })


def _make_junit(*, tests: int = 5, failures: int = 0, errors: int = 0,
                skipped: int = 0, failure_cases: list[tuple[str, str, str]] | None = None,
                wrapper: bool = False) -> str:
    """Build a minimal JUnit XML string.

    failure_cases: list of (classname, name, message) for <failure> nodes.
    wrapper: wrap in <testsuites> instead of using <testsuite> as root.
    """
    cases: list[str] = []
    for i in range(tests):
        classname = f"com.example.Test{i}"
        name = f"test_method_{i}"
        cases.append(f'  <testcase classname="{classname}" name="{name}" time="0.1"/>')

    # Overwrite cases with failures (each testcase on multiple lines so line count stays high).
    if failure_cases:
        cases = []
        for cls, nm, msg in failure_cases:
            cases.append(
                f'  <testcase classname="{cls}" name="{nm}">\n'
                f'    <failure message="{msg}">\n'
                f'      stack trace here\n'
                f'    </failure>\n'
                f'  </testcase>'
            )
        tests = len(failure_cases)
        failures = tests

    suite = (
        f'<testsuite name="Suite" tests="{tests}" failures="{failures}"'
        f' errors="{errors}" skipped="{skipped}">\n'
        + "\n".join(cases)
        + "\n</testsuite>"
    )
    body = f"<testsuites>\n{suite}\n</testsuites>" if wrapper else suite
    return f'<?xml version="1.0" encoding="UTF-8"?>\n{body}'


# ---------------------------------------------------------------------------
# _is_junit_xml_output
# ---------------------------------------------------------------------------

class TestIsJunitXmlOutput:
    def test_valid_testsuite_root(self):
        xml = '<?xml version="1.0"?>\n<testsuite tests="3" failures="0"/>'
        assert bc._is_junit_xml_output(xml) is True

    def test_valid_testsuites_wrapper(self):
        xml = '<?xml version="1.0"?>\n<testsuites><testsuite tests="1"/></testsuites>'
        assert bc._is_junit_xml_output(xml) is True

    def test_empty_string(self):
        assert bc._is_junit_xml_output("") is False

    def test_plain_text_output(self):
        assert bc._is_junit_xml_output("PASSED 10 tests in 0.3s\nAll good!\n") is False

    def test_partial_xml_no_testsuite(self):
        # Has <?xml but no <testsuite
        assert bc._is_junit_xml_output('<?xml version="1.0"?>\n<root><item/></root>') is False

    def test_markers_beyond_first_2000_chars(self):
        # <?xml in first 2000, but <testsuite only after 2000
        padding = "x" * 2001
        xml = f'<?xml version="1.0"?>\n{padding}<testsuite tests="1"/>'
        # <testsuite is NOT in first 2000 chars, so should be False
        assert bc._is_junit_xml_output(xml) is False

    def test_html_with_xml_declaration(self):
        # has <?xml but no <testsuite
        html = '<?xml version="1.0"?>\n<!DOCTYPE html><html><body>hello</body></html>'
        assert bc._is_junit_xml_output(html) is False

    def test_testsuites_root_only_no_child(self):
        # <testsuites present in head — True even without child <testsuite
        xml = '<?xml version="1.0"?>\n<testsuites/>'
        assert bc._is_junit_xml_output(xml) is True

    def test_none_equivalent_false(self):
        # Single-character string — definitely no markers
        assert bc._is_junit_xml_output("x") is False


# ---------------------------------------------------------------------------
# _summarize_junit_xml
# ---------------------------------------------------------------------------

class TestSummarizeJunitXml:
    def test_all_passing_status_pass(self):
        xml = _make_junit(tests=5, failures=0)
        result = _summarize_junit_xml(xml)
        assert result is not None
        assert "PASS" in result
        assert "5 passed" in result

    def test_all_passing_no_failures_section(self):
        xml = _make_junit(tests=3, failures=0)
        result = _summarize_junit_xml(xml)
        assert "Failures" not in result

    def test_some_failures_status_fail(self):
        xml = _make_junit(
            failure_cases=[("com.Foo", "test_a", "AssertionError: expected 1"), ("com.Bar", "test_b", "NPE")]
        )
        result = _summarize_junit_xml(xml)
        assert "FAIL" in result
        assert "2 failed" in result

    def test_failure_names_in_output(self):
        xml = _make_junit(
            failure_cases=[("com.example.MyTest", "test_login", "wrong password")]
        )
        result = _summarize_junit_xml(xml)
        assert "com.example.MyTest.test_login" in result

    def test_errors_counted_separately(self):
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="3" failures="1" errors="1" skipped="0">'
            '<testcase classname="A" name="t1"/>'
            '<testcase classname="A" name="t2"><failure message="boom"/></testcase>'
            '<testcase classname="A" name="t3"><error message="oops"/></testcase>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        assert "1 failed" in result
        assert "1 errors" in result

    def test_skipped_counted(self):
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="4" failures="0" errors="0" skipped="2">'
            '<testcase classname="S" name="t1"/>'
            '<testcase classname="S" name="t2"/>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        assert "2 skipped" in result

    def test_more_than_10_failures_capped(self):
        cases = [("com.T", f"test_{i}", f"msg{i}") for i in range(15)]
        xml = _make_junit(failure_cases=cases)
        result = _summarize_junit_xml(xml)
        # Only 10 shown, plus a "... X more" line
        assert "5 more failures" in result

    def test_classname_testname_dot_format(self):
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="1" failures="1">'
            '<testcase classname="pkg.MyClass" name="my_test">'
            '<failure message="wrong"/>'
            '</testcase>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        assert "pkg.MyClass.my_test" in result

    def test_parse_error_returns_none(self):
        assert _summarize_junit_xml("not xml at all") is None

    def test_parse_error_truncated_xml_returns_none(self):
        assert _summarize_junit_xml('<?xml version="1.0"?><testsuite tests="1"') is None

    def test_testsuites_wrapper_aggregates_totals(self):
        xml = textwrap.dedent("""\
            <?xml version="1.0"?>
            <testsuites>
              <testsuite name="A" tests="3" failures="1" errors="0" skipped="0">
                <testcase classname="A" name="t1"/>
                <testcase classname="A" name="t2"/>
                <testcase classname="A" name="t3"><failure message="fail"/></testcase>
              </testsuite>
              <testsuite name="B" tests="2" failures="0" errors="0" skipped="1">
                <testcase classname="B" name="t4"/>
                <testcase classname="B" name="t5"/>
              </testsuite>
            </testsuites>
        """)
        result = _summarize_junit_xml(xml)
        # total = 5, failures = 1, skipped = 1, passed = 3
        assert "5 total" in result
        assert "1 failed" in result
        assert "1 skipped" in result
        assert "3 passed" in result

    def test_empty_testsuite_zero_tests(self):
        xml = '<?xml version="1.0"?><testsuite tests="0" failures="0" errors="0" skipped="0"/>'
        result = _summarize_junit_xml(xml)
        assert result is not None
        assert "0 total" in result
        assert "PASS" in result

    def test_long_failure_message_truncated(self):
        long_msg = "A" * 300
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="1" failures="1">'
            f'<testcase classname="C" name="t"><failure message="{long_msg}"/></testcase>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        # The message in the summary line must be <= 160 chars
        lines = result.splitlines()
        msg_line = next((ln for ln in lines if ln.startswith("    ")), "")
        assert len(msg_line.strip()) <= 160

    def test_wrong_root_tag_returns_none(self):
        xml = '<?xml version="1.0"?><report><item/></report>'
        assert _summarize_junit_xml(xml) is None

    def test_empty_attribute_strings_dont_raise(self):
        # int("") raises ValueError — _safe_int must handle it gracefully.
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="" failures="" errors="" skipped="">'
            '<testcase classname="A" name="t1"/>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        assert result is not None
        assert "0 total" in result
        assert "PASS" in result

    def test_nested_suites_no_double_count(self):
        # Outer suite tests="5" contains two inner suites tests="2" and tests="3".
        # Total must be 5 (outer only), not 10.
        xml = textwrap.dedent("""\
            <?xml version="1.0"?>
            <testsuites>
              <testsuite name="Outer" tests="5" failures="0" errors="0" skipped="0">
                <testsuite name="Inner1" tests="2" failures="0" errors="0" skipped="0">
                  <testcase classname="A" name="t1"/>
                  <testcase classname="A" name="t2"/>
                </testsuite>
                <testsuite name="Inner2" tests="3" failures="0" errors="0" skipped="0">
                  <testcase classname="B" name="t3"/>
                  <testcase classname="B" name="t4"/>
                  <testcase classname="B" name="t5"/>
                </testsuite>
              </testsuite>
            </testsuites>
        """)
        result = _summarize_junit_xml(xml)
        assert result is not None
        assert "5 total" in result
        assert "10 total" not in result

    def test_failure_without_message_attr_uses_text(self):
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="1" failures="1">'
            '<testcase classname="C" name="t">'
            '<failure>text content fallback</failure>'
            '</testcase>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        assert "text content fallback" in result

    def test_classname_missing_no_leading_dot(self):
        xml = (
            '<?xml version="1.0"?>'
            '<testsuite tests="1" failures="1">'
            '<testcase name="only_name">'
            '<failure message="boom"/>'
            '</testcase>'
            '</testsuite>'
        )
        result = _summarize_junit_xml(xml)
        # Should show "only_name", not ".only_name"
        assert "only_name" in result
        for line in result.splitlines():
            if "only_name" in line:
                assert not line.strip().startswith(".")


# ---------------------------------------------------------------------------
# Integration: post_bash interception
# ---------------------------------------------------------------------------

class TestPostBashJunit:
    def _junit_10lines(self, **kwargs) -> str:
        """Produce JUnit XML that is at least 10 lines long."""
        xml = _make_junit(**kwargs)
        # Ensure >= 10 lines
        assert len(xml.splitlines()) >= 10, "fixture too short — increase tests count"
        return xml

    def test_failures_triggers_interception(self):
        xml = self._junit_10lines(
            failure_cases=[
                ("com.Foo", "test_a", "AssertionError"),
                ("com.Bar", "test_b", "Timeout"),
                ("com.Baz", "test_c", "NPE"),
            ]
        )
        result = _post_bash("pytest --junitxml=report.xml && cat report.xml", xml)
        msg = result.get("systemMessage", "")
        assert "[token-goat] JUnit XML [FAIL]" in msg

    def test_all_pass_triggers_interception(self):
        xml = self._junit_10lines(tests=8, failures=0)
        result = _post_bash("cat report.xml", xml)
        msg = result.get("systemMessage", "")
        assert "[token-goat] JUnit XML [PASS]" in msg

    def test_short_xml_no_interception(self):
        # Build XML that is < 10 lines
        xml = '<?xml version="1.0"?><testsuite tests="1" failures="0"><testcase name="t"/></testsuite>'
        lines = xml.splitlines()
        assert len(lines) < 10
        result = _post_bash("cat report.xml", xml)
        # Should NOT be intercepted as JUnit — no systemMessage with JUnit marker
        msg = result.get("systemMessage", "")
        assert "[token-goat] JUnit XML" not in msg

    def test_non_xml_stdout_no_interception(self):
        plain = "PASSED 10 tests in 0.3s\n" * 20
        result = _post_bash("pytest -v", plain)
        msg = result.get("systemMessage", "")
        assert "[token-goat] JUnit XML" not in msg

    def test_single_line_xml_over_4096_bytes_intercepted(self):
        # Compact single-line XML (pytest-junit compact / machine-generated) with > 4096 bytes
        # must be intercepted even though it has < 10 lines.
        cases = "".join(
            f'<testcase classname="com.example.Pkg{i}" name="test_method_{i}" time="0.01"/>'
            for i in range(60)
        )
        xml = f'<?xml version="1.0" encoding="UTF-8"?><testsuite name="S" tests="60" failures="0" errors="0" skipped="0">{cases}</testsuite>'
        assert len(xml.splitlines()) < 10, "fixture must be single-line for this test"
        assert len(xml) >= 4096, f"fixture too short ({len(xml)} bytes); increase case count"
        result = _post_bash("cat report.xml", xml)
        msg = result.get("systemMessage", "")
        assert "[token-goat] JUnit XML [PASS]" in msg
