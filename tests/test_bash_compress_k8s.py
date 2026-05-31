"""Tests for DockerComposeFilter, HelmFilter, and KubectlLogsFilter."""
from __future__ import annotations

import json

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# DockerComposeFilter
# ---------------------------------------------------------------------------


class TestDockerComposeFilter:
    """Tests for DockerComposeFilter."""

    def _filter(self) -> bc.DockerComposeFilter:
        return bc.DockerComposeFilter()

    # --- dispatch ---

    def test_matches_docker_compose_binary(self) -> None:
        f = self._filter()
        assert f.matches(["docker-compose", "up"])

    def test_matches_docker_compose_subcommand(self) -> None:
        f = self._filter()
        assert f.matches(["docker", "compose", "up", "-d"])

    def test_does_not_match_docker_build(self) -> None:
        f = self._filter()
        assert not f.matches(["docker", "build", "."])

    def test_does_not_match_docker_run(self) -> None:
        f = self._filter()
        assert not f.matches(["docker", "run", "myimage"])

    def test_does_not_match_kubectl(self) -> None:
        f = self._filter()
        assert not f.matches(["kubectl", "get", "pods"])

    def test_select_filter_docker_compose_binary(self) -> None:
        f = bc.select_filter(["docker-compose", "up"])
        assert isinstance(f, bc.DockerComposeFilter)

    def test_select_filter_docker_compose_subcommand(self) -> None:
        f = bc.select_filter(["docker", "compose", "up"])
        assert isinstance(f, bc.DockerComposeFilter)

    def test_docker_build_still_routes_to_docker_filter(self) -> None:
        f = bc.select_filter(["docker", "build", "."])
        assert isinstance(f, bc.DockerFilter)

    # --- pulling lines ---

    def test_collapses_many_pulling_lines(self) -> None:
        lines = [
            "Pulling db (postgres:14)...",
            "Pulling redis (redis:7)...",
            "Pulling web (myapp:latest)...",
        ]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        assert "Pulling db" in result.text
        assert "Pulling redis" not in result.text
        assert "2 more Pulling lines elided" in result.text

    def test_single_pulling_line_not_collapsed(self) -> None:
        text = "Pulling db (postgres:14)..."
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        assert "Pulling db" in result.text
        assert "elided" not in result.text

    # --- service streaming logs ---

    def test_service_logs_short_pass_through(self) -> None:
        lines = [f"web | log line {i}" for i in range(10)]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        for i in range(10):
            assert f"web | log line {i}" in result.text

    def test_service_logs_over_threshold_collapsed(self) -> None:
        lines = [f"web | log line {i}" for i in range(60)]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        # Should collapse: 60 - 10 = 50 lines elided
        assert "50 lines from web elided" in result.text
        # Last 10 lines kept
        for i in range(50, 60):
            assert f"web | log line {i}" in result.text
        # First lines should not appear
        assert "web | log line 0" not in result.text

    def test_multiple_services_collapsed_independently(self) -> None:
        web_lines = [f"web | line {i}" for i in range(60)]
        db_lines = [f"db | query {i}" for i in range(10)]  # under threshold
        text = "\n".join(web_lines + db_lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        assert "lines from web elided" in result.text
        # db lines all present (under 50)
        assert "db | query 0" in result.text
        assert "db | query 9" in result.text

    # --- Creating/Starting/Stopping lines kept ---

    def test_creating_network_kept(self) -> None:
        text = "Creating network default_network ... done\nCreating volume myapp_data ... done"
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        assert "Creating network" in result.text
        assert "Creating volume" in result.text

    def test_starting_and_stopping_kept(self) -> None:
        text = "Starting myapp_web_1 ... done\nStopping myapp_db_1 ... done"
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        assert "Starting myapp_web_1" in result.text
        assert "Stopping myapp_db_1" in result.text

    # --- health check ---

    def test_health_check_retries_collapsed(self) -> None:
        lines = [
            "Container myapp_web_1 Waiting",
            "Container myapp_web_1 Waiting",
            "Container myapp_web_1 Waiting",
            "Container myapp_web_1 Healthy",
        ]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["docker-compose", "up"])
        # First occurrence kept
        assert "Container myapp_web_1 Waiting" in result.text
        # Summary for repeated
        assert "more health-check wait lines" in result.text

    # --- error on non-zero exit ---

    def test_error_exit_preserves_stderr(self) -> None:
        stdout = "Starting myapp_web_1 ... done\n"
        stderr = "Error response from daemon: No such container"
        f = self._filter()
        result = f.apply(stdout, stderr, 1, ["docker-compose", "up"])
        assert "Error response from daemon" in result.text

    # --- empty output ---

    def test_empty_output(self) -> None:
        f = self._filter()
        result = f.apply("", "", 0, ["docker-compose", "ps"])
        assert result.text == ""


