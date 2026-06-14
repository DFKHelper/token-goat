"""Tests for VaultFilter and PackerFilter — two filters with no prior coverage."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# VaultFilter
# ---------------------------------------------------------------------------

_VAULT_KV_GET = """\
Key                 Value
---                 -----
lease_id            secret/data/myapp/db
lease_renewable     false
lease_duration      768h
request_id          b1e3c0f2-1234-5678-abcd-ef0987654321
Key     Value
---     -----
db_url  postgres://db:5432/mydb
password  s3cr3t!
"""

_VAULT_AUTH_LOGIN = """\
Key                    Value
---                    -----
token                  s.ABCDEFGHIJKLMNOPQRSTUVwX
token_accessor         yYzZ123456
token_duration         1h
token_renewable        true
token_policies         ["default","dev-policy"]
token_type             service
lease_id               auth/token/create
lease_duration         1h
lease_renewable        true
renewable              true
request_id             aaa-bbb-ccc
Success! You are now authenticated. The token information displayed below
is already stored in the token helper. You do NOT need to run "vault login"
again. Future Vault requests will automatically use this token.
"""

_VAULT_KV_PUT_SUCCESS = """\
Key              Value
---              -----
created_time     2024-01-15T10:30:00.000000000Z
custom_metadata  <nil>
deletion_time    n/a
destroyed        false
version          3
Success! Data written to: secret/data/myapp/config
"""

_VAULT_KV_LIST_LARGE = """\
Keys
  apikeys/
  config/
  credentials/
  databases/
  deployments/
  env/
  internal/
  keys/
  monitoring/
  network/
  prod/
  secrets/
  services/
  staging/
  tokens/
  tls/
  users/
"""

_VAULT_KV_LIST_SMALL = """\
Keys
  config/
  credentials/
  databases/
"""

_VAULT_ERROR = """\
Error writing data to secret/data/myapp/config: Error making API request.

URL: PUT http://127.0.0.1:8200/v1/secret/data/myapp/config
Code: 403. Errors:

