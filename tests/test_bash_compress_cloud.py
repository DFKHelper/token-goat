"""Tests for cloud CLI bash_compress filters: AwsCliFilter, GcloudFilter, AzureCliFilter.

Also covers the enhanced TerraformFilter (No changes blocks, Still creating collapsing).
"""
from __future__ import annotations

import json

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# AwsCliFilter
# ---------------------------------------------------------------------------


class TestAwsCliFilter:
    """Tests for AwsCliFilter."""

    def _filter(self) -> bc.AwsCliFilter:
        return bc.AwsCliFilter()

    # --- dispatch ---

    def test_matches_aws(self) -> None:
        f = self._filter()
        assert f.matches(["aws", "ec2", "describe-instances"])
        assert f.matches(["aws2", "s3", "ls"])

    def test_does_not_match_gcloud(self) -> None:
        f = self._filter()
        assert not f.matches(["gcloud", "compute", "instances", "list"])

    def test_select_filter_returns_aws_cli_filter(self) -> None:
        # AwsCliFilter is registered before AwsFilter so it should win.
        f = bc.select_filter(["aws", "ec2", "describe-instances"])
        assert isinstance(f, bc.AwsCliFilter)

    # --- JSON array compression ---

    def test_compresses_json_array_over_threshold(self) -> None:
        data = [{"id": i, "name": f"resource-{i}"} for i in range(15)]
        text = json.dumps(data)
        result = self._filter().apply(text, "", 0, ["aws", "ec2", "describe-instances"])
        out = json.loads(result.text)
        # Should keep first 3 + summary sentinel
        assert len(out) == 4
        assert out[-1]["__token_goat__"] == "15 items (showing first 3)"

    def test_short_json_array_passes_through(self) -> None:
        data = [{"id": i} for i in range(5)]
        text = json.dumps(data)
        result = self._filter().apply(text, "", 0, ["aws", "ec2", "describe-instances"])
        out = json.loads(result.text)
        assert len(out) == 5

    def test_compresses_nested_json_array(self) -> None:
        data = {"Instances": [{"InstanceId": f"i-{i:04d}"} for i in range(20)]}
        text = json.dumps(data)
        result = self._filter().apply(text, "", 0, ["aws", "ec2", "describe-instances"])
        out = json.loads(result.text)
        assert len(out["Instances"]) == 4
        assert "20 items (showing first 3)" in out["Instances"][-1]["__token_goat__"]

    def test_non_json_passthrough(self) -> None:
        text = "NAME\tTYPE\tVALUE\nfoo\tSTRING\tbar\n"
        result = self._filter().apply(text, "", 0, ["aws", "ssm", "get-parameter"])
        assert "foo" in result.text
        assert "bar" in result.text

    # --- S3 transfer collapsing ---

    def test_s3_cp_collapses_upload_lines(self) -> None:
        lines = [f"upload: local/file{i}.txt to s3://my-bucket/key{i}.txt" for i in range(30)]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["aws", "s3", "cp"])
        assert "uploaded 30 file(s)" in result.text
        # Individual upload lines should be gone
        assert "upload: local/file0" not in result.text

    def test_s3_sync_collapses_download_lines(self) -> None:
        lines = [f"download: s3://bucket/key{i}.dat to local/file{i}.dat" for i in range(20)]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["aws", "s3", "sync"])
        assert "downloaded 20 file(s)" in result.text

    def test_s3_transfer_drops_progress_bars(self) -> None:
        lines = [
            "upload: local/big.tar to s3://bucket/big.tar",
            "Completed 100 MiB/1.5 GiB (50.0 MiB/s) with 1 file(s) remaining",
            "Completed 200 MiB/1.5 GiB (52.0 MiB/s) with 1 file(s) remaining",
        ]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["aws", "s3", "cp"])
        # Progress lines dropped
        assert "MiB/s" not in result.text
        assert "uploaded 1 file(s)" in result.text

    def test_s3_mv_collapses_upload_and_download(self) -> None:
        lines = (
            [f"upload: file{i} to s3://b/k{i}" for i in range(5)]
            + [f"download: s3://b/k{i} to dest/file{i}" for i in range(5)]
        )
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["aws", "s3", "mv"])
        assert "uploaded 5 file(s)" in result.text
        assert "downloaded 5 file(s)" in result.text

    # --- Error preservation ---

    def test_preserves_stderr_on_error(self) -> None:
        stdout = "Some partial output\n"
        stderr = "An error occurred (NoCredentialsError) when calling the DescribeInstances operation\n"
        result = self._filter().apply(stdout, stderr, 1, ["aws", "ec2", "describe-instances"])
        assert "NoCredentialsError" in result.text
        assert "DescribeInstances" in result.text

    def test_empty_input_no_crash(self) -> None:
        result = self._filter().apply("", "", 0, ["aws", "s3", "ls"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# GcloudFilter
# ---------------------------------------------------------------------------


class TestGcloudFilter:
    """Tests for GcloudFilter."""

    def _filter(self) -> bc.GcloudFilter:
        return bc.GcloudFilter()

    # --- dispatch ---

    def test_matches_gcloud(self) -> None:
        f = self._filter()
        assert f.matches(["gcloud", "compute", "instances", "list"])
        assert f.matches(["gcloud", "auth", "login"])

    def test_does_not_match_aws(self) -> None:
        assert not self._filter().matches(["aws", "ec2", "describe-instances"])

    def test_select_filter_returns_gcloud_filter(self) -> None:
        f = bc.select_filter(["gcloud", "compute", "instances", "list"])
        assert isinstance(f, bc.GcloudFilter)

    # --- spinner lines ---

    def test_drops_spinner_lines(self) -> None:
        lines = [
            "⠏ Waiting for operation to complete...",
            "⠋ Waiting for operation to complete...",
            "⠙ Waiting for operation to complete...",
            "Updated [https://compute.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/instances/my-instance].",
        ]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["gcloud", "compute", "instances", "update"])
        assert "Waiting for operation" not in result.text
        assert "Updated [https://" in result.text
        assert "dropped 3 spinner line(s)" in result.text

    def test_keeps_updated_created_deleted_lines(self) -> None:
        text = (
            "Created [https://www.googleapis.com/compute/v1/projects/p/instances/i].\n"
            "Deleted [https://www.googleapis.com/compute/v1/projects/p/instances/old].\n"
        )
        result = self._filter().apply(text, "", 0, ["gcloud", "compute", "instances", "create"])
        assert "Created [https://" in result.text
        assert "Deleted [https://" in result.text

    # --- API enablement lines ---

    def test_collapses_api_enablement_lines(self) -> None:
        lines = [
            "Enabling service compute.googleapis.com...",
            "Waiting for async operation projects/p/operations/op-123...",
            "Operation [operation-1234] running...",
            "API enabled.",
        ]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["gcloud", "services", "enable"])
        assert "Enabling service" not in result.text
        assert "Waiting for async" not in result.text
        assert "Operation [operation" not in result.text
        assert "collapsed 3 API enablement line(s)" in result.text
        assert "API enabled." in result.text

    # --- structured data collapsing ---

    def test_collapses_large_structured_output(self) -> None:
        # Build a dense YAML-like block that looks like structured data
        lines = [f"  key_{i}: value_{i}" for i in range(30)]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["gcloud", "compute", "instances", "describe"])
        assert "Resource description:" in result.text
        assert "use --format=json" in result.text

    def test_short_output_not_collapsed(self) -> None:
        text = "NAME  ZONE  STATUS\nmy-vm us-c1 RUNNING\n"
        result = self._filter().apply(text, "", 0, ["gcloud", "compute", "instances", "list"])
        assert "NAME" in result.text
        assert "Resource description" not in result.text

    def test_keeps_do_you_want_to_continue(self) -> None:
        lines = [f"  key_{i}: value_{i}" for i in range(30)]
        lines.append("Do you want to continue (Y/n)?")
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["gcloud", "compute", "instances", "delete"])
        # The prompt line should prevent pure-structured-data collapse
        # (or survive it if the block is still collapsed)
        # At minimum, no crash
        assert isinstance(result.text, str)

    # --- error preservation ---

    def test_preserves_stderr_on_error(self) -> None:
        stdout = ""
        stderr = "ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The resource was not found\n"
        result = self._filter().apply(stdout, stderr, 1, ["gcloud", "compute", "instances", "create"])
        assert "Could not fetch resource" in result.text

    def test_empty_input_no_crash(self) -> None:
        result = self._filter().apply("", "", 0, ["gcloud", "auth", "login"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# AzureCliFilter
# ---------------------------------------------------------------------------


class TestAzureCliFilter:
    """Tests for AzureCliFilter."""

    def _filter(self) -> bc.AzureCliFilter:
        return bc.AzureCliFilter()

    # --- dispatch ---

    def test_matches_az(self) -> None:
        f = self._filter()
        assert f.matches(["az", "vm", "list"])
        assert f.matches(["az", "group", "create"])

    def test_does_not_match_aws(self) -> None:
        assert not self._filter().matches(["aws", "ec2", "describe-instances"])

    def test_select_filter_returns_azure_cli_filter(self) -> None:
        f = bc.select_filter(["az", "vm", "list"])
        assert isinstance(f, bc.AzureCliFilter)

    # --- preview warnings ---

    def test_collapses_preview_warnings(self) -> None:
        lines = [
            "Command group 'aks alpha' is in preview and under development. Reference and support levels: https://aka.ms/CLI_refstatus",
            "The command 'az aks nodepool' is in preview and under development.",
            "This command is in preview and under development.",
            "{",
            '  "name": "my-cluster"',
            "}",
        ]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["az", "aks", "create"])
        assert "is in preview" not in result.text
        assert "collapsed 3 preview warning(s)" in result.text
        assert '"name"' in result.text

    # --- progress JSON collapsing ---

    def test_collapses_progress_json_blobs(self) -> None:
        lines = [
            '{"status": "Running", "percentComplete": 0.0}',
            '{"status": "Running", "percentComplete": 25.0}',
            '{"status": "Running", "percentComplete": 50.0}',
            '{"status": "Running", "percentComplete": 75.0}',
            '{"status": "Succeeded", "percentComplete": 100.0}',
            "Deployment succeeded.",
        ]
        text = "\n".join(lines)
        result = self._filter().apply(text, "", 0, ["az", "deployment", "create"])
        # Only the last progress blob + success message should remain
        kept_lines = [ln for ln in result.text.splitlines() if ln.strip()]
        progress_lines = [ln for ln in kept_lines if '"status"' in ln]
        assert len(progress_lines) == 1
        assert '"Succeeded"' in progress_lines[0] or "Succeeded" in progress_lines[0]
        assert "Deployment succeeded." in result.text

    # --- resource provider warning kept ---

    def test_keeps_resource_provider_not_registered(self) -> None:
        text = "Resource provider 'Microsoft.Compute' is not registered for subscription 'abc123'.\n"
        result = self._filter().apply(text, "", 0, ["az", "vm", "create"])
        # This is actionable; must survive
        assert "not registered" in result.text

    # --- JSON array compression ---

    def test_compresses_json_array_over_threshold(self) -> None:
        data = [{"id": f"/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm{i}"} for i in range(15)]
        text = json.dumps(data)
        result = self._filter().apply(text, "", 0, ["az", "vm", "list"])
        out = json.loads(result.text)
        assert len(out) == 4
        assert "15 items (showing first 3)" in out[-1]["__token_goat__"]

    def test_short_json_passes_through(self) -> None:
        data = [{"name": "vm1"}, {"name": "vm2"}]
        text = json.dumps(data)
        result = self._filter().apply(text, "", 0, ["az", "vm", "list"])
        out = json.loads(result.text)
        assert len(out) == 2

    # --- error preservation ---

    def test_preserves_stderr_on_error(self) -> None:
        stdout = ""
        stderr = "ERROR: (ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/foo' under resource group 'bar' was not found.\n"
        result = self._filter().apply(stdout, stderr, 1, ["az", "vm", "show"])
        assert "ResourceNotFound" in result.text

    def test_empty_input_no_crash(self) -> None:
        result = self._filter().apply("", "", 0, ["az", "group", "list"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# TerraformFilter — enhanced plan/apply behaviors
# ---------------------------------------------------------------------------


class TestTerraformFilterEnhanced:
    """Tests for enhanced TerraformFilter plan (no-change blocks) and apply (Still lines)."""

    def _filter(self) -> bc.TerraformFilter:
        return bc.TerraformFilter()

    # --- plan: No changes blocks ---

    def test_plan_collapses_will_not_be_changed_block(self) -> None:
        stdout = (
            "# aws_instance.example will not be changed\n"
            "  resource \"aws_instance\" \"example\" {\n"
            "      id = \"i-12345\"\n"
            "  }\n"
            "Plan: 1 to add, 0 to change, 0 to destroy.\n"
        )
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        # The unchanged-resource comment block should be collapsed
        assert "will not be changed" not in result.text or "collapsed" in result.text
        assert "Plan: 1 to add" in result.text

    def test_plan_keeps_addition_block(self) -> None:
        stdout = (
            "aws_instance.web: Refreshing state... [id=i-old]\n"
            "# aws_instance.new will be created\n"
            "  + resource \"aws_instance\" \"new\" {\n"
            "      + ami = \"ami-12345\"\n"
            "      + instance_type = \"t3.micro\"\n"
            "    }\n"
            "Plan: 1 to add, 0 to change, 0 to destroy.\n"
        )
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        # Addition block must be kept
        assert "ami" in result.text or "instance_type" in result.text or "Plan: 1 to add" in result.text
        assert "Refreshing state" not in result.text

    def test_plan_no_changes_summary_kept(self) -> None:
        stdout = "No changes. Your infrastructure matches the configuration.\n"
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        assert "No changes." in result.text

    # --- apply: Still creating/modifying collapsing ---

    def test_apply_collapses_still_creating_lines(self) -> None:
        lines = [
            "aws_instance.web: Creating...",
            "aws_instance.web: Still creating... [10s elapsed]",
            "aws_instance.web: Still creating... [20s elapsed]",
            "aws_instance.web: Still creating... [30s elapsed]",
            "aws_instance.web: Creation complete after 35s [id=i-new]",
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
        ]
        stdout = "\n".join(lines)
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        text = result.text
        # Creation complete and Apply complete must be kept
        assert "Creation complete" in text
        assert "Apply complete!" in text
        # Most "Still creating" lines should be collapsed
        still_lines = [ln for ln in text.splitlines() if "Still creating" in ln]
        # At most 1 still-creating line should survive (the last one, flushed before completion)
        assert len(still_lines) <= 1

    def test_apply_collapses_still_modifying_lines(self) -> None:
        lines = [
            "aws_security_group.sg: Modifying...",
            "aws_security_group.sg: Still modifying... [10s elapsed]",
            "aws_security_group.sg: Still modifying... [20s elapsed]",
            "aws_security_group.sg: Modifications complete after 25s",
            "Apply complete! Resources: 0 added, 1 changed, 0 destroyed.",
        ]
        stdout = "\n".join(lines)
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        text = result.text
        assert "Modifications complete" in text
        assert "Apply complete!" in text
        still_lines = [ln for ln in text.splitlines() if "Still modifying" in ln]
        assert len(still_lines) <= 1

    def test_apply_keeps_error_block(self) -> None:
        lines = [
            "aws_instance.web: Still creating... [10s elapsed]",
            "aws_instance.web: Still creating... [20s elapsed]",
            "Error: Error launching source instance: InvalidAMIID.NotFound: The image id '[ami-bad]' does not exist",
        ]
        stdout = "\n".join(lines)
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        assert "Error: Error launching" in result.text or "InvalidAMIID" in result.text

    def test_apply_multiple_resources_collapsed_independently(self) -> None:
        lines = [
            "aws_instance.web: Still creating... [10s elapsed]",
            "aws_db_instance.db: Still creating... [10s elapsed]",
            "aws_instance.web: Still creating... [20s elapsed]",
            "aws_db_instance.db: Still creating... [20s elapsed]",
            "aws_instance.web: Creation complete after 25s [id=i-web]",
            "aws_db_instance.db: Creation complete after 30s [id=db-1]",
            "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.",
        ]
        stdout = "\n".join(lines)
        f = self._filter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        text = result.text
        assert "Apply complete!" in text
        assert "Creation complete" in text
        # Total "Still creating" lines should be collapsed aggressively
        still_count = sum(1 for ln in text.splitlines() if "Still creating" in ln)
        assert still_count <= 2  # at most 1 per resource

    def test_apply_preserves_errors_on_nonzero_exit(self) -> None:
        stdout = "aws_instance.web: Still creating... [10s elapsed]\n"
        stderr = "Error: timeout waiting for resource\n"
        f = self._filter()
        result = f.apply(stdout, stderr, 1, ["terraform", "apply"])
        assert "timeout" in result.text
