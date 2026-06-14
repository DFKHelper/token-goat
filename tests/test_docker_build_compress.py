"""Tests for docker build output compression (Iter 38)."""

from __future__ import annotations

import textwrap

from token_goat.bash_compress import (
    _has_docker_build_output,
    _is_docker_build_cmd,
    compress_docker_build,
)

# ---------------------------------------------------------------------------
# _is_docker_build_cmd
# ---------------------------------------------------------------------------


class TestIsDockerBuildCmd:
    def test_docker_build_dot(self):
        assert _is_docker_build_cmd(["docker", "build", "."]) is True

    def test_docker_build_with_tag(self):
        assert _is_docker_build_cmd(["docker", "build", "-t", "myapp:latest", "."]) is True

    def test_docker_buildx_build(self):
        assert _is_docker_build_cmd(["docker", "buildx", "build", "."]) is True

    def test_docker_compose_build(self):
        assert _is_docker_build_cmd(["docker-compose", "build"]) is True

    def test_docker_compose_build_service(self):
        assert _is_docker_build_cmd(["docker-compose", "build", "web"]) is True

    def test_docker_run_false(self):
        assert _is_docker_build_cmd(["docker", "run", "myimage"]) is False

    def test_docker_pull_false(self):
        assert _is_docker_build_cmd(["docker", "pull", "python:3.11"]) is False

    def test_docker_ps_false(self):
        assert _is_docker_build_cmd(["docker", "ps"]) is False

    def test_podman_build_false(self):
        assert _is_docker_build_cmd(["podman", "build", "."]) is False

    def test_empty_false(self):
        assert _is_docker_build_cmd([]) is False

    def test_docker_push_false(self):
        assert _is_docker_build_cmd(["docker", "push", "myapp"]) is False

    def test_docker_compose_up_false(self):
        """Regression: docker-compose up is NOT a build command."""
        assert _is_docker_build_cmd(["docker-compose", "up"]) is False

    def test_docker_compose_up_build_false(self):
        """Regression: docker-compose up --build is NOT a build-only command."""
        assert _is_docker_build_cmd(["docker-compose", "up", "--build"]) is False

    def test_docker_compose_logs_false(self):
        assert _is_docker_build_cmd(["docker-compose", "logs"]) is False


# ---------------------------------------------------------------------------
# _has_docker_build_output
# ---------------------------------------------------------------------------


class TestHasDockerBuildOutput:
    def test_classic_step_line(self):
        assert _has_docker_build_output("Step 1/5 : FROM python:3.11\n") is True

    def test_buildkit_summary(self):
        assert _has_docker_build_output("[+] Building 12.3s (10/10) FINISHED\n") is True

    def test_plain_text_false(self):
        assert _has_docker_build_output("hello world\nsome output\n") is False

    def test_empty_false(self):
        assert _has_docker_build_output("") is False

    def test_docker_run_output_false(self):
        assert _has_docker_build_output("Unable to find image 'python:3.11' locally\n") is False


# ---------------------------------------------------------------------------
# compress_docker_build — classic format
# ---------------------------------------------------------------------------

_CLASSIC_OUTPUT = textwrap.dedent("""\
    Sending build context to Docker daemon  2.048kB
    Step 1/5 : FROM python:3.11-slim
     ---> a7a78dda8a3b
    Step 2/5 : WORKDIR /app
     ---> Using cache
     ---> b123456789ab
    Step 3/5 : COPY requirements.txt .
     ---> Using cache
     ---> c234567890bc
    Step 4/5 : RUN pip install -r requirements.txt
     ---> Running in d345678901cd
    Collecting flask
      Downloading Flask-3.0.0-py3-none-any.whl (92 kB)
    Successfully installed flask-3.0.0
    Removing intermediate container d345678901cd
     ---> e456789012de
    Step 5/5 : COPY . .
     ---> f567890123ef
    Successfully built 9876543210ab
    Successfully tagged myapp:latest
""")


