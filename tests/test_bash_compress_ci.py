"""Tests for CI-related bash_compress filters.

Covers: GhRunLogFilter, ActFilter, GenericCIFilter, and npm audit improvements
in NodePackageFilter.
"""
from __future__ import annotations

import json

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# GhRunLogFilter
# ---------------------------------------------------------------------------


class TestGhRunLogFilter:
    def _filter(self) -> bc.GhRunLogFilter:
        return bc.GhRunLogFilter()

    # --- dispatch ---

    def test_matches_gh_run_view_log(self) -> None:
        f = self._filter()
        assert f.matches(["gh", "run", "view", "123456789", "--log"])

    def test_matches_gh_run_view_log_failed(self) -> None:
        f = self._filter()
        assert f.matches(["gh", "run", "view", "123456789", "--log", "--exit-status"])

    def test_does_not_match_gh_run_view_without_log(self) -> None:
        f = self._filter()
        assert not f.matches(["gh", "run", "view", "123456789"])

    def test_does_not_match_gh_pr_view(self) -> None:
        f = self._filter()
        assert not f.matches(["gh", "pr", "view", "42"])

    def test_select_filter_returns_gh_run_log_filter(self) -> None:
        # GhRunLogFilter must be registered before GhFilter in FILTERS.
        f = bc.select_filter(["gh", "run", "view", "123456789", "--log"])
        assert isinstance(f, bc.GhRunLogFilter)

    def test_plain_gh_run_view_still_uses_gh_filter(self) -> None:
        f = bc.select_filter(["gh", "run", "view", "123456789"])
        assert isinstance(f, bc.GhFilter)

    # --- timestamp stripping ---

    def test_strips_iso8601_timestamp_prefix(self) -> None:
        stdout = (
            "2024-01-15T12:34:56.1234567Z Set up job\n"
            "2024-01-15T12:34:57.0000000Z Run actions/checkout@v4\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        assert "2024-01-15T" not in result.text
        assert "Set up job" in result.text

    def test_preserves_line_content_after_timestamp(self) -> None:
        stdout = "2024-06-01T00:00:00.0000000Z hello world\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        assert "hello world" in result.text

    # --- setup action collapsing ---

    def test_collapses_setup_action_lines(self) -> None:
        lines = [
            "Run actions/checkout@v4",
            "Run actions/setup-node@v3",
            "Run actions/cache@v3",
        ]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Individual action run lines should be gone; summary kept.
        assert "Run actions/checkout@v4" not in result.text
        assert "3 action(s) collapsed" in result.text

    # --- boilerplate dropping ---

    def test_drops_boilerplate_lines(self) -> None:
        stdout = (
            "Setting up runner\n"
            "Runner version 2.313.0\n"
            "Operating System     : Ubuntu 22.04\n"
            "Actual step output here\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        assert "Setting up runner" not in result.text
        assert "Runner version" not in result.text
        assert "Actual step output here" in result.text

    # --- cleanup dropping ---

    def test_drops_cleanup_lines(self) -> None:
        stdout = (
            "Some useful log line\n"
            "Post job cleanup.\n"
            "Cleaning up orphan processes\n"
            "Post Run actions/checkout@v4\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        assert "Post job cleanup" not in result.text
        assert "Cleaning up orphan processes" not in result.text
        assert "Post Run" not in result.text
        assert "Some useful log line" in result.text

    # --- group collapsing ---

    def test_collapses_large_passing_group(self) -> None:
        group_body = "\n".join(f"  line {i}" for i in range(30))
        stdout = f"##[group]Set up Python\n{group_body}\n##[endgroup]\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Should collapse the group since it has 30 lines and no failures.
        assert "Set up Python" in result.text
        assert "30 lines collapsed" in result.text
        assert "line 0" not in result.text

    def test_preserves_group_with_failure(self) -> None:
        group_body = "\n".join(
            [f"  line {i}" for i in range(25)] + ["  Error: build failed"]
        )
        stdout = f"##[group]Build\n{group_body}\n##[endgroup]\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Group has a failure — must NOT collapse.
        assert "Error: build failed" in result.text

    def test_preserves_small_group_verbatim(self) -> None:
        group_body = "\n".join(f"  step {i}" for i in range(5))
        stdout = f"##[group]Quick step\n{group_body}\n##[endgroup]\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Small group — should keep all lines.
        assert "step 0" in result.text
        assert "step 4" in result.text

    # --- failure lines kept ---

    def test_keeps_failure_lines_verbatim(self) -> None:
        stdout = (
            "2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1\n"
            "2024-01-01T00:00:01.0000000Z FAILED: tests/test_foo.py\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        assert "Process completed with exit code 1" in result.text
        assert "FAILED: tests/test_foo.py" in result.text

    # --- ##[command] echo dropping ---

    def test_drops_command_echo_lines(self) -> None:
        stdout = (
            "##[command]echo Hello\n"
            "##[command]/bin/bash -e /runner/_temp/step.sh\n"
            "Actual step output here\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # The raw command bodies must not appear, only the collapsed note may
        # mention "##[command]".
        assert "echo Hello" not in result.text
        assert "/runner/_temp/step.sh" not in result.text
        assert "Actual step output here" in result.text
        assert "##[command] echo lines" in result.text

    def test_command_echo_with_failure_signal_kept(self) -> None:
        """A ##[command] line that contains an error signal must be preserved."""
        stdout = (
            "##[command]echo 'Error: something went wrong'\n"
            "Normal output\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Contains 'Error:' — must not be dropped.
        assert "Error: something went wrong" in result.text

    # --- step-name TAB prefix stripping ---

    def test_strips_step_name_tab_prefix(self) -> None:
        """Lines in ``gh run view --log`` real output have step-name\ttimestamp format."""
        stdout = (
            "build (ubuntu-latest)\t2024-01-15T12:34:56.1234567Z Hello from step\n"
            "test (ubuntu-latest)\t2024-01-15T12:34:57.0000000Z Test line\n"
        )
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Step-name prefix and timestamp must both be stripped.
        assert "ubuntu-latest" not in result.text
        assert "2024-01-15T" not in result.text
        assert "Hello from step" in result.text
        assert "Test line" in result.text

    # --- combined scenario ---

    def test_combined_compression(self) -> None:
        lines = [
            "2024-01-01T00:00:00.0000000Z Setting up runner",
            "2024-01-01T00:00:01.0000000Z ##[group]Install dependencies",
        ]
        lines += [f"2024-01-01T00:00:0{i%9+1}.0000000Z   npm install step {i}" for i in range(25)]
        lines += [
            "2024-01-01T00:00:30.0000000Z ##[endgroup]",
            "2024-01-01T00:00:31.0000000Z Run actions/setup-node@v3",
            "2024-01-01T00:00:32.0000000Z Post job cleanup.",
        ]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"])
        # Timestamps gone.
        assert "2024-01-01T" not in result.text
        # Boilerplate gone.
        assert "Setting up runner" not in result.text
        # Group collapsed.
        assert "25 lines collapsed" in result.text
        # Setup action summarised.
        assert "action(s) collapsed" in result.text
        # Cleanup gone.
        assert "Post job cleanup" not in result.text


# ---------------------------------------------------------------------------
# ActFilter
# ---------------------------------------------------------------------------


class TestActFilter:
    def _filter(self) -> bc.ActFilter:
        return bc.ActFilter()

    # --- dispatch ---

    def test_matches_act(self) -> None:
        f = self._filter()
        assert f.matches(["act"])
        assert f.matches(["act", "-j", "test"])
        assert f.matches(["act", "push"])

    def test_does_not_match_other_commands(self) -> None:
        f = self._filter()
        assert not f.matches(["gh", "run", "view"])
        assert not f.matches(["docker"])

    def test_select_filter_returns_act_filter(self) -> None:
        f = bc.select_filter(["act", "-j", "build"])
        assert isinstance(f, bc.ActFilter)

    # --- prefix stripping ---

    def test_strips_job_step_prefix_from_body_lines(self) -> None:
        stdout = "[build/install-deps] | npm install\n[build/install-deps] | added 100 packages\n"
        result = self._filter().apply(stdout, "", 0, ["act", "-j", "build"])
        assert "[build/install-deps]" not in result.text
        assert "npm install" in result.text
        assert "added 100 packages" in result.text

    # --- status lines preserved ---

    def test_keeps_success_status_line(self) -> None:
        stdout = "[build/run-tests] ✅\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        assert "✅" in result.text

    def test_keeps_failure_status_line(self) -> None:
        stdout = "[build/run-tests] ❌\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        assert "❌" in result.text

    # --- docker pull collapsing ---

    def test_collapses_docker_pull_progress(self) -> None:
        lines = [
            "[build/setup] | Pulling from library/node",
            "[build/setup] | Waiting",
            "[build/setup] | Pulling fs layer",
            "[build/setup] | Verifying Checksum",
            "[build/setup] | Pull complete",
            "[build/setup] | Digest: sha256:abc123",
            "[build/setup] | Status: Downloaded newer image",
        ]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        assert "docker-pull progress lines" in result.text
        # No individual pull lines should remain.
        assert "Pulling fs layer" not in result.text
        assert "Pull complete" not in result.text

    # --- matrix expansion collapsing ---

    def test_collapses_matrix_expansion_lines(self) -> None:
        lines = [
            '[build/test] Matrix: {"os":"ubuntu-latest","node":"16"}',
            '[build/test] Matrix: {"os":"ubuntu-latest","node":"18"}',
            '[build/test] Matrix: {"os":"ubuntu-latest","node":"20"}',
        ]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        assert "matrix expansion lines" in result.text

    # --- failure lines kept verbatim ---

    def test_keeps_failure_lines(self) -> None:
        stdout = "[build/test] | ERROR: test_foo.py::test_bar FAILED\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        assert "FAILED" in result.text

    # --- combined scenario ---

    def test_combined_act_compression(self) -> None:
        lines = [
            "[build/setup] | Pulling from library/python",
            "[build/setup] | Pull complete",
            "[build/setup] | Digest: sha256:abc",
            "[build/run] | Running tests...",
            "[build/run] | test_foo ... ok",
            "[build/run] | FAILED: test_bar",
            "[build/run] ❌",
        ]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["act"])
        # Docker pull collapsed.
        assert "docker-pull" in result.text
        # Status lines kept.
        assert "❌" in result.text
        # Failure line kept.
        assert "FAILED: test_bar" in result.text
        # Normal body lines stripped of prefix.
        assert "Running tests..." in result.text
        # Prefix should only appear in status lines (❌ ✅) — not bare in body lines.
        # We verify by checking body lines (non-status lines) don't carry the prefix.
        body_lines_with_prefix = [
            ln for ln in result.text.splitlines()
            if "[build/" in ln and not any(s in ln for s in ("✅", "❌", "✓", "✗"))
        ]
        assert body_lines_with_prefix == [], body_lines_with_prefix


# ---------------------------------------------------------------------------
# GenericCIFilter
# ---------------------------------------------------------------------------


class TestGenericCIFilter:
    def _filter(self) -> bc.GenericCIFilter:
        return bc.GenericCIFilter()

    # --- dispatch ---

    def test_matches_on_log_flag(self) -> None:
        f = self._filter()
        assert f.matches(["some-ci-tool", "--log"])

    def test_matches_on_logs_subcommand(self) -> None:
        f = self._filter()
        assert f.matches(["pipeline-cli", "logs", "--job", "build"])

    def test_matches_on_pipeline_keyword(self) -> None:
        f = self._filter()
        assert f.matches(["ci-tool", "pipeline", "status"])

    def test_matches_on_workflow_keyword(self) -> None:
        f = self._filter()
        assert f.matches(["tool", "workflow", "run"])

    def test_does_not_match_plain_commands(self) -> None:
        f = self._filter()
        assert not f.matches(["pytest", "-v"])
        assert not f.matches(["npm", "install"])

    # --- timestamp stripping ---

    def test_strips_iso8601_timestamp(self) -> None:
        stdout = "2024-06-15T10:30:00.000Z Build started\n2024-06-15T10:30:01.000Z Step 1\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "2024-06-15T" not in result.text
        assert "Build started" in result.text
        assert "Step 1" in result.text

    def test_strips_space_separated_datetime(self) -> None:
        stdout = "2024-06-15 10:30:00 INFO some message\n"
        result = self._filter().apply(stdout, "", 0, ["pipeline", "logs"])
        assert "2024-06-15" not in result.text
        assert "INFO some message" in result.text

    def test_strips_bracket_timestamp(self) -> None:
        stdout = "[2024-06-15T10:30:00Z] log entry\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "[2024" not in result.text
        assert "log entry" in result.text

    # --- ANSI stripping ---

    def test_strips_ansi_codes(self) -> None:
        stdout = "\x1b[32mINFO\x1b[0m: build succeeded\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "\x1b[" not in result.text
        assert "build succeeded" in result.text

    # --- DEBUG/TRACE collapsing ---

    def test_collapses_debug_lines(self) -> None:
        lines = [f"DEBUG: connecting to host {i}" for i in range(20)]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "DEBUG: connecting" not in result.text
        assert "collapsed 20 DEBUG/TRACE" in result.text

    def test_collapses_trace_lines(self) -> None:
        lines = [f"TRACE: frame {i}" for i in range(15)]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "TRACE: frame" not in result.text
        assert "collapsed 15 DEBUG/TRACE" in result.text

    def test_keeps_info_lines(self) -> None:
        stdout = "INFO: deployment complete\nINFO: pods healthy\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "INFO: deployment complete" in result.text
        assert "INFO: pods healthy" in result.text

    # --- heartbeat collapsing ---

    def test_collapses_heartbeat_lines(self) -> None:
        lines = ["heartbeat: alive"] * 30
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "heartbeat: alive" not in result.text
        assert "heartbeat/health-check" in result.text

    def test_collapses_health_check_lines(self) -> None:
        lines = [f"health check #{i} OK" for i in range(20)]
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "health check" not in result.text
        assert "heartbeat/health-check" in result.text

    def test_collapses_keepalive_lines(self) -> None:
        lines = ["keepalive sent"] * 10
        stdout = "\n".join(lines) + "\n"
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "keepalive sent" not in result.text

    # --- failure lines always kept ---

    def test_keeps_error_lines(self) -> None:
        stdout = (
            "DEBUG: verbose noise\n"
            "Error: failed to connect to database\n"
            "DEBUG: more noise\n"
        )
        result = self._filter().apply(stdout, "", 0, ["tool", "--log"])
        assert "Error: failed to connect" in result.text

    def test_keeps_failed_lines(self) -> None:
        stdout = "FAILED: job build-and-test after 5 retries\n"
        result = self._filter().apply(stdout, "", 0, ["pipeline", "logs"])
        assert "FAILED: job build-and-test" in result.text

    # --- generic-ci select_filter ---

    def test_select_filter_does_not_preempt_specific_filters(self) -> None:
        # gh run view --log must be handled by GhRunLogFilter, not GenericCIFilter.
        f = bc.select_filter(["gh", "run", "view", "123", "--log"])
        assert isinstance(f, bc.GhRunLogFilter)

    def test_select_filter_does_not_preempt_kubectl_logs(self) -> None:
        # kubectl logs must be handled by KubectlLogsFilter.
        f = bc.select_filter(["kubectl", "logs", "my-pod"])
        assert isinstance(f, bc.KubectlLogsFilter)


# ---------------------------------------------------------------------------
# NodePackageFilter — npm audit improvements
# ---------------------------------------------------------------------------


class TestNodePackageFilterAudit:
    def _filter(self) -> bc.NodePackageFilter:
        return bc.NodePackageFilter()

    # --- JSON mode ---

    def test_audit_json_short_passes_through(self) -> None:
        data = {
            "vulnerabilities": {f"pkg{i}": {"severity": "moderate"} for i in range(5)},
            "metadata": {"vulnerabilities": {"total": 5}},
        }
        text = json.dumps(data)
        result = self._filter().apply(text, "", 1, ["npm", "audit", "--json"])
        out = json.loads(result.text)
        assert len(out["vulnerabilities"]) == 5

    def test_audit_json_collapses_over_10_entries(self) -> None:
        # 4 critical + 4 high + 6 moderate = 14 total; moderate should be collapsed.
        vulns: dict[str, object] = {}
        for i in range(4):
            vulns[f"critical-pkg-{i}"] = {"severity": "critical"}
        for i in range(4):
            vulns[f"high-pkg-{i}"] = {"severity": "high"}
        for i in range(6):
            vulns[f"moderate-pkg-{i}"] = {"severity": "moderate"}
        data = {"vulnerabilities": vulns, "metadata": {}}
        text = json.dumps(data)
        result = self._filter().apply(text, "", 1, ["npm", "audit", "--json"])
        out = json.loads(result.text)
        vuln_out = out["vulnerabilities"]
        # critical + high should be kept; moderate collapsed into sentinel.
        for i in range(4):
            assert f"critical-pkg-{i}" in vuln_out
            assert f"high-pkg-{i}" in vuln_out
        # A summary sentinel should be present.
        assert "__token_goat__" in vuln_out
        assert "6" in str(vuln_out["__token_goat__"])

    def test_audit_json_keeps_critical_and_high_when_many(self) -> None:
        vulns = {f"pkg{i}": {"severity": "low"} for i in range(15)}
        data = {"vulnerabilities": vulns, "metadata": {}}
        text = json.dumps(data)
        result = self._filter().apply(text, "", 1, ["npm", "audit", "--json"])
        out = json.loads(result.text)
        # All 15 are low — none are critical/high, so only sentinel remains.
        assert "__token_goat__" in out["vulnerabilities"]
        assert len(out["vulnerabilities"]) == 1

    def test_audit_json_non_json_passthrough(self) -> None:
        text = "not json at all"
        result = self._filter().apply(text, "", 1, ["npm", "audit", "--json"])
        assert "not json at all" in result.text

    def test_audit_json_preserves_metadata(self) -> None:
        vulns = {f"pkg{i}": {"severity": "low"} for i in range(12)}
        metadata = {"vulnerabilities": {"low": 12, "moderate": 0, "high": 0, "critical": 0}}
        data = {"vulnerabilities": vulns, "metadata": metadata}
        text = json.dumps(data)
        result = self._filter().apply(text, "", 1, ["npm", "audit", "--json"])
        out = json.loads(result.text)
        # Metadata must be untouched.
        assert out["metadata"] == metadata

    # --- human mode ---

    def test_audit_human_short_passes_through(self) -> None:
        blocks = []
        for i in range(5):
            blocks.append(f"# pkg-{i}\n  Severity: moderate\n  Some advisory text\n")
        text = "\n".join(blocks) + "\nfound 5 vulnerabilities\n"
        result = self._filter().apply(text, "", 1, ["npm", "audit"])
        assert "found 5 vulnerabilities" in result.text
        # All 5 blocks kept (under threshold).
        for i in range(5):
            assert f"# pkg-{i}" in result.text

    def test_audit_human_collapses_over_10_same_severity(self) -> None:
        blocks = []
        for i in range(15):
            blocks.append(
                f"# moderate-pkg-{i}\n  Severity: moderate\n  Advisory details here\n"
            )
        text = "\n".join(blocks) + "\nfound 15 vulnerabilities\n"
        result = self._filter().apply(text, "", 1, ["npm", "audit"])
        # First 10 moderate blocks kept.
        assert "# moderate-pkg-0" in result.text
        assert "# moderate-pkg-9" in result.text
        # Blocks 10..14 collapsed.
        assert "# moderate-pkg-10" not in result.text
        assert "collapsed 5 duplicate moderate advisories" in result.text
        # Summary line always kept.
        assert "found 15 vulnerabilities" in result.text

    def test_audit_human_mixed_severities_collapses_only_overflow(self) -> None:
        blocks = []
        for i in range(12):
            blocks.append(f"# high-pkg-{i}\n  Severity: high\n  Details\n")
        for i in range(3):
            blocks.append(f"# critical-pkg-{i}\n  Severity: critical\n  Details\n")
        text = "\n".join(blocks) + "\nfound 15 vulnerabilities\n"
        result = self._filter().apply(text, "", 1, ["npm", "audit"])
        # First 10 high blocks kept.
        assert "# high-pkg-9" in result.text
        assert "# high-pkg-10" not in result.text
        # All 3 critical blocks kept (under threshold).
        for i in range(3):
            assert f"# critical-pkg-{i}" in result.text

    def test_audit_human_no_advisory_blocks_passes_through(self) -> None:
        text = "found 0 vulnerabilities (0 packages audited)\n"
        result = self._filter().apply(text, "", 0, ["npm", "audit"])
        assert "found 0 vulnerabilities" in result.text

    # --- non-audit npm subcommands still work ---

    def test_non_audit_install_still_drops_progress(self) -> None:
        text = "⠋ idealTree\nadded 50 packages in 3s\n"
        result = self._filter().apply(text, "", 0, ["npm", "install"])
        assert "⠋ idealTree" not in result.text
        assert "added 50 packages" in result.text


# ---------------------------------------------------------------------------
# FILTERS list includes all new filters
# ---------------------------------------------------------------------------


class TestCIFiltersRegistered:
    def _names(self) -> list[str]:
        return [f.name for f in bc.FILTERS]

    def test_gh_run_log_filter_registered(self) -> None:
        assert "gh-run-log" in self._names()

    def test_act_filter_registered(self) -> None:
        assert "act" in self._names()

    def test_generic_ci_filter_registered(self) -> None:
        assert "generic-ci" in self._names()

    def test_gh_run_log_before_gh(self) -> None:
        names = self._names()
        assert names.index("gh-run-log") < names.index("gh")

    def test_gh_run_log_exported(self) -> None:
        assert hasattr(bc, "GhRunLogFilter")

    def test_act_exported(self) -> None:
        assert hasattr(bc, "ActFilter")

    def test_generic_ci_exported(self) -> None:
        assert hasattr(bc, "GenericCIFilter")
