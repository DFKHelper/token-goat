"""Tests for DockerFilter iteration-105 enhancements (old-format build output)."""
from __future__ import annotations

from token_goat.bash_compress import DockerFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return DockerFilter().compress(inp, "", 0, argv or ["docker", "build", "."])


def _old_build(*steps: str, success_id: str = "abc123def456") -> str:
    # Produce a minimal old-format docker build output (Step N/M style)
    total = len(steps)
    lines: list[str] = []
    for i, body in enumerate(steps, 1):
        lines.append(f"Step {i}/{total} : RUN step{i}")
        lines.extend(body.split("\n") if body else [])
    lines.append(f"Successfully built {success_id}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Cache / ID suppression
# ---------------------------------------------------------------------------

class TestDockerCacheAndIdSuppression:
    def test_using_cache_suppressed(self) -> None:
        inp = "\n".join([
            "Step 1/2 : FROM ubuntu",
            " ---> Using cache",
            "Step 2/2 : CMD bash",
            "Successfully built abc123",
        ])
        out = _compress(inp)
        assert "Using cache" not in out

    def test_sha256_id_suppressed(self) -> None:
        inp = "\n".join([
            "Step 1/2 : FROM ubuntu",
            " ---> sha256:abc123def456abc123def456abc123",
            "Step 2/2 : CMD bash",
            "Successfully built abc123def456",
        ])
        out = _compress(inp)
        assert "sha256:" not in out

    def test_removing_container_suppressed(self) -> None:
        inp = "\n".join([
            "Step 1/2 : RUN apt-get update",
            " ---> Running in c0ffee1234ab",
            "Removing intermediate container c0ffee1234ab",
            " ---> deadbeef5678",
            "Step 2/2 : CMD bash",
            "Successfully built deadbeef5678",
        ])
        out = _compress(inp)
        assert "Removing intermediate container" not in out


# ---------------------------------------------------------------------------
# Cached layer count in preamble
# ---------------------------------------------------------------------------

class TestDockerCachedCountPreamble:
    def test_cached_count_in_preamble(self) -> None:
        inp = "\n".join([
            "Step 1/3 : FROM ubuntu",
            " ---> Using cache",
            "Step 2/3 : RUN apt-get update",
            " ---> Using cache",
            "Step 3/3 : CMD bash",
            " ---> sha256:abc123def456abc123",
            "Successfully built abc123def456abc1",
        ])
        out = _compress(inp)
        assert "cached" in out


# ---------------------------------------------------------------------------
# Step header suppression
# ---------------------------------------------------------------------------

class TestDockerStepHeaders:
    def test_clean_step_header_suppressed(self) -> None:
        # Step headers are dropped for clean (no-error) steps
        inp = "\n".join([
            "Step 1/2 : FROM ubuntu",
            " ---> abc123",
            "Step 2/2 : CMD bash",
            " ---> def456",
            "Successfully built def456",
        ])
        out = _compress(inp)
        assert "Step 1/2" not in out
        assert "Step 2/2" not in out

    def test_step_error_content_kept(self) -> None:
        # Error output from a step is preserved even though the step header is dropped
        inp = "\n".join([
            "Step 1/2 : RUN apt-get install vim",
            "E: Package 'vim' has no installation candidate",
            "Step 2/2 : CMD bash",
            "Successfully built abc123",
        ])
        out = _compress(inp)
        assert "E: Package 'vim' has no installation candidate" in out


# ---------------------------------------------------------------------------
# Successfully built always kept
# ---------------------------------------------------------------------------

class TestDockerSuccessfullyBuilt:
    def test_successfully_built_always_kept(self) -> None:
        inp = "\n".join([
            "Step 1/1 : FROM ubuntu",
            " ---> abc123def456abc123def456",
            "Successfully built abc123def456abc123def456",
        ])
        out = _compress(inp)
        assert "Successfully built" in out