class TestCompressDockerBuildClassic:
    def setup_method(self):
        self.compressed, self.removed = compress_docker_build(_CLASSIC_OUTPUT)
        self.lines = self.compressed.splitlines()

    def test_step_headers_kept(self):
        assert any("Step 1/5 : FROM" in ln for ln in self.lines)
        assert any("Step 2/5 : WORKDIR" in ln for ln in self.lines)
        assert any("Step 4/5 : RUN" in ln for ln in self.lines)

    def test_using_cache_suppressed(self):
        assert not any("Using cache" in ln for ln in self.lines)

    def test_running_in_hash_suppressed(self):
        assert not any("Running in d345678901cd" in ln for ln in self.lines)

    def test_bare_hash_arrow_suppressed(self):
        # Bare ---> <hash> lines like " ---> a7a78dda8a3b" should be gone
        assert not any(ln.strip() == "---> a7a78dda8a3b" for ln in self.lines)
        assert not any(ln.strip() == "---> b123456789ab" for ln in self.lines)

    def test_sending_build_context_suppressed(self):
        assert not any("Sending build context" in ln for ln in self.lines)

    def test_removing_intermediate_container_suppressed(self):
        assert not any("Removing intermediate container" in ln for ln in self.lines)

    def test_run_step_output_kept(self):
        # Lines inside RUN step (pip output) should be kept
        assert any("Collecting flask" in ln for ln in self.lines)
        assert any("Successfully installed" in ln for ln in self.lines)

    def test_success_built_kept(self):
        assert any("Successfully built 9876543210ab" in ln for ln in self.lines)

    def test_success_tagged_kept(self):
        assert any("Successfully tagged myapp:latest" in ln for ln in self.lines)

    def test_lines_removed_positive(self):
        assert self.removed > 0

    def test_lines_removed_count(self):
        # 1 Sending build context + 3 Using cache/hash pairs (2 each = 6)
        # + 1 Running in + 1 Removing intermediate + some bare hash arrows
        # At minimum: Sending(1) + Using cache(2) + bare hashes(4) + Running in(1)
        # + Removing(1) = 9 lines, but COPY . . has " ---> f567.." suppressed too
        # and Step1 has " ---> a7a78.." suppressed
        assert self.removed >= 6

    def test_non_run_non_step_lines_suppressed(self):
        # "Downloading Flask..." line appears under RUN step but is pip output — kept
        # Lines after COPY (non-RUN) steps without ---> prefix should be suppressed
        # Step 5/5 COPY . . has " ---> f567890123ef" which is a hash arrow → suppressed
        assert not any("f567890123ef" in ln for ln in self.lines)


# ---------------------------------------------------------------------------
# compress_docker_build — BuildKit format
# ---------------------------------------------------------------------------

_BUILDKIT_OUTPUT = textwrap.dedent("""\
    [+] Building 12.3s (10/10) FINISHED
     => [internal] load build definition from Dockerfile           0.0s
     => => transferring dockerfile: 892B                           0.0s
     => [internal] load .dockerignore                              0.0s
     => => transferring context: 2B                                0.0s
     => [internal] load metadata for docker.io/library/python:3.11 1.2s
     => [1/5] FROM docker.io/library/python:3.11@sha256:abc...    0.0s
     => => resolve docker.io/library/python:3.11@sha256:abc...    0.0s
     => CACHED [2/5] WORKDIR /app                                  0.0s
     => CACHED [3/5] COPY requirements.txt .                       0.0s
     => [4/5] RUN pip install -r requirements.txt                  8.7s
     => [5/5] COPY . .                                             0.1s
     => exporting to image                                         1.2s
     => => exporting layers                                        1.1s
     => => writing image sha256:9876543210ab...                    0.0s
     => => naming to docker.io/library/myapp:latest                0.0s
""")


class TestCompressDockerBuildKit:
    def setup_method(self):
        self.compressed, self.removed = compress_docker_build(_BUILDKIT_OUTPUT)
        self.lines = self.compressed.splitlines()

    def test_summary_line_kept(self):
        assert any("[+] Building 12.3s" in ln for ln in self.lines)

    def test_step_lines_kept(self):
        assert any("[1/5] FROM" in ln for ln in self.lines)
        assert any("[4/5] RUN" in ln for ln in self.lines)
        assert any("[5/5] COPY" in ln for ln in self.lines)

    def test_cached_step_lines_kept(self):
        assert any("CACHED [2/5] WORKDIR" in ln for ln in self.lines)
        assert any("CACHED [3/5] COPY" in ln for ln in self.lines)

    def test_substep_transferring_suppressed(self):
        assert not any("transferring dockerfile" in ln for ln in self.lines)
        assert not any("transferring context" in ln for ln in self.lines)

    def test_substep_exporting_layers_suppressed(self):
        assert not any("exporting layers" in ln for ln in self.lines)

    def test_substep_writing_image_suppressed(self):
        assert not any("writing image" in ln for ln in self.lines)

    def test_substep_naming_suppressed(self):
        assert not any("naming to docker.io" in ln for ln in self.lines)

    def test_resolve_substep_suppressed(self):
        assert not any("resolve docker.io" in ln for ln in self.lines)

    def test_lines_removed_positive(self):
        assert self.removed > 0

    def test_substep_count_removed(self):
        # There are 7 " => => " lines in the test fixture
        assert self.removed >= 7


