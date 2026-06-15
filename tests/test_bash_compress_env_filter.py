"""Tests for EnvFilter — env/printenv environment-variable dump compression."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Fixture data
# ---------------------------------------------------------------------------

# A short env dump (≤20 vars) — should pass through unchanged.
_SHORT_ENV = "\n".join([
    "HOME=/home/user",
    "SHELL=/bin/bash",
    "USER=alice",
    "TERM=xterm-256color",
    "LANG=en_US.UTF-8",
    "PWD=/home/user/projects",
]) + "\n"

# A large realistic env dump (>20 vars) with a mix of keep/suppress vars.
_LARGE_ENV_LINES = [
    "HOME=/home/user",
    "SHELL=/bin/bash",
    "USER=alice",
    "LOGNAME=alice",
    "USERNAME=alice",
    "TERM=xterm-256color",
    "LANG=en_US.UTF-8",
    "LC_ALL=en_US.UTF-8",
    "TZ=UTC",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "PWD=/home/user/projects",
    "OLDPWD=/home/user",
    "VIRTUAL_ENV=/home/user/.venv",
    "VIRTUAL_ENV_PROMPT=(.venv)",
    "PYTHONPATH=/home/user/lib",
    "NODE_ENV=production",
    "NODE_VERSION=20.11.0",
    "GOPATH=/home/user/go",
    "CARGO_HOME=/home/user/.cargo",
    "JAVA_HOME=/usr/lib/jvm/java-17",
    # suppressed below this line
    "SHLVL=2",
    "LS_COLORS=rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35",
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
    "XDG_RUNTIME_DIR=/run/user/1000",
    "XDG_SESSION_TYPE=x11",
    "DESKTOP_SESSION=gnome",
    "DISPLAY=:0",
    "WINDOWID=12345678",
    "XAUTHORITY=/home/user/.Xauthority",
    "GPG_AGENT_INFO=/run/user/1000/gnupg/S.gpg-agent:0:1",
    "SSH_AUTH_SOCK=/tmp/ssh-abc123/agent.1234",
    "QT_ACCESSIBILITY=1",
    "LESSOPEN=| /usr/bin/lesspipe %s",
]
_LARGE_ENV = "\n".join(_LARGE_ENV_LINES) + "\n"

# Env dump with GITHUB_ prefix vars — should all be kept.
_CI_ENV_LINES = _LARGE_ENV_LINES + [
    "GITHUB_ACTIONS=true",
    "GITHUB_RUN_ID=12345",
    "GITHUB_REF=refs/heads/main",
    "AWS_REGION=us-east-1",
    "TF_VAR_env=production",
]
_CI_ENV = "\n".join(_CI_ENV_LINES) + "\n"


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------

class TestEnvFilter(FilterTestMixin):
    F = bc.EnvFilter()

    # --- matches -----------------------------------------------------------

    def test_matches_env(self) -> None:
        assert self.F.matches(["env"])

    def test_matches_printenv(self) -> None:
        assert self.F.matches(["printenv"])

    def test_no_match_export(self) -> None:
        assert not self.F.matches(["export"])

    def test_no_match_set(self) -> None:
        assert not self.F.matches(["set"])

    def test_no_match_bash(self) -> None:
        assert not self.F.matches(["bash", "-c", "env"])

    # --- passthrough (short dump) ------------------------------------------

    def test_short_dump_passes_through(self) -> None:
        out = _compress(self.F, _SHORT_ENV)
        assert "HOME=/home/user" in out
        # No suppression marker for short dumps.
        assert "token-goat" not in out

    def test_empty_output_passes_through(self) -> None:
        out = _compress(self.F, "")
        assert out == "" or "token-goat" not in out

    # --- compression of large dump -----------------------------------------

    def test_large_dump_compressed(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "token-goat" in out
        assert "suppressed" in out

    def test_keep_path(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "PATH=/usr/local/bin" in out

    def test_keep_virtual_env(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "VIRTUAL_ENV=/home/user/.venv" in out

    def test_keep_node_env(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "NODE_ENV=production" in out

    def test_keep_home_and_user(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "HOME=/home/user" in out
        assert "USER=alice" in out

    def test_suppress_noise_vars(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        # Noise vars should be gone.
        assert "SHLVL=2" not in out
        assert "LS_COLORS=" not in out
        assert "DBUS_SESSION_BUS_ADDRESS=" not in out
        assert "DISPLAY=:0" not in out

    def test_suppression_count_in_marker(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        # Should mention the count of suppressed vars.
        import re
        m = re.search(r"(\d+) env vars suppressed", out)
        assert m, "suppression count marker missing"
        suppressed_count = int(m.group(1))
        assert suppressed_count > 0

    def test_total_count_in_marker(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        import re
        m = re.search(r"\((\d+) total\)", out)
        assert m, "total count missing from marker"
        total = int(m.group(1))
        assert total == len(_LARGE_ENV_LINES)

    def test_keep_github_prefix(self) -> None:
        out = _compress(self.F, _CI_ENV)
        assert "GITHUB_ACTIONS=true" in out
        assert "GITHUB_RUN_ID=12345" in out
        assert "GITHUB_REF=refs/heads/main" in out

    def test_keep_aws_prefix(self) -> None:
        out = _compress(self.F, _CI_ENV)
        assert "AWS_REGION=us-east-1" in out

    def test_keep_tf_prefix(self) -> None:
        out = _compress(self.F, _CI_ENV)
        assert "TF_VAR_env=production" in out

    def test_keep_gopath(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "GOPATH=/home/user/go" in out

    def test_keep_cargo_home(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "CARGO_HOME=/home/user/.cargo" in out

    def test_keep_java_home(self) -> None:
        out = _compress(self.F, _LARGE_ENV)
        assert "JAVA_HOME=/usr/lib/jvm/java-17" in out

    # --- select_filter dispatch for bare `env` -----------------------------

    def test_select_filter_bare_env(self) -> None:
        f = bc.select_filter(["env"])
        assert f is not None
        assert f.name == "env"

    def test_select_filter_printenv(self) -> None:
        f = bc.select_filter(["printenv"])
        assert f is not None
        assert f.name == "env"

    def test_select_filter_env_dash_zero(self) -> None:
        # `env -0` (NUL-separated output) should still route to EnvFilter.
        f = bc.select_filter(["env", "-0"])
        assert f is not None
        assert f.name == "env"