* permission denied
"""

_VAULT_WARNING = """\
WARNING! The VAULT_ADDR environment variable is not set. Defaulting to https://127.0.0.1:8200.
Key   Value
---   -----
db_pass   secret123
"""


class TestVaultFilter(FilterTestMixin):
    F = bc.VaultFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_vault(self) -> None:
        assert self.F.matches(["vault", "kv", "get", "secret/myapp"])

    def test_matches_vault_login(self) -> None:
        assert self.F.matches(["vault", "login"])

    def test_matches_vault_list(self) -> None:
        assert self.F.matches(["vault", "kv", "list", "secret/"])

    def test_matches_vault_write(self) -> None:
        assert self.F.matches(["vault", "kv", "put", "secret/foo", "key=val"])

    def test_no_match_kubectl(self) -> None:
        assert not self.F.matches(["kubectl", "get", "secret"])

    def test_no_match_terraform(self) -> None:
        assert not self.F.matches(["terraform", "apply"])

    def test_no_match_empty(self) -> None:
        assert not self.F.matches([])

    # --- select ------------------------------------------------------------

    def test_select_routes_vault(self) -> None:
        assert isinstance(bc.select_filter(["vault", "kv", "get", "secret/"]), bc.VaultFilter)

    def test_select_routes_vault_login(self) -> None:
        assert isinstance(bc.select_filter(["vault", "login", "-method=ldap"]), bc.VaultFilter)

    # --- compress: lease/token metadata collapsed -------------------------

    def test_lease_meta_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        assert "collapsed" in out
        assert "Vault lease/token metadata" in out

    def test_lease_id_not_verbatim(self) -> None:
        # lease_id is in the meta regex — must be collapsed, not appear verbatim
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        assert "lease_id" not in out

    def test_token_policies_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_VAULT_AUTH_LOGIN)
        assert "token_policies" not in out

    def test_lease_duration_not_verbatim(self) -> None:
        # lease_duration is in the meta regex — must be collapsed
        out = _compress(self.F, stdout=_VAULT_AUTH_LOGIN)
        assert "lease_duration" not in out

    def test_renewable_not_verbatim(self) -> None:
        # renewable and request_id are meta fields — must be collapsed
        out = _compress(self.F, stdout=_VAULT_AUTH_LOGIN)
        assert "renewable" not in out
        assert "request_id" not in out

    # --- compress: table dividers dropped ----------------------------------

    def test_table_dividers_dropped(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        assert "dropped" in out
        assert "table divider" in out

    def test_divider_lines_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        # "--- -----" style divider lines must be gone
        lines = out.splitlines()
        assert not any(ln.strip().startswith("---") and "---" in ln for ln in lines)

    # --- compress: meaningful content kept --------------------------------

    def test_secret_data_values_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        assert "db_url" in out
        assert "password" in out

    def test_success_line_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_PUT_SUCCESS)
        assert "Success! Data written to:" in out

    def test_auth_success_message_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_AUTH_LOGIN)
        assert "Success!" in out

    def test_key_value_header_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_GET)
        # "Key   Value" header line matches _VAULT_HEADER_RE via "Key\s+Value"
        assert "Key" in out and "Value" in out

    def test_warning_line_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_WARNING)
        assert "WARNING!" in out

    # --- compress: kv list — large list collapsed -------------------------

    def test_large_list_collapsed(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_LIST_LARGE, argv=["vault", "kv", "list", "secret/"])
        assert "secret path(s) omitted" in out

    def test_large_list_first_five_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_LIST_LARGE, argv=["vault", "kv", "list", "secret/"])
        # First 5 items must appear
        assert "apikeys/" in out
        assert "config/" in out
        assert "credentials/" in out
        assert "databases/" in out
        assert "deployments/" in out

    def test_large_list_items_beyond_five_dropped(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_LIST_LARGE, argv=["vault", "kv", "list", "secret/"])
        # Items beyond the first 5 should not appear verbatim
        assert "monitoring/" not in out
        assert "tls/" not in out

    def test_small_list_kept_verbatim(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_LIST_SMALL, argv=["vault", "kv", "list", "secret/"])
        # <= 10 items: all kept verbatim, no collapse marker
        assert "config/" in out
        assert "credentials/" in out
        assert "databases/" in out
        # The 3 items are below the collapse threshold — no omitted marker
        assert "path(s) omitted" not in out

    def test_list_keys_header_kept(self) -> None:
        out = _compress(self.F, stdout=_VAULT_KV_LIST_LARGE, argv=["vault", "kv", "list", "secret/"])
        assert "Keys" in out

    def test_vault_list_subcommand_also_collapses(self) -> None:
        # "vault list" (without kv) should also trigger list-collapse logic
        out = _compress(self.F, stdout=_VAULT_KV_LIST_LARGE, argv=["vault", "list", "secret/"])
        assert "secret path(s) omitted" in out

    # --- compress: error passthrough (exit_code != 0) ---------------------

    def test_error_passthrough_on_nonzero_exit(self) -> None:
        out = _compress(self.F, stdout="", stderr=_VAULT_ERROR, exit_code=1)
        assert "permission denied" in out

    def test_error_passthrough_preserves_stderr(self) -> None:
        stderr = "Error: vault.HashiCorp.com is unreachable\n"
        out = _compress(self.F, stdout="vault\n", stderr=stderr, exit_code=1)
        assert "unreachable" in out

    def test_error_lines_kept_on_success_exit(self) -> None:
        # Even on exit_code=0, inline error signals are kept
        out = _compress(self.F, stdout=_VAULT_ERROR, stderr="", exit_code=0)
        assert "Error making API request" in out  # matches _ERROR_SIGNAL_RE
        assert "permission denied" in out

    # --- compression ratio ------------------------------------------------

    def test_significant_compression_on_auth_output(self) -> None:
        result = bc.VaultFilter().apply(_VAULT_AUTH_LOGIN, "", 0, ["vault", "login"])
        assert result.compressed_bytes < result.original_bytes * 0.75

    def test_exported_in_all(self) -> None:
        assert "VaultFilter" in bc.__all__


# ---------------------------------------------------------------------------
# PackerFilter
# ---------------------------------------------------------------------------

_PACKER_AMI_BUILD = """\
==> amazon-ebs.ubuntu: Prevalidating any provided VPC information
==> amazon-ebs.ubuntu: Prevalidating AMI Name: my-ubuntu-20241215
==> amazon-ebs.ubuntu: Creating temporary keypair: packer_abc123
==> amazon-ebs.ubuntu: Creating temporary security group: packer_abc123
==> amazon-ebs.ubuntu: Authorizing access to port 22 on the temporary security group
==> amazon-ebs.ubuntu: Launching a source AWS instance...
    amazon-ebs.ubuntu: Instance ID: i-0abc123def456789
==> amazon-ebs.ubuntu: Waiting for instance (i-0abc123def456789) to become ready...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Connected to SSH!
==> amazon-ebs.ubuntu: Stopping the source instance...
    amazon-ebs.ubuntu: Stopping instance
==> amazon-ebs.ubuntu: Waiting for the instance to stop...
==> amazon-ebs.ubuntu: Creating AMI my-ubuntu-20241215 from instance i-0abc123def456789
==> amazon-ebs.ubuntu: AMI: ami-0123456789abcdef0
    amazon-ebs.ubuntu: Waiting for AMI to become ready...
    amazon-ebs.ubuntu: Waiting for AMI to become ready...
    amazon-ebs.ubuntu: Waiting for AMI to become ready...
    amazon-ebs.ubuntu: Waiting for AMI to become ready...