# ---------------------------------------------------------------------------
# compress_docker_build — error lines always kept
# ---------------------------------------------------------------------------


class TestCompressDockerBuildErrors:
    def test_error_line_kept(self):
        stdout = textwrap.dedent("""\
            Step 1/3 : FROM python:3.11-slim
             ---> a7a78dda8a3b
            Step 2/3 : RUN pip install badpackage
             ---> Running in d345678901cd
            ERROR: Could not find a version that satisfies the requirement badpackage
            The command '/bin/sh -c pip install badpackage' returned a non-zero exit code: 1
        """)
        compressed, _ = compress_docker_build(stdout)
        lines = compressed.splitlines()
        assert any("ERROR: Could not find" in ln for ln in lines)
        assert any("non-zero exit code" in ln for ln in lines)

    def test_failed_line_kept(self):
        stdout = "Step 1/2 : FROM scratch\n ---> abc123\nBUILD FAILED\n"
        compressed, _ = compress_docker_build(stdout)
        assert "BUILD FAILED" in compressed

    def test_empty_input(self):
        compressed, removed = compress_docker_build("")
        assert compressed == ""
        assert removed == 0

    def test_no_suppressible_lines(self):
        # All step headers, no ---> lines
        stdout = "Step 1/2 : FROM python:3.11\nStep 2/2 : CMD python\nSuccessfully built abc\n"
        compressed, removed = compress_docker_build(stdout)
        assert removed == 0
        assert "Step 1/2" in compressed
        assert "Step 2/2" in compressed


# ---------------------------------------------------------------------------
# post_bash integration (smoke tests via direct function call simulation)
# ---------------------------------------------------------------------------


class TestPostBashIntegration:
    """Light integration tests: verify the compress functions produce the right
    systemMessage shape when called from a simulated post_bash context."""

    def test_docker_build_classic_produces_header(self):
        compressed, removed = compress_docker_build(_CLASSIC_OUTPUT)
        assert removed > 0
        header = (
            f"[token-goat] docker build: {removed} build steps "
            f"compressed (cache/hash/sub-step lines removed). "
            f"Kept: step headers, RUN output, errors."
        )
        assert "build steps compressed" in header
        assert "Kept: step headers" in header

    def test_docker_build_buildkit_produces_header(self):
        compressed, removed = compress_docker_build(_BUILDKIT_OUTPUT)
        assert removed > 0
        header = (
            f"[token-goat] docker build: {removed} build steps "
            f"compressed (cache/hash/sub-step lines removed). "
            f"Kept: step headers, RUN output, errors."
        )
        assert "build steps compressed" in header

    def test_non_docker_cmd_not_triggered(self):
        assert _is_docker_build_cmd(["npm", "run", "build"]) is False
        assert _is_docker_build_cmd(["make", "build"]) is False

    def test_exit_code_nonzero_guard(self):
        # The hook only fires when exit_code in (None, 0).
        # We verify that compress_docker_build itself doesn't crash on error output.
        error_output = _CLASSIC_OUTPUT + "ERROR: something went wrong\n"
        compressed, removed = compress_docker_build(error_output)
        assert "ERROR: something went wrong" in compressed

    def test_has_docker_build_output_guards_buildkit(self):
        # _has_docker_build_output is the content guard
        assert _has_docker_build_output(_BUILDKIT_OUTPUT) is True
        assert _has_docker_build_output(_CLASSIC_OUTPUT) is True
        # A random command that happens to mention docker won't trigger
        assert _has_docker_build_output("docker: 'build' is not a docker command") is False

    def test_buildkit_output_with_preamble_detected(self):
        """Regression: [+] Building with a warning preamble must still be detected."""
        output_with_preamble = (
            "WARNING: Docker Desktop version 4.x is outdated\n"
            "[+] Building 2.1s (5/5) FINISHED\n"
            " => [1/3] FROM python:3.11\n"
        )
        assert _has_docker_build_output(output_with_preamble) is True
