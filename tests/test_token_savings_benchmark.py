"""End-to-end token-savings benchmark.

Builds synthetic SessionCache objects representing three realistic workloads
(small/medium/large), runs build_manifest at multiple token budgets, and
reports byte/token measurements. Also fires each hint constructor and
measures cumulative hint byte cost.

These are *observational* tests — they never fail on "bad" numbers; they
only assert that the code ran and produced output. Tag the whole class
``slow`` so the routine dev loop skips them.
"""
from __future__ import annotations

import hashlib
from typing import Any

import pytest

from token_goat import session as session_mod
from token_goat.compact import build_manifest, estimate_tokens

# ---------------------------------------------------------------------------
# Workload definitions
# ---------------------------------------------------------------------------

_WORKLOADS: dict[str, dict[str, Any]] = {
    "small": {
        "label": "small session",
        "edited_files": 3,
        "reads": 5,
        "bash_commands": 2,
        "greps": 1,
        "web_fetches": 0,
        "skills": 0,
    },
    "medium": {
        "label": "medium session",
        "edited_files": 15,
        "reads": 30,
        "bash_commands": 10,
        "greps": 5,
        "web_fetches": 3,
        "skills": 2,
    },
    "large": {
        "label": "large session",
        "edited_files": 50,
        "reads": 100,
        "bash_commands": 30,
        "greps": 15,
        "web_fetches": 10,
        "skills": 5,
    },
}

_TOKEN_BUDGETS = [200, 400, 800, 1200]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cmd_sha(cmd: str) -> str:
    return hashlib.sha256(cmd.encode()).hexdigest()[:12]