==> amazon-ebs.ubuntu: Tagging the AMI (ami-0123456789abcdef0) and snapshots...
==> amazon-ebs.ubuntu: Creating AMI tags
==> amazon-ebs.ubuntu: Terminating the source AWS instance...
==> amazon-ebs.ubuntu: Deleting temporary security group...
==> amazon-ebs.ubuntu: Deleting temporary keypair...
Build 'amazon-ebs.ubuntu' finished after 8 minutes 42 seconds.

==> Wait completed after 8 minutes 42 seconds

==> Builds finished. The artifacts of successful builds are:
--> amazon-ebs.ubuntu: AMIs were created:
us-east-1: ami-0123456789abcdef0
"""

_PACKER_WITH_PROVISIONERS = """\
==> docker.ubuntu: Creating a temporary directory to store files for uploading...
==> docker.ubuntu: Running provisioner: file
==> docker.ubuntu: Uploading scripts/ => /tmp/scripts/
==> docker.ubuntu: Running provisioner: shell
==> docker.ubuntu: Provisioning with shell script: /tmp/packer-shell123.sh
    docker.ubuntu: + apt-get update
    docker.ubuntu: + apt-get install -y nginx
==> docker.ubuntu: Running provisioner: ansible-local
==> docker.ubuntu: Executing Ansible: ansible-playbook --connection=local site.yml
==> docker.ubuntu: Pausing 5 seconds before next provisioner...
    docker.ubuntu: PLAY [all] ****
Build 'docker.ubuntu' finished.

==> Builds finished. The artifacts of successful builds are:
--> docker.ubuntu: Exported Docker file: output.tar
"""

_PACKER_WITH_NETWORK_NOISE = """\
==> amazon-ebs.ubuntu: Launching a source AWS instance...
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: [c] Received disconnect from 10.0.0.1 port 22:11: disconnected by user
    amazon-ebs.ubuntu: [c] Net tcp keepalive failed
    amazon-ebs.ubuntu: Waiting for SSH to become available...
    amazon-ebs.ubuntu: Connected to SSH!
==> amazon-ebs.ubuntu: Creating AMI my-image
--> amazon-ebs.ubuntu: AMI: ami-abc12345
"""

_PACKER_ERROR = """\
==> amazon-ebs.ubuntu: Launching a source AWS instance...
==> amazon-ebs.ubuntu: Waiting for instance to become ready...
Build 'amazon-ebs.ubuntu' errored after 2 minutes 1 second: Error launching source
instance: InvalidAMIID.NotFound: The image id 'ami-bad12345' does not exist
    amazon-ebs.ubuntu: Waiting for SSH: Error connecting to instance
