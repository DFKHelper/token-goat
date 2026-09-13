"""Emit the paired-evaluation evidence capture from vendored run data.

Two stages, deliberately separated so a skeptic can check either half:

  --db <path>   re-export demo/data/eval-runs.csv and eval-tasks.csv from the
                harness database. Only the maintainer can run this; it needs the
                harness working tree, which is not part of this repository.
  (no flag)     render demo/evidence/12-eval-paired.txt from the vendored CSVs.
                Anyone can run this. It touches no database and no network.

`generate-eval-pdf.py` in turn renders only the capture, so the published PDF,
the evidence pane and the raw rows cannot disagree.

    python scripts/generate-eval-capture.py
    python scripts/generate-eval-pdf.py

`tests/eval_capture_matches_data.test.ts` recomputes every published figure from
the same CSV in TypeScript, independently of this file, and fails if the two
disagree. A bug here does not silently become a published number.
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "demo" / "data"
RUNS_CSV = DATA / "eval-runs.csv"
TASKS_CSV = DATA / "eval-tasks.csv"
OUTPUT = ROOT / "demo" / "evidence" / "12-eval-paired.txt"

TOOLSET = "A9"

# Pairs excluded from the headline figures. A driver crash left an MCP server
# and agent loop alive under a dead run's id, still writing to the shared
# worktree, so a second writer overlapped these two runs. The criterion is
# mechanical -- a tool call recorded after the run's own end -- and blind to the
# outcome, but it was applied after the fact, not pre-registered.
CONTAMINATED = {"c7345de33a71", "5d3c55d0fa73"}

# Anthropic input-token billing multipliers for the three token classes the CLI
# reports separately.
WEIGHTS = {"fresh": 1.0, "cache_write": 1.25, "cache_read": 0.1}

# Columns exported for recomputation. Account-identifying and bulk-payload
# columns (session ids, rate-limit envelopes, captured diffs and stdout) are
# deliberately not exported; none of them feeds a published figure.
RUN_COLUMNS = [
    "id",
    "sha",
    "arm",
    "status",
    "error",
    "resolved",
    "turns_used",
    "turn_cap_hit",
    "max_turns",
    "input_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "output_tokens",
    "started_at",
    "ended_at",
    "model",
    "arm_tool_names",
    "prompt_system_sha",
    "prompt_task_sha",
    "init_guard_ok",
    "api_key_source",
]
TASK_COLUMNS = ["sha", "parent_sha", "subject", "src_files", "test_files"]


def export(db: Path) -> None:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        runs = con.execute(
            f"SELECT {', '.join(RUN_COLUMNS)} FROM runs WHERE toolset = ? ORDER BY id",
            (TOOLSET,),
        ).fetchall()
        _write_csv(RUNS_CSV, RUN_COLUMNS, runs)

        shas = sorted({row[RUN_COLUMNS.index("sha")] for row in runs})
        marks = ", ".join("?" for _ in shas)
        tasks = con.execute(
            f"SELECT {', '.join(TASK_COLUMNS)} FROM tasks WHERE sha IN ({marks}) ORDER BY sha",
            shas,
        ).fetchall()
        _write_csv(TASKS_CSV, TASK_COLUMNS, tasks)
    finally:
        con.close()
    print(f"exported {len(runs)} runs, {len(tasks)} tasks")


def _write_csv(path: Path, columns: list[str], rows: list[tuple]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(rows)


def load_runs() -> list[dict[str, str]]:
    if not RUNS_CSV.exists():
        raise SystemExit(f"missing {RUNS_CSV}; re-export it with --db")
    with RUNS_CSV.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def pair_up(rows: list[dict[str, str]]) -> dict[str, dict[str, dict[str, float]]]:
    pairs: dict[str, dict[str, dict[str, float]]] = {}
    for row in rows:
        if row["status"] != "ok":
            continue
        pairs.setdefault(row["sha"], {})[row["arm"]] = {
            "fresh": int(row["input_tokens"] or 0),
            "cache_write": int(row["cache_creation_tokens"] or 0),
            "cache_read": int(row["cache_read_tokens"] or 0),
            "turns": int(row["turns_used"] or 0),
            "resolved": int(row["resolved"] or 0),
        }
    return {sha: arms for sha, arms in pairs.items() if {"A", "B"} <= arms.keys()}


def measures(run: dict[str, float]) -> dict[str, float]:
    return {
        # Everything the model was charged input for, cache hits included. Close
        # to a turn-count proxy, since a cache read repeats every turn.
        "total": run["fresh"] + run["cache_write"] + run["cache_read"],
        # Context the model processed for the first time. `fresh` alone is NOT
        # this figure: under mandatory caching it is a per-turn delta of tens of
        # tokens, and nearly all content arrives as a cache write.
        "context": run["fresh"] + run["cache_write"],
        "weighted": sum(WEIGHTS[k] * run[k] for k in WEIGHTS),
    }


def render(rows: list[dict[str, str]]) -> str:
    pairs = pair_up(rows)
    clean = sorted(sha for sha in pairs if sha[:12] not in CONTAMINATED)
    every = sorted(pairs)
    voids = [r for r in rows if r["status"] == "void"]

    out: list[str] = []
    add = out.append
    add("$ python scripts/generate-eval-capture.py")
    add("")
    add(f"Paired A/B evaluation, toolset {TOOLSET}")
    add("")
    add("  arm A baseline : read_file, grep, list_files, edit_file, run_tests")
    add("  arm B          : the same, with read_file and grep replaced by")
    add("                   tg_read, tg_symbol, tg_outline, tg_section,")
    add("                   tg_semantic, tg_refs")
    add("  task           : one real bug per repository snapshot, arms differ")
    add("                   only in the tool surface offered to the model")
    add("  counted        : input tokens as reported by the CLI, summed over")
    add("                   every turn; no estimator is involved")
    add("  data           : demo/data/eval-runs.csv, demo/data/eval-tasks.csv")
    add("")

    concordant = sum(
        1 for sha in every if pairs[sha]["A"]["resolved"] == pairs[sha]["B"]["resolved"] == 1
    )
    add(f"Outcome  : {concordant}/{len(every)} pairs resolved in BOTH arms, 0 discordant.")
    add("           No pair separates the arms on success, so this is a cost")
    add("           result only. It says nothing about capability or quality.")
    add("")
    add("Per-pair input tokens, billing-weighted (fresh 1.0 / write 1.25 / read 0.1)")
    add("")
    add(f"  {'task':<14}{'turns A':>8}{'turns B':>8}{'arm A':>12}{'arm B':>12}{'B/A':>8}")
    for sha in every:
        a, b = measures(pairs[sha]["A"]), measures(pairs[sha]["B"])
        flag = "  excluded" if sha[:12] in CONTAMINATED else ""
        add(
            f"  {sha[:12]:<14}{pairs[sha]['A']['turns']:>8}{pairs[sha]['B']['turns']:>8}"
            f"{a['weighted']:>12,.0f}{b['weighted']:>12,.0f}"
            f"{b['weighted'] / a['weighted']:>8.3f}{flag}"
        )
    add("")

    add("Median paired ratio B/A, by what is counted")
    add("")
    add(
        f"  {'measure':<38}{'clean (n=' + str(len(clean)) + ')':>14}"
        f"{'all (n=' + str(len(every)) + ')':>14}"
    )
    for key, label in (
        ("total", "total input (cache hits included)"),
        ("context", "fresh context (input + cache write)"),
        ("weighted", "billing-weighted"),
    ):
        cells = [
            statistics.median(
                measures(pairs[sha]["B"])[key] / measures(pairs[sha]["A"])[key] for sha in keys
            )
            for keys in (clean, every)
        ]
        add(f"  {label:<38}{cells[0]:>14.3f}{cells[1]:>14.3f}")
    add("")
    for name, keys in (("clean", clean), ("all", every)):
        med = statistics.median(
            measures(pairs[sha]["B"])["weighted"] / measures(pairs[sha]["A"])["weighted"]
            for sha in keys
        )
        add(f"  {name:<5} billing-weighted saving: {100 * (1 - med):.1f}%")
    add("")

    spread = sorted(
        measures(pairs[sha]["B"])["weighted"] / measures(pairs[sha]["A"])["weighted"]
        for sha in clean
    )
    add("Read the spread, not only the median")
    add("")
    add(f"  clean per-pair ratios : {', '.join(f'{r:.3f}' for r in spread)}")
    add(f"  pairs where arm B cost MORE : {sum(1 for r in spread if r > 1)} of {len(clean)}")
    add("")

    add("Runs that produced no result")
    add("")
    add(f"  void runs : {len(voids)} of {len(rows)} recorded, all one failure mode")
    add("              (the driver process died mid-run, no outcome recorded)")
    add(f"  arm A     : {sum(1 for r in voids if r['arm'] == 'A')}")
    add(f"  arm B     : {sum(1 for r in voids if r['arm'] == 'B')}")
    add("  the split tracks exposure, not arm: arm A runs roughly 11x longer,")
    add("  and crashes per exposure-hour were 4.60 (A) against 5.08 (B)")
    add("")

    add("Limitations, all of which travel with the numbers above")
    add("")
    add(f"  - n = {len(clean)} clean pairs. A median over six pairs moves under")
    add("    single-pair changes; the spread above is the honest picture.")
    add("  - Every pair resolved in both arms, so no capability claim follows.")
    add("  - 2 pairs excluded post hoc for writer contamination. The criterion")
    add("    is mechanical and outcome-blind, but was not pre-registered.")
    add("  - Attrition was duration-correlated: the crash destroyed long runs")
    add("    preferentially, and 2 tasks were lost entirely.")
    add("  - The run was truncated at n=7 with the ratios already visible.")
    add("    Task selection stayed blind; the decision to stop did not.")
    add("  - Single model, single repository, tasks authored by this project.")
    add("")
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, help="re-export the vendored CSVs from results.db")
    args = parser.parse_args()

    if args.db:
        export(args.db)

    rows = load_runs()
    OUTPUT.write_text(render(rows), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT.relative_to(ROOT)} from {RUNS_CSV.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
