"""Tests for security-scanner filters: BanditFilter, TrivyFilter, SnykFilter, SemgrepFilter."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# BanditFilter
# ---------------------------------------------------------------------------

# Synthetic bandit issue blocks used across tests.
# B301 is a bandit code for serialization safety issues (used as test fixture).
_BANDIT_HIGH = (
    ">> Issue: [B301:unsafe_serialize] Unsafe deserialization detected.\n"
    "   Severity: High   Confidence: Medium\n"
    "   CWE: CWE-502\n"
    "   Location: src/load.py:10:4\n"
)
_BANDIT_MED = (
    ">> Issue: [B105:hardcoded_password_string] Hardcoded password.\n"
    "   Severity: Medium   Confidence: Medium\n"
    "   CWE: CWE-259\n"
    "   Location: src/config.py:5:4\n"
)


def _bo(issues, *, n_low=0):
    p = ["Run started: 2024-01-15 12:00:00.000000", "", "Test results:"]
    p.extend(issues)
    for i in range(n_low):
        p.append(
            ">> Issue: [B101:assert_used] Use of assert detected.\n"
            "   Severity: Low   Confidence: High\n"
            "   CWE: CWE-703\n"
            f"   Location: tests/test_{i}.py:3:4\n"
        )
    p += [
        "Code scanned:", "   Total lines of code: 500", "",
        "Total issues (by severity):", "   Low: 5", "   High: 1",
    ]
    return "\n".join(p)


class TestBanditFilter:
    def test_matches(self):
        f = bc.BanditFilter()
        assert f.matches(["bandit", "-r", "src/"])
        assert not f.matches(["pytest"])

    def test_select(self):
        assert isinstance(bc.select_filter(["bandit", "-r", "src/"]), bc.BanditFilter)

    def test_run_started(self):
        r = bc.BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"])
        assert "Run started:" in r.text

    def test_test_results(self):
        r = bc.BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"])
        assert "Test results:" in r.text

    def test_high(self):
        r = bc.BanditFilter().apply(_bo([_BANDIT_HIGH]), "", 0, ["bandit", "-r", "src/"])
        assert "B301:unsafe_serialize" in r.text

    def test_medium(self):
        r = bc.BanditFilter().apply(_bo([_BANDIT_MED]), "", 0, ["bandit", "-r", "src/"])
        assert "B105:hardcoded_password_string" in r.text

    def test_low_collapsed(self):
        r = bc.BanditFilter().apply(_bo([], n_low=5), "", 0, ["bandit", "-r", "src/"])
        assert "CWE-703" not in r.text
        assert "collapsed" in r.text.lower() or "low" in r.text.lower()

    def test_code_scanned(self):
        r = bc.BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"])
        assert "Code scanned:" in r.text

    def test_total_issues(self):
        r = bc.BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"])
        assert "Total issues" in r.text

    def test_drops_testing_progress(self):
        out = "testing /src/foo.py\ntesting /src/bar.py\nTest results:\n"
        r = bc.BanditFilter().apply(out, "", 0, ["bandit", "-r", "src/"])
        assert "testing /src/foo.py" not in r.text

    def test_empty(self):
        assert isinstance(bc.BanditFilter().apply("", "", 0, ["bandit"]).text, str)

    def test_compression(self):
        r = bc.BanditFilter().apply(_bo([_BANDIT_HIGH], n_low=20), "", 0, ["bandit", "-r", "src/"])
        assert r.compressed_bytes < r.original_bytes
        assert "B301:unsafe_serialize" in r.text


# ---------------------------------------------------------------------------
# TrivyFilter
# ---------------------------------------------------------------------------

_TL = (
    "2024-01-15T12:00:00Z INFO Need to update DB\n"
    "2024-01-15T12:00:01Z INFO Downloading DB...\n"
)
_THD = (
    "+---+--+--+\n"
    "| Library | Vulnerability ID | Severity | Installed Version |\n"
    "+---+--+--+"
)
_TROWS = (
    "| openssl | CVE-2023-0001 | CRITICAL | 1.1.1k |\n"
    "| libssl | CVE-2023-0002 | HIGH | 1.1.1k |\n"
    "| zlib | CVE-2023-0003 | MEDIUM | 1.2.11 |\n"
    "| zlib | CVE-2023-0004 | LOW | 1.2.11 |"
)
_TTOT = "Total: 4 (CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1)"


def _ts():
    return _THD + "\n" + _TROWS + "\n+---+--+--+\n\n" + _TTOT


class TestTrivyFilter:
    def test_matches(self):
        assert bc.TrivyFilter().matches(["trivy", "image", "nginx:latest"])
        assert not bc.TrivyFilter().matches(["bandit"])

    def test_select(self):
        assert isinstance(bc.select_filter(["trivy", "fs", "."]), bc.TrivyFilter)

    def test_drops_logs(self):
        r = bc.TrivyFilter().apply("", _TL, 0, ["trivy", "image", "nginx"])
        assert "INFO" not in r.text
        assert "Downloading DB" not in r.text

    def test_keeps_critical(self):
        r = bc.TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"])
        assert "CVE-2023-0001" in r.text

    def test_keeps_high(self):
        r = bc.TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"])
        assert "CVE-2023-0002" in r.text

    def test_collapses_medium(self):
        r = bc.TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"])
        assert "CVE-2023-0003" not in r.text

    def test_collapses_low(self):
        r = bc.TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"])
        assert "CVE-2023-0004" not in r.text

    def test_keeps_total(self):
        r = bc.TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"])
        assert "Total:" in r.text

    def test_no_vuln(self):
        r = bc.TrivyFilter().apply("No vulnerabilities found\n", "", 0, ["trivy", "image", "scratch"])
        assert "No vulnerabilities" in r.text

    def test_empty(self):
        assert isinstance(bc.TrivyFilter().apply("", "", 0, ["trivy"]).text, str)

    def test_compression(self):
        # Reuse same library names so many rows collapse to a single note per lib,
        # ensuring compressed_bytes < original_bytes even with collapse-note overhead.
        med_rows = [f"| zlib | CVE-2024-{i:04d} | MEDIUM | 1.2.{i} |" for i in range(30)]
        low_rows = [f"| openssl | CVE-2024-{i + 30:04d} | LOW | 1.1.{i} |" for i in range(20)]
        rows = med_rows + low_rows + ["| critical-pkg | CVE-2024-9999 | CRITICAL | 1.0.0 |"]
        stdout = _THD + "\n" + "\n".join(rows) + "\n" + _TTOT
        r = bc.TrivyFilter().apply(stdout, "", 0, ["trivy", "image", "nginx"])
        assert r.compressed_bytes < r.original_bytes
        assert "CVE-2024-9999" in r.text


# ---------------------------------------------------------------------------
# SnykFilter
# ---------------------------------------------------------------------------

_TC = "├─ "
_TE = "└─ "
_TV = "│  "
_VX = "✗"
_CK = "✔"


def _snyk_tree(extras=0):
    lines = [
        "my-project@1.0.0",
        _TC + "express@4.18.2",
        _TV + _TC + "body-parser@1.20.1",
        _TV + _TE + "debug@2.6.9",
        _TC + "lodash@4.17.21",
        _TE + "moment@2.29.4",
    ]
    for i in range(extras):
        lines.append(_TC + f"extra-pkg-{i}@1.0.{i}")
    return "\n".join(lines)


def _snyk_output(extras=0):
    return (
        "Testing my-project...\n\n"
        + _snyk_tree(extras) + "\n\n"
        + _VX + " High severity vulnerability found in lodash\n"
        "  Description: Prototype Pollution\n"
        "  More about this vulnerability:\n"
        "    https://snyk.io/vuln/SNYK-JS-LODASH\n\n"
        + _CK + " 0 unique vulnerabilities\n"
        + _VX + " 1 issues found\n"
    )


class TestSnykFilter:
    def test_matches(self):
        assert bc.SnykFilter().matches(["snyk", "test"])
        assert not bc.SnykFilter().matches(["trivy"])

    def test_select(self):
        assert isinstance(bc.select_filter(["snyk", "test"]), bc.SnykFilter)

    def test_keeps_first_testing_line(self):
        r = bc.SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"])
        assert "Testing my-project" in r.text

    def test_drops_duplicate_testing_lines(self):
        stdout = "Testing foo...\nTesting bar...\n" + _CK + " 0 unique vulnerabilities\n"
        r = bc.SnykFilter().apply(stdout, "", 0, ["snyk", "test"])
        assert r.text.count("Testing") == 1

    def test_collapses_deep_tree(self):
        r = bc.SnykFilter().apply(_snyk_output(extras=30), "", 0, ["snyk", "test"])
        assert "collapsed" in r.text.lower() or "dependency tree" in r.text.lower()

    def test_keeps_vuln_header(self):
        r = bc.SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"])
        assert "High severity" in r.text
        assert "lodash" in r.text

    def test_collapses_more_about_urls(self):
        r = bc.SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"])
        assert "More about this vulnerability:" not in r.text

    def test_keeps_summary(self):
        r = bc.SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"])
        assert "unique vulnerabilities" in r.text or "issues found" in r.text

    def test_keeps_license_lines(self):
        stdout = "Testing foo...\nLicense issue found in bar@1.0.0\n" + _CK + " 0 unique\n"
        r = bc.SnykFilter().apply(stdout, "", 0, ["snyk", "test"])
        assert "License issue" in r.text

    def test_empty(self):
        assert isinstance(bc.SnykFilter().apply("", "", 0, ["snyk"]).text, str)

    def test_compression(self):
        r = bc.SnykFilter().apply(_snyk_output(extras=50), "", 0, ["snyk", "test"])
        assert r.compressed_bytes < r.original_bytes


# ---------------------------------------------------------------------------
# SemgrepFilter
# ---------------------------------------------------------------------------

_SS = "Scanning 42 files..."
_SSUM = "Ran 100 rules on 42 files: 3 findings."


def _sg(n=1):
    parts = [_SS, ""]
    for i in range(n):
        parts.append(
            "python.security.audit.exec-used.exec-used\n"
            f"  src/file_{i}.py:{10 + i}:5:\n"
            f"    {10 + i} |     run_code(user_input)\n"
            "    Details: https://semgrep.dev/r/python.security.audit.exec-used.exec-used\n"
        )
    parts.append(_SSUM)
    return "\n".join(parts)


class TestSemgrepFilter:
    def test_matches(self):
        assert bc.SemgrepFilter().matches(["semgrep", "--config", "p/python"])
        assert not bc.SemgrepFilter().matches(["bandit"])

    def test_select(self):
        assert isinstance(bc.select_filter(["semgrep", "--config", "auto"]), bc.SemgrepFilter)

    def test_keeps_scanning(self):
        r = bc.SemgrepFilter().apply(_sg(), "", 0, ["semgrep"])
        assert "Scanning 42 files" in r.text

    def test_drops_duplicate_scanning(self):
        stdout = "Scanning 10 files...\nScanning 20 files...\n" + _SSUM
        r = bc.SemgrepFilter().apply(stdout, "", 0, ["semgrep"])
        assert r.text.count("Scanning") == 1

    def test_keeps_rule_snippet(self):
        r = bc.SemgrepFilter().apply(_sg(1), "", 0, ["semgrep"])
        assert "exec-used" in r.text

    def test_drops_details_urls(self):
        r = bc.SemgrepFilter().apply(_sg(1), "", 0, ["semgrep"])
        assert "Details: https://semgrep.dev" not in r.text

    def test_collapses_beyond_3(self):
        r = bc.SemgrepFilter().apply(_sg(10), "", 0, ["semgrep"])
        assert "collapsed" in r.text.lower() or "additional" in r.text.lower()

    def test_keeps_first_3(self):
        r = bc.SemgrepFilter().apply(_sg(5), "", 0, ["semgrep"])
        assert "src/file_0.py" in r.text
        assert "src/file_1.py" in r.text
        assert "src/file_2.py" in r.text
        assert "src/file_3.py" not in r.text
        assert "src/file_4.py" not in r.text

    def test_keeps_summary(self):
        r = bc.SemgrepFilter().apply(_sg(), "", 0, ["semgrep"])
        assert "Ran 100 rules" in r.text

    def test_empty(self):
        assert isinstance(bc.SemgrepFilter().apply("", "", 0, ["semgrep"]).text, str)

    def test_compression(self):
        r = bc.SemgrepFilter().apply(_sg(20), "", 0, ["semgrep"])
        assert r.compressed_bytes < r.original_bytes


# ---------------------------------------------------------------------------
# Registry integration
# ---------------------------------------------------------------------------


class TestSecurityFiltersRegistered:
    def test_bandit_in_filters(self):
        assert any(isinstance(f, bc.BanditFilter) for f in bc.FILTERS)

    def test_trivy_in_filters(self):
        assert any(isinstance(f, bc.TrivyFilter) for f in bc.FILTERS)

    def test_snyk_in_filters(self):
        assert any(isinstance(f, bc.SnykFilter) for f in bc.FILTERS)

    def test_semgrep_in_filters(self):
        assert any(isinstance(f, bc.SemgrepFilter) for f in bc.FILTERS)

    def test_select_bandit(self):
        assert isinstance(bc.select_filter(["bandit", "-r", "."]), bc.BanditFilter)

    def test_select_trivy(self):
        assert isinstance(bc.select_filter(["trivy", "image", "alpine:3.18"]), bc.TrivyFilter)

    def test_select_snyk(self):
        assert isinstance(bc.select_filter(["snyk", "test", "--all-projects"]), bc.SnykFilter)

    def test_select_semgrep(self):
        assert isinstance(bc.select_filter(["semgrep", "--config", "auto", "."]), bc.SemgrepFilter)