"""


class TestPackerFilter(FilterTestMixin):
    F = bc.PackerFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_packer_build(self) -> None:
        assert self.F.matches(["packer", "build", "template.pkr.hcl"])

    def test_matches_packer_validate(self) -> None:
        assert self.F.matches(["packer", "validate", "."])

    def test_matches_packer_init(self) -> None:
        assert self.F.matches(["packer", "init", "."])

    def test_no_match_terraform(self) -> None:
        assert not self.F.matches(["terraform", "apply"])

    def test_no_match_ansible(self) -> None:
        assert not self.F.matches(["ansible-playbook", "site.yml"])

    def test_no_match_docker(self) -> None:
        assert not self.F.matches(["docker", "build", "."])

    def test_no_match_empty(self) -> None:
        assert not self.F.matches([])

    # --- select ------------------------------------------------------------

    def test_select_routes_packer(self) -> None:
        assert isinstance(bc.select_filter(["packer", "build", "."]), bc.PackerFilter)

    def test_select_routes_packer_validate(self) -> None:
        assert isinstance(bc.select_filter(["packer", "validate", "."]), bc.PackerFilter)

    # --- compress: SSH poll lines collapsed --------------------------------

    def test_ssh_wait_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "SSH/WinRM connection-wait poll line(s) collapsed" in out

    def test_ssh_wait_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Waiting for SSH to become available..." not in out

    def test_ami_wait_also_collapsed(self) -> None:
        # "Waiting for AMI to become ready..." are also poll lines
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Waiting for AMI to become ready..." not in out

    # --- compress: provisioner step announcements collapsed ---------------

    def test_provisioner_lines_collapsed(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "provisioner step announcement" in out

    def test_running_provisioner_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "Running provisioner: file" not in out
        assert "Running provisioner: shell" not in out

    def test_uploading_not_verbatim(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "Uploading scripts/ =>" not in out

    # --- compress: network heartbeat/pause lines dropped ------------------

    def test_network_noise_dropped(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_NETWORK_NOISE)
        assert "network/heartbeat" in out and "dropped" in out

    def test_received_disconnect_not_verbatim(self) -> None:
        # "[c] Received disconnect" has no error keyword — dropped as network noise
        out = _compress(self.F, stdout=_PACKER_WITH_NETWORK_NOISE)
        assert "[c] Received disconnect" not in out

    def test_keepalive_failed_kept_as_error_signal(self) -> None:
        # "[c] Net tcp keepalive failed" contains "failed" → kept by _ERROR_SIGNAL_RE
        # (error signals always take priority over noise suppression)
        out = _compress(self.F, stdout=_PACKER_WITH_NETWORK_NOISE)
        assert "[c] Net tcp keepalive failed" in out

    def test_pause_lines_dropped(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "Pausing 5 seconds" not in out

    # --- compress: build step lines kept ----------------------------------

    def test_creating_step_lines_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Creating temporary keypair" in out

    def test_stopping_step_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Stopping the source instance" in out

    def test_tagging_step_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Tagging the AMI" in out

    def test_terminating_step_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Terminating the source AWS instance" in out

    def test_deleting_step_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Deleting temporary security group" in out

    # --- compress: artifact / summary lines kept --------------------------

    def test_builds_finished_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Builds finished" in out

    def test_ami_artifact_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        # "--> amazon-ebs.ubuntu: AMIs were created:" is an artifact line
        assert "AMIs were created" in out

    def test_ami_id_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "ami-0123456789abcdef0" in out

    def test_build_finished_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_AMI_BUILD)
        assert "Build 'amazon-ebs.ubuntu' finished" in out

    def test_exported_artifact_kept(self) -> None:
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "Exported Docker file: output.tar" in out

    # --- compress: error passthrough (exit_code != 0) ---------------------

    def test_error_passthrough_on_nonzero_exit(self) -> None:
        out = _compress(self.F, stdout="", stderr=_PACKER_ERROR, exit_code=1)
        assert "InvalidAMIID.NotFound" in out

    def test_error_passthrough_preserves_full_stderr(self) -> None:
        stderr = "Error: Failed to initialize plugin: plugin not found\n"
        out = _compress(self.F, stdout="==> packer: prevalidating\n", stderr=stderr, exit_code=1)
        assert "Failed to initialize plugin" in out

    def test_error_lines_kept_on_zero_exit(self) -> None:
        # Inline "error" signals are kept regardless of exit code.
        # The "Waiting for SSH: Error..." line matches _PACKER_WAITING_RE but
        # is kept because _ERROR_SIGNAL_RE fires first -- proves ordering.
        out = _compress(self.F, stdout=_PACKER_ERROR, stderr="", exit_code=0)
        assert "errored" in out.lower() and "Error" in out
        assert "Error connecting to instance" in out

    # --- compression ratio ------------------------------------------------

    def test_significant_compression_on_ami_build(self) -> None:
        result = bc.PackerFilter().apply(_PACKER_AMI_BUILD, "", 0, ["packer", "build", "."])
        assert result.compressed_bytes < result.original_bytes * 0.75

    def test_exported_in_all(self) -> None:
        assert "PackerFilter" in bc.__all__

    def test_clean_output_passthrough(self) -> None:
        # Minimal output with just artifact lines should pass through cleanly
        output = "==> Builds finished. The artifacts of successful builds are:\n"
        out = _compress(self.F, stdout=output)
        assert "Builds finished" in out

    # --- compress: Retrying in N seconds pattern --------------------------

    def test_retrying_in_seconds_collapsed(self) -> None:
        # "Retrying in N seconds" matches _PACKER_WAITING_RE -- must be collapsed
        fixture = (
            "==> amazon-ebs.ubuntu: Launching a source AWS instance...\n"
            "    amazon-ebs.ubuntu: Retrying in 30 seconds...\n"
            "    amazon-ebs.ubuntu: Retrying in 30 seconds...\n"
            "    amazon-ebs.ubuntu: Retrying in 30 seconds...\n"
            "--> amazon-ebs.ubuntu: AMI: ami-abc12345\n"
        )
        out = _compress(self.F, stdout=fixture)
        assert "SSH/WinRM connection-wait poll line(s) collapsed" in out
        assert "Retrying in 30 seconds" not in out

    # --- compress: inline provisioner command output kept -----------------

    def test_inline_provisioner_command_output_kept(self) -> None:
        # Lines emitted by the provisioner itself (indented, no ==> prefix)
        # must pass through verbatim -- only step announcements are collapsed.
        out = _compress(self.F, stdout=_PACKER_WITH_PROVISIONERS)
        assert "docker.ubuntu: + apt-get update" in out
        assert "docker.ubuntu: + apt-get install -y nginx" in out