# ---------------------------------------------------------------------------
# HelmFilter
# ---------------------------------------------------------------------------


class TestHelmFilter:
    """Tests for HelmFilter."""

    def _filter(self) -> bc.HelmFilter:
        return bc.HelmFilter()

    # --- dispatch ---

    def test_matches_helm(self) -> None:
        f = self._filter()
        assert f.matches(["helm", "install", "myrelease", "mychart"])
        assert f.matches(["helm", "list"])
        assert f.matches(["helm", "template", "mychart"])

    def test_does_not_match_kubectl(self) -> None:
        f = self._filter()
        assert not f.matches(["kubectl", "apply", "-f", "chart.yaml"])

    def test_select_filter_returns_helm_filter(self) -> None:
        f = bc.select_filter(["helm", "install", "myrelease", "mychart"])
        assert isinstance(f, bc.HelmFilter)

    def test_select_filter_helm_not_kubectl_filter(self) -> None:
        # HelmFilter must precede KubectlFilter which used to claim `helm`
        f = bc.select_filter(["helm", "list"])
        assert isinstance(f, bc.HelmFilter)
        assert not isinstance(f, bc.KubectlFilter)

    # --- helm install / upgrade ---

    _INSTALL_OUTPUT = """\
NAME: myrelease
LAST DEPLOYED: Sat May 30 12:00:00 2026
NAMESPACE: default
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
This chart installs a web application.
Visit http://localhost:8080 to access it.

Some more NOTES text here.
"""

    def test_install_keeps_status_line(self) -> None:
        f = self._filter()
        result = f.apply(self._INSTALL_OUTPUT, "", 0, ["helm", "install", "myrelease", "mychart"])
        assert "STATUS: deployed" in result.text

    def test_install_collapses_boilerplate(self) -> None:
        f = self._filter()
        result = f.apply(self._INSTALL_OUTPUT, "", 0, ["helm", "install", "myrelease", "mychart"])
        # NOTES header body should be elided, not emitted verbatim
        assert "Visit http://localhost:8080" not in result.text
        assert "lines elided" in result.text

    def test_upgrade_keeps_status_failed(self) -> None:
        text = "NAME: myrelease\nSTATUS: failed\nLAST DEPLOYED: today\n"
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "upgrade", "myrelease", "mychart"])
        assert "STATUS: failed" in result.text

    def test_install_error_stderr_kept(self) -> None:
        stderr = "Error: INSTALLATION FAILED: chart not found"
        f = self._filter()
        result = f.apply("", stderr, 1, ["helm", "install", "x", "y"])
        assert "INSTALLATION FAILED" in result.text

    # --- helm list ---

    def test_list_short_passthrough(self) -> None:
        header = "NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART"
        rows = [f"rel{i}\tdefault\t1\tdeployed\tmychart-1.0" for i in range(5)]
        text = "\n".join([header] + rows)
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "list"])
        assert "rel0" in result.text
        assert "rel4" in result.text
        assert "elided" not in result.text

    def test_list_over_limit_truncated(self) -> None:
        header = "NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART"
        rows = [f"rel{i}\tdefault\t1\tdeployed\tmychart-1.0" for i in range(25)]
        text = "\n".join([header] + rows)
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "list"])
        # Should keep header + 10 rows + marker
        assert "rel0" in result.text
        assert "rel9" in result.text
        assert "rel10" not in result.text
        assert "15 more helm releases elided" in result.text

    # --- helm template ---

    def test_template_short_passthrough(self) -> None:
        text = "---\n# Source: mychart/templates/deploy.yaml\napiVersion: apps/v1\n"
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "template", "mychart"])
        # Short output: not compressed
        assert "apiVersion" in result.text

    def test_template_long_shows_section_headers(self) -> None:
        # Build a fake template output > 200 lines
        sections = []
        for i in range(15):
            sections.append(f"---\n# Source: chart/templates/resource{i}.yaml")
            sections.append("\n".join(f"field{j}: value{j}" for j in range(15)))
        text = "\n".join(sections)
        assert len(text.split("\n")) > 200
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "template", "mychart"])
        # Should contain document separator markers
        assert "---" in result.text
        # Should contain total line count summary
        assert "total lines" in result.text
        # Should NOT contain all the field lines
        assert result.text.count("field0: value0") <= 1

    # --- other subcommands pass through ---

    def test_status_passthrough(self) -> None:
        text = "NAME: myrelease\nSTATUS: deployed\n"
        f = self._filter()
        result = f.apply(text, "", 0, ["helm", "status", "myrelease"])
        assert "STATUS: deployed" in result.text