def _url_sha(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def _build_session(tmp_data_dir, workload: dict[str, Any], session_id: str) -> None:
    """Populate a SessionCache on disk matching the given workload spec."""
    # reads
    for i in range(workload["reads"]):
        session_mod.mark_file_read(
            session_id,
            f"/proj/src/module_{i}.py",
            offset=0,
            limit=200,
        )

    # edits
    for i in range(workload["edited_files"]):
        session_mod.mark_file_edited(session_id, f"/proj/src/edited_{i}.py")

    # greps
    for i in range(workload["greps"]):
        session_mod.mark_grep(session_id, f"pattern_{i}", "/proj/src")

    # bash commands
    for i in range(workload["bash_commands"]):
        cmd = f"uv run pytest tests/test_module_{i}.py -v"
        sha = _cmd_sha(cmd)
        session_mod.mark_bash_run(
            session_id=session_id,
            cmd_sha=sha,
            cmd_preview=cmd,
            output_id=f"out-{sha}",
            stdout_bytes=4096 + i * 512,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

    # web fetches
    for i in range(workload["web_fetches"]):
        url = f"https://docs.example.com/api/page_{i}"
        sha = _url_sha(url)
        session_mod.mark_web_fetch(
            session_id=session_id,
            url_sha=sha,
            url_preview=url,
            output_id=f"web-{sha}",
            body_bytes=8192 + i * 1024,
            status_code=200,
            truncated=False,
        )

    # skills
    for i in range(workload["skills"]):
        skill_name = f"skill-{i}"
        content_sha = hashlib.sha256(skill_name.encode()).hexdigest()[:16]
        session_mod.mark_skill_loaded(
            session_id=session_id,
            skill_name=skill_name,
            output_id=f"sk-{content_sha}",
            content_sha=content_sha,
            body_bytes=2048 + i * 256,
            truncated=False,
        )


def _section_names_present(manifest: str) -> list[str]:
    """Extract section headers rendered in the manifest."""
    lines = manifest.splitlines()
    return [line.lstrip("#").strip() for line in lines if line.startswith("#")]


def _measure_hint(hint_obj: Any) -> tuple[int, int]:
    """Return (bytes, tokens) for a hint object, handling None gracefully."""
    if hint_obj is None:
        return 0, 0
    text = str(hint_obj)
    return len(text.encode("utf-8")), estimate_tokens(text)


# ---------------------------------------------------------------------------
# Benchmark helpers
# ---------------------------------------------------------------------------

def _run_manifest_benchmark(session_id: str, label: str, budget: int) -> dict[str, Any]:
    """Build manifest and collect measurements. Returns a result dict."""
    manifest = build_manifest(session_id, max_tokens=budget)
    byte_count = len(manifest.encode("utf-8"))
    token_count = estimate_tokens(manifest)
    sections = _section_names_present(manifest)
    return {
        "manifest": manifest,
        "bytes": byte_count,
        "tokens": token_count,
        "sections": sections,
        "budget": budget,
        "label": label,
    }


def _print_manifest_report(result: dict[str, Any], workload: dict[str, Any]) -> None:
    label = result["label"]
    budget = result["budget"]
    print(f"\n=== Token Savings Benchmark: {label} @ {budget}-token budget ===")
    print(f"Manifest bytes: {result['bytes']}")
    print(f"Estimated tokens: {result['tokens']}")
    print(f"Budget utilisation: {result['tokens'] / budget * 100:.1f}%")
    print(f"Sections rendered: {result['sections'] or ['(none — empty session)']}")

    # Budget utilisation by workload category (rough proportions)
    edited = workload["edited_files"]
    reads = workload["reads"]
    bash = workload["bash_commands"]
    web = workload["web_fetches"]
    skills = workload["skills"]
    total_events = edited + reads + bash + web + skills or 1
    print(
        f"Section budgets utilised: edits={edited/total_events*100:.0f}% "
        f"bash={bash/total_events*100:.0f}% "
        f"web={web/total_events*100:.0f}% "
        f"skills={skills/total_events*100:.0f}%"
    )


def _run_hint_coverage(session_id: str, workload: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """Fire hint constructors and measure cumulative byte/token cost."""
    from token_goat import hints

    results: dict[str, tuple[int, int]] = {}

    # bash dedup: fire for each recorded bash command
    bash_total_bytes = 0
    bash_total_tokens = 0
    bash_fires = 0
    for i in range(workload["bash_commands"]):
        cmd = f"uv run pytest tests/test_module_{i}.py -v"
        h = hints.build_bash_dedup_hint(session_id=session_id, command=cmd)
        b, t = _measure_hint(h)
        bash_total_bytes += b
        bash_total_tokens += t
        if h is not None:
            bash_fires += 1
    results["bash_dedup"] = (bash_total_bytes, bash_total_tokens)

    # web dedup
    web_total_bytes = 0
    web_total_tokens = 0
    web_fires = 0
    for i in range(workload["web_fetches"]):
        url = f"https://docs.example.com/api/page_{i}"
        h = hints.build_web_dedup_hint(session_id=session_id, url=url)
        b, t = _measure_hint(h)
        web_total_bytes += b
        web_total_tokens += t
        if h is not None:
            web_fires += 1
    results["web_dedup"] = (web_total_bytes, web_total_tokens)

    # structured file hint (fires on large structured files like JSON/TOML)
    import tempfile
    from pathlib import Path
    struct_total_bytes = 0
    struct_total_tokens = 0
    struct_fires = 0
    with tempfile.TemporaryDirectory() as td:
        # Create a large JSON file to trigger the hint
        fake_json = Path(td) / "large_config.json"
        fake_json.write_bytes(b'{"key": "value"}\n' * 500)  # ~8 KB
        h = hints.build_structured_file_hint(file_path=str(fake_json), offset=None, limit=None)
        b, t = _measure_hint(h)
        struct_total_bytes += b
        struct_total_tokens += t
        if h is not None:
            struct_fires += 1
    results["structured"] = (struct_total_bytes, struct_total_tokens)

    # index-only hint (fires on lockfiles, bundle artefacts)
    idx_total_bytes = 0
    idx_total_tokens = 0
    idx_fires = 0
    with tempfile.TemporaryDirectory() as td:
        lock_file = Path(td) / "uv.lock"
        lock_file.write_bytes(b"# uv lock\n" * 500)  # ~5 KB
        h = hints.build_index_only_file_hint(file_path=str(lock_file), offset=None, limit=None)
        b, t = _measure_hint(h)
        idx_total_bytes += b
        idx_total_tokens += t
        if h is not None:
            idx_fires += 1
    results["index_only"] = (idx_total_bytes, idx_total_tokens)

    # unchanged file hint (requires a snapshot — skip if no snapshot exists)
    results["unchanged_file"] = (0, 0)  # no snapshot written in this synthetic session

    return results


def _print_hint_report(hint_results: dict[str, tuple[int, int]]) -> None:
    print("Hint coverage:")
    for name, (b, t) in hint_results.items():
        if b > 0:
            print(f"  - {name}: {b} bytes ({t} tokens)")
        else:
            print(f"  - {name}: 0 fires")


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestTokenSavingsBenchmark:
    """Observational benchmarks for manifest and hint token costs.

    These tests never assert on specific numbers — they assert only that code
    ran without crashing and produced non-empty output. The print() output
    (visible with ``pytest -s``) gives the actual measurements.
    """

    def test_manifest_small_session(self, capfd, tmp_data_dir):
        session_id = "bench-small-0000000000000001"
        workload = _WORKLOADS["small"]
        _build_session(tmp_data_dir, workload, session_id)

        for budget in _TOKEN_BUDGETS:
            result = _run_manifest_benchmark(session_id, workload["label"], budget)
            _print_manifest_report(result, workload)

        captured = capfd.readouterr()
        assert "small session" in captured.out
        assert "Manifest bytes:" in captured.out

    def test_manifest_medium_session(self, capfd, tmp_data_dir):
        session_id = "bench-medium-000000000000002"
        workload = _WORKLOADS["medium"]
        _build_session(tmp_data_dir, workload, session_id)

        for budget in _TOKEN_BUDGETS:
            result = _run_manifest_benchmark(session_id, workload["label"], budget)
            _print_manifest_report(result, workload)

        captured = capfd.readouterr()
        assert "medium session" in captured.out
        assert "Manifest bytes:" in captured.out

    def test_manifest_large_session(self, capfd, tmp_data_dir):
        session_id = "bench-large-0000000000000003"
        workload = _WORKLOADS["large"]
        _build_session(tmp_data_dir, workload, session_id)

        for budget in _TOKEN_BUDGETS:
            result = _run_manifest_benchmark(session_id, workload["label"], budget)
            _print_manifest_report(result, workload)

        captured = capfd.readouterr()
        assert "large session" in captured.out
        assert "Manifest bytes:" in captured.out

    def test_hint_coverage_small(self, capfd, tmp_data_dir):
        session_id = "bench-hint-small-000000000004"
        workload = _WORKLOADS["small"]
        _build_session(tmp_data_dir, workload, session_id)

        hint_results = _run_hint_coverage(session_id, workload)
        print(f"\n=== Hint Coverage: {workload['label']} ===")
        _print_hint_report(hint_results)

        captured = capfd.readouterr()
        assert "Hint Coverage: small session" in captured.out

    def test_hint_coverage_medium(self, capfd, tmp_data_dir):
        session_id = "bench-hint-medium-00000000005"
        workload = _WORKLOADS["medium"]
        _build_session(tmp_data_dir, workload, session_id)

        hint_results = _run_hint_coverage(session_id, workload)
        print(f"\n=== Hint Coverage: {workload['label']} ===")
        _print_hint_report(hint_results)

        captured = capfd.readouterr()
        assert "Hint Coverage: medium session" in captured.out

    def test_hint_coverage_large(self, capfd, tmp_data_dir):
        session_id = "bench-hint-large-000000000006"
        workload = _WORKLOADS["large"]
        _build_session(tmp_data_dir, workload, session_id)

        hint_results = _run_hint_coverage(session_id, workload)
        print(f"\n=== Hint Coverage: {workload['label']} ===")
        _print_hint_report(hint_results)

        captured = capfd.readouterr()
        assert "Hint Coverage: large session" in captured.out

    def test_budget_scaling(self, capfd, tmp_data_dir):
        """Verify manifest size grows (or stays stable) as budget increases.

        Observational: prints the scaling curve. Asserts only that the
        400-token budget manifest is no larger than the 1200-token budget.
        """
        session_id = "bench-scale-000000000000007"
        workload = _WORKLOADS["medium"]
        _build_session(tmp_data_dir, workload, session_id)

        results = []
        for budget in _TOKEN_BUDGETS:
            r = _run_manifest_benchmark(session_id, workload["label"], budget)
            results.append(r)

        print("\n=== Budget Scaling Curve (medium session) ===")
        for r in results:
            print(
                f"  budget={r['budget']:5d} -> bytes={r['bytes']:5d} "
                f"tokens={r['tokens']:4d} sections={len(r['sections'])}"
            )

        captured = capfd.readouterr()
        assert "Budget Scaling Curve" in captured.out

        # Sanity: 400-token manifest should not exceed 1200-token manifest
        tok_400 = next(r["tokens"] for r in results if r["budget"] == 400)
        tok_1200 = next(r["tokens"] for r in results if r["budget"] == 1200)
        assert tok_400 <= tok_1200, (
            f"400-token budget produced {tok_400} tokens but 1200-token budget "
            f"only produced {tok_1200} — budget capping appears broken"
        )

    def test_empty_session_manifest(self, capfd, tmp_data_dir):
        """An empty session must produce an empty or near-empty manifest without crashing."""
        session_id = "bench-empty-00000000000008"
        # Do not populate — fresh session
        manifest = build_manifest(session_id, max_tokens=400)
        byte_count = len(manifest.encode("utf-8"))
        token_count = estimate_tokens(manifest)
        print("\n=== Empty Session Manifest ===")
        print(f"Manifest bytes: {byte_count}")
        print(f"Estimated tokens: {token_count}")
        print(f"Content: {manifest!r}")

        captured = capfd.readouterr()
        assert "Empty Session Manifest" in captured.out
        # Should not crash and should produce a minimal result
        assert isinstance(manifest, str)