# ---------------------------------------------------------------------------
# KubectlLogsFilter
# ---------------------------------------------------------------------------


class TestKubectlLogsFilter:
    """Tests for KubectlLogsFilter."""

    def _filter(self) -> bc.KubectlLogsFilter:
        return bc.KubectlLogsFilter()

    # --- dispatch ---

    def test_matches_kubectl_logs(self) -> None:
        f = self._filter()
        assert f.matches(["kubectl", "logs", "my-pod"])
        assert f.matches(["kubectl", "logs", "-f", "my-pod"])
        assert f.matches(["k", "logs", "my-pod"])

    def test_does_not_match_kubectl_get(self) -> None:
        f = self._filter()
        assert not f.matches(["kubectl", "get", "pods"])

    def test_does_not_match_kubectl_describe(self) -> None:
        f = self._filter()
        assert not f.matches(["kubectl", "describe", "pod", "my-pod"])

    def test_does_not_match_helm(self) -> None:
        f = self._filter()
        assert not f.matches(["helm", "logs", "release"])

    def test_select_filter_returns_kubectl_logs_filter(self) -> None:
        f = bc.select_filter(["kubectl", "logs", "my-pod"])
        assert isinstance(f, bc.KubectlLogsFilter)

    def test_select_filter_kubectl_get_still_routes_to_kubectl_filter(self) -> None:
        f = bc.select_filter(["kubectl", "get", "pods"])
        assert isinstance(f, bc.KubectlFilter)

    # --- short output passthrough ---

    def test_short_output_passes_through(self) -> None:
        lines = ["2026-05-30T12:00:00Z INFO started", "2026-05-30T12:00:01Z INFO ready"]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        for line in lines:
            assert line in result.text

    # --- repetitive line dedup ---

    def test_dedup_repetitive_timestamp_lines(self) -> None:
        # Same message with different timestamps — enough lines (>50) to
        # trigger the dedup path in KubectlLogsFilter.compress()
        lines = [
            f"2026-05-30T12:00:{i:02d}Z INFO heartbeat ok"
            for i in range(60)
        ]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # Should collapse: keep 3, show N more
        assert "more similar lines omitted" in result.text
        # First 3 should be present
        assert "2026-05-30T12:00:00Z INFO heartbeat ok" in result.text
        assert "2026-05-30T12:00:01Z INFO heartbeat ok" in result.text
        assert "2026-05-30T12:00:02Z INFO heartbeat ok" in result.text

    def test_dedup_does_not_collapse_different_messages(self) -> None:
        lines = [
            "2026-05-30T12:00:00Z INFO started server",
            "2026-05-30T12:00:01Z INFO connected to db",
            "2026-05-30T12:00:02Z INFO cache warmed",
        ]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # All distinct lines should survive (output is short, no compression applied)
        for line in lines:
            assert line in result.text

    # --- stack trace collapsing ---

    def test_stack_trace_collapsed(self) -> None:
        error_line = "2026-05-30T12:00:00Z ERROR NullPointerException"
        frames = [f"    at com.example.Class{i}.method(Class{i}.java:{i * 10})" for i in range(15)]
        # Pad to >50 lines so dedup path activates
        padding = [f"2026-05-30T12:00:{i + 1:02d}Z INFO log line {i}" for i in range(50)]
        text = "\n".join([error_line] + frames + padding)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        assert "more frames" in result.text
        # First 5 frames kept
        assert "at com.example.Class0.method" in result.text
        assert "at com.example.Class4.method" in result.text

    # --- access log collapsing ---

    def test_access_logs_collapsed_over_threshold(self) -> None:
        # 25 access log lines
        access = [
            '10.0.0.1 - - [30/May/2026] "GET /api/v1/foo HTTP/1.1" 200 123'
            for _ in range(25)
        ]
        # A few non-access lines
        other = ["2026-05-30T12:00:00Z INFO started"] * 10
        # Need >50 total lines to trigger compression
        padding = [f"2026-05-30T12:00:{i:02d}Z INFO padding {i}" for i in range(30)]
        text = "\n".join(other + access + padding)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        assert "HTTP access log lines collapsed" in result.text
        assert "2xx:" in result.text

    def test_access_logs_under_threshold_kept(self) -> None:
        # Only 5 access log lines — under the 20-line threshold
        access = [
            '10.0.0.1 - - [30/May/2026] "GET /healthz HTTP/1.1" 200 10'
            for _ in range(5)
        ]
        # Total lines still over 50 (to trigger filter)
        padding = [f"2026-05-30T12:00:{i:02d}Z INFO other {i}" for i in range(60)]
        text = "\n".join(access + padding)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # access logs should survive (threshold not hit)
        assert "collapsed" not in result.text or "HTTP access" not in result.text

    # --- JSON blob collapsing ---

    def test_json_blob_over_5_lines_collapsed(self) -> None:
        # Build a JSON blob that exceeds the 5-line threshold (indent=2 on a
        # dict with many keys produces one line per key + 2 brace lines)
        obj = {f"key{i}": f"value{i}" for i in range(8)}
        blob = json.dumps(obj, indent=2)
        blob_lines = blob.split("\n")
        assert len(blob_lines) > 5, f"expected >5 blob lines, got {len(blob_lines)}: {blob_lines}"
        # Surround with enough log lines to trigger the filter (>50 total)
        padding = [f"2026-05-30T12:00:{i:02d}Z INFO log {i}" for i in range(60)]
        text = "\n".join(padding[:30]) + "\n" + blob + "\n" + "\n".join(padding[30:])
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        assert "JSON blob" in result.text
        assert "collapsed" in result.text

    def test_json_blob_under_5_lines_kept(self) -> None:
        # A compact 2-line JSON object
        blob = '{"level": "info", "msg": "ok"}'
        padding = [f"2026-05-30T12:00:{i:02d}Z INFO log {i}" for i in range(60)]
        text = "\n".join(padding) + "\n" + blob
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # Single-line JSON should not be collapsed
        assert '"level": "info"' in result.text or '{"level"' in result.text

    # --- error exit preserves stderr ---

    def test_error_exit_preserves_stderr(self) -> None:
        stderr = "Error from server (NotFound): pods \"missing-pod\" not found"
        f = self._filter()
        result = f.apply("", stderr, 1, ["kubectl", "logs", "missing-pod"])
        assert "NotFound" in result.text

    # --- multi-pod / --prefix output dedup ---

    def test_multi_pod_prefix_dedup(self) -> None:
        """kubectl logs -l selector emits pod-name | message; same message collapses."""
        # 60 lines from 2 pods, alternating, with the same health-check message
        lines = []
        for i in range(30):
            ts = f"2026-05-30T12:{i // 60:02d}:{i % 60:02d}Z"
            lines.append(f"pod-abc123 | {ts} INFO health check ok")
            lines.append(f"pod-def456 | {ts} INFO health check ok")
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "-l", "app=myapp"])
        # Should collapse: the two pods emit the same message; keep first 3 of any
        assert "more similar lines omitted" in result.text
        # At least the first instance from one pod should be preserved
        assert "INFO health check ok" in result.text

    def test_multi_pod_prefix_output_different_messages_kept(self) -> None:
        """Different messages from multiple pods are not collapsed."""
        lines = [f"pod-{i} | 2026-05-30T12:00:00Z INFO unique message {i}" for i in range(60)]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "-l", "app=myapp"])
        # All unique messages should survive (no collapsing of distinct messages)
        assert "more similar lines omitted" not in result.text

    def test_kubectl_prefix_flag_dedup(self) -> None:
        """kubectl logs --prefix emits [pod/name/container] prefix; same message collapses."""
        lines = []
        for i in range(60):
            ts = f"2026-05-30T12:00:{i:02d}Z"
            pod = "pod-abc" if i % 2 == 0 else "pod-def"
            lines.append(f"[pod/{pod}/main] {ts} INFO connected to cache")
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "--prefix", "-l", "app=svc"])
        assert "more similar lines omitted" in result.text

    def test_follow_cap_applied_to_very_long_output(self) -> None:
        """Very long --follow output is capped at head=40, tail=40."""
        lines = [f"2026-05-30T12:{i // 60:02d}:{i % 60:02d}Z INFO line {i}" for i in range(500)]
        text = "\n".join(lines)
        f = self._filter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "-f", "my-pod"])
        # Should be significantly compressed — well under 500 lines
        result_lines = [ln for ln in result.text.splitlines() if ln.strip()]
        assert len(result_lines) < 200
        # Marker should indicate elision
        assert "elided" in result.text or "omitted" in result.text

    # --- integration: no filter for kubectl get ---

    def test_kubectl_get_not_routed_to_logs_filter(self) -> None:
        """KubectlLogsFilter must not intercept kubectl get."""
        f = bc.select_filter(["kubectl", "get", "deployments"])
        assert f is not None
        assert not isinstance(f, bc.KubectlLogsFilter)


# ---------------------------------------------------------------------------
# Cross-filter ordering sanity
# ---------------------------------------------------------------------------


class TestFilterOrdering:
    """Verify FILTERS list ordering invariants."""

    def test_docker_compose_before_docker(self) -> None:
        dc_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.DockerComposeFilter)
        )
        d_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.DockerFilter)
        )
        assert dc_idx < d_idx, "DockerComposeFilter must precede DockerFilter"

    def test_kubectl_logs_before_kubectl(self) -> None:
        kl_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.KubectlLogsFilter)
        )
        k_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.KubectlFilter)
        )
        assert kl_idx < k_idx, "KubectlLogsFilter must precede KubectlFilter"

    def test_helm_before_kubectl(self) -> None:
        h_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.HelmFilter)
        )
        k_idx = next(
            i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.KubectlFilter)
        )
        assert h_idx < k_idx, "HelmFilter must precede KubectlFilter"

    def test_helm_not_in_kubectl_binaries(self) -> None:
        kubectl = next(f for f in bc.FILTERS if isinstance(f, bc.KubectlFilter))
        assert "helm" not in kubectl.binaries, (
            "helm binary should be claimed by HelmFilter, not KubectlFilter"
        )
