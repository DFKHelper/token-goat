"""Regression benchmarks for measurable token-savings wins.

This file pins the savings/perf wins won over the recent refinement cycles so a
future change that quietly regresses them fails fast in CI.  Each test stands
alone: no shared fixture state, no inter-test order dependence.  Margins are
generous on purpose — the goal is regression detection, not micro-optimization.

The wins locked in here:

1. WebP-vs-JPEG compression for synthetic UI screenshots.
2. Auto-compact repomap output is denser per file than full mode.
3. ``write_file_index`` runs inside a transaction (100 rows fast).
4. Hooks dispatcher cold-start fits inside its budget.
5. Per-project DB has the composite indexes that drive surgical lookups.
6. Markdown section extraction covers setext + ATX + frontmatter + details.
7. Default excludes drop generated lockfiles like ``package-lock.json``.
"""
from __future__ import annotations

import io
import subprocess
import sys
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# 1. Image-shrink: WebP at q=80 ≥20% smaller than JPEG at q=75 for screenshots
# ---------------------------------------------------------------------------

def test_webp_beats_jpeg_for_synthetic_screenshot() -> None:
    """Pin the WebP-over-JPEG win for screenshot-like content.

    Build a deterministic 800x600 image with flat panels, ramps, and sharp
    text-like edges — the same workload profile that gave the original ~39%
    measured saving.  Encode it with the runtime's WEBP_QUALITY/METHOD and
    JPEG_QUALITY constants, and assert WebP comes out at least 20% smaller.
    The 20% floor is comfortably below the measured ~39% so machine variance
    in the encoder does not flake the test.
    """
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    from token_goat import image_shrink

    img = Image.new("RGB", (800, 600), color=(245, 246, 248))
    draw = ImageDraw.Draw(img)
    # Flat panels — typical UI chrome.
    draw.rectangle((0, 0, 800, 60), fill=(28, 32, 40))
    draw.rectangle((0, 540, 800, 600), fill=(28, 32, 40))
    draw.rectangle((40, 100, 760, 520), fill=(255, 255, 255))
    # Sharp-edged text-like glyph stripes that JPEG smears but WebP holds.
    for y in range(140, 500, 30):
        draw.rectangle((80, y, 720, y + 14), fill=(40, 60, 90))
        draw.rectangle((80, y + 16, 280, y + 22), fill=(140, 160, 190))
    # Diagonal ramp adds gentle gradient surface.
    for x in range(0, 800, 4):
        draw.line((x, 0, x, 600), fill=(245 - (x // 8) % 30, 246, 248))

    buf_webp = io.BytesIO()
    img.save(
        buf_webp,
        "WEBP",
        quality=image_shrink.WEBP_QUALITY,
        method=image_shrink.WEBP_METHOD,
    )
    buf_jpeg = io.BytesIO()
    img.save(buf_jpeg, "JPEG", quality=image_shrink.JPEG_QUALITY, optimize=True)

    webp_size = buf_webp.tell()
    jpeg_size = buf_jpeg.tell()
    assert jpeg_size > 0
    ratio = webp_size / jpeg_size
    # WebP must be at least 20% smaller than JPEG.  Measured win was ~39%.
    assert ratio <= 0.80, (
        f"WebP no longer beats JPEG by ≥20% — webp={webp_size}B, jpeg={jpeg_size}B, "
        f"ratio={ratio:.3f}"
    )


# ---------------------------------------------------------------------------
# 2. Repomap: compact mode is ≥20% denser (chars/file) than full mode
# ---------------------------------------------------------------------------

def test_repomap_compact_is_denser_than_full(tmp_path: Path, tmp_data_dir) -> None:
    """On a 20-file synthetic project, compact output packs more files per char.

    Density = files_listed / output_length.  Compact mode collapses each file
    to one line, so it must list more files per char than the full multi-line
    format.  Margin: assert ≥20% denser.  Auto-compact engages on tight
    budgets but we pass ``compact=True``/``False`` explicitly so the test is
    independent of the auto-engage threshold.
    """
    from token_goat import repomap
    from token_goat.parser import index_project
    from token_goat.project import make_project_at

    proj_root = tmp_path / "twenty"
    proj_root.mkdir()
    # 20 realistic python modules.  Repomap drops files under
    # ~200 bytes (size // 50 >= 4 approx-lines), so each fixture file must be
    # substantial enough to clear the map-worthy floor.
    for i in range(20):
        (proj_root / f"mod_{i:02d}.py").write_text(
            f'"""Module {i} — synthetic fixture for the repomap density benchmark."""\n\n'
            f"def func_{i}_a():\n    \"\"\"Return the seed integer for module {i}.\"\"\"\n    return {i}\n\n"
            f"def func_{i}_b(x: int) -> int:\n    \"\"\"Add the seed offset {i} to x.\"\"\"\n    return x + {i}\n\n"
            f"def func_{i}_c(items: list[int]) -> int:\n    \"\"\"Sum items together with the seed.\"\"\"\n"
            f"    return sum(items) + {i}\n\n"
            f"class Cls_{i}:\n    \"\"\"Holder class with one method that calls func_{i}_a.\"\"\"\n"
            f"    def meth(self) -> int:\n        return func_{i}_a() + func_{i}_b(2)\n",
            encoding="utf-8",
        )
    # Marker-free project: index any directory regardless of .git presence.
    proj = make_project_at(proj_root)
    index_project(proj, full=True)

    full = repomap.build_map(proj, budget_tokens=4000, compact=False)
    compact = repomap.build_map(proj, budget_tokens=4000, compact=True)

    # The leading header line has shape "# twenty (N,python)" — extract N.
    def _files_listed(text: str) -> int:
        first = text.splitlines()[0]
        # "(20,python)" → 20
        marker = first.find("(")
        if marker == -1:
            return 0
        return int(first[marker + 1 :].split(",", 1)[0])

    full_files = _files_listed(full)
    compact_files = _files_listed(compact)
    assert full_files >= 1 and compact_files >= 1

    # Density = files-per-char.  Compact mode must pack ≥20% more files
    # per char (i.e. fewer chars per file) than full mode.
    full_density = full_files / max(len(full), 1)
    compact_density = compact_files / max(len(compact), 1)
    assert compact_density >= full_density * 1.20, (
        f"Compact repomap no longer ≥20% denser: "
        f"full={full_files} files in {len(full)} chars "
        f"(density {full_density:.5f}); "
        f"compact={compact_files} files in {len(compact)} chars "
        f"(density {compact_density:.5f})"
    )


# ---------------------------------------------------------------------------
# 3. write_file_index: 100-row insert under 200 ms (was 84 s before BEGIN/COMMIT)
# ---------------------------------------------------------------------------

def test_write_file_index_transactional_speed(tmp_data_dir) -> None:
    """Pin the BEGIN/COMMIT-wrapped insert budget.

    Pre-fix (autocommit) cost ~840 ms per file with ~100 symbol+ref rows;
    post-fix ~10 ms per file.  Time only the write_file_index call (not the
    db.open_project setup, which carries one-time schema creation and PRAGMA
    cost) and run a warm-up write first so the schema is materialised before
    the measurement begins. The budget asserts the steady-state hot-path cost
    — the previous flat 200 ms ceiling included open + first-write overhead,
    which on a heavily-loaded xdist worker drifted past the limit even when
    the actual transactional write was well under it.
    """
    from token_goat import db
    from token_goat.parser import FileIndex, Ref, Symbol, write_file_index

    def _make_fi(name: str) -> FileIndex:
        return FileIndex(
            rel_path=f"bench/{name}.py",
            language="python",
            size=1234,
            line_count=120,
            mtime=time.time(),
            content_sha256="0" * 64,
            symbols=[
                Symbol(name=f"sym_{i}", kind="function", line=i + 1, signature="()")
                for i in range(60)
            ],
            refs=[Ref(name=f"ref_{i}", line=i + 1) for i in range(40)],
        )

    # SHA1-shaped lowercase hex digest — db._validate_project_hash rejects
    # anything else.  Synthetic value, never collides with real projects.
    project_hash = "0" * 39 + "1"
    with db.open_project(project_hash) as conn:
        # Warm-up write: materialise the schema, prepare statements, and let
        # SQLite stretch its WAL so the measured write below isn't paying for
        # one-time setup cost.
        write_file_index(conn, _make_fi("warmup"))
        # Now time the steady-state transactional write.
        fi = _make_fi("sample")
        t0 = time.monotonic()
        write_file_index(conn, fi)
        elapsed = time.monotonic() - t0
    assert elapsed < 0.200, (
        f"write_file_index regressed: {elapsed * 1000:.1f} ms for 100 rows "
        "(budget 200 ms — autocommit path is ~800 ms)"
    )


# ---------------------------------------------------------------------------
# 4. Hooks dispatcher cold-start in a fresh subprocess fits the budget
# ---------------------------------------------------------------------------

def test_hooks_dispatcher_cold_start_under_budget() -> None:
    """Cold-start budget for the dispatcher entry path.

    Spawning a fresh interpreter, importing ``token_goat.hooks_cli`` and
    dispatching one unknown event must complete in under 1.5 s wall time.
    Cold-start was tightened by lazy-loading the per-event handler modules;
    a regression that re-eagerly imports embeddings, parser, or the language
    adapters will blow this budget.  The 1.5 s ceiling is generous for slow
    CI Windows runners (the original target was 500 ms on developer machines)
    so we still catch a 3x regression without flaking on noisy CI nodes.
    """
    script = (
        "import token_goat.hooks_cli as h\n"
        "h.dispatch('unknown-event', {})\n"
    )
    t0 = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    elapsed = time.monotonic() - t0
    assert result.returncode == 0
    assert elapsed < 1.5, (
        f"hooks_cli cold start regressed: {elapsed * 1000:.0f} ms "
        "(budget 1500 ms; check for newly-eager imports)"
    )


# ---------------------------------------------------------------------------
# 5. Composite indexes live in a fresh project DB
# ---------------------------------------------------------------------------

def test_composite_indexes_present_in_fresh_project_db(tmp_data_dir) -> None:
    """The two composite indexes that power surgical lookups must exist.

    ``idx_symbols_file_name`` turns ``read_symbol(file, name)`` into a direct
    composite seek; ``idx_sections_file_heading`` does the same for
    ``read_section``.  Both have ``IF NOT EXISTS`` so any fresh DB must
    contain them after first open.
    """
    from token_goat import db

    h1 = "a" * 40
    h2 = "b" * 40
    with db.open_project(h1) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "idx_symbols_file_name" in names, names
    assert "idx_sections_file_heading" in names, names

    # Belt-and-braces: ensure both indexes are usable (no syntax/schema drift).
    with db.open_project(h2) as conn:
        plan_sym = conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM symbols WHERE file_rel=? AND name=?",
            ("any.py", "x"),
        ).fetchall()
        plan_sec = conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM sections WHERE file_rel=? AND heading=?",
            ("any.md", "x"),
        ).fetchall()
    # EXPLAIN QUERY PLAN rows are (id, parent, notused, detail) — concatenate
    # the detail column across rows.  sqlite3.Row indexes by tuple position.
    plan_sym_text = " ".join(str(tuple(row)) for row in plan_sym)
    plan_sec_text = " ".join(str(tuple(row)) for row in plan_sec)
    assert "idx_symbols_file_name" in plan_sym_text, plan_sym_text
    assert "idx_sections_file_heading" in plan_sec_text, plan_sec_text


# ---------------------------------------------------------------------------
# 6. Markdown section extraction: setext + ATX + frontmatter + <details>
# ---------------------------------------------------------------------------

def test_markdown_section_extraction_covers_all_section_kinds() -> None:
    """Every section kind the extractor learned must land in the output.

    A single fixture exercises all four: YAML frontmatter, an ATX H1/H2/H3,
    a setext H1 (=== underline) and setext H2 (--- underline), and a
    ``<details><summary>…</summary>`` block.  Assert the expected count plus
    a few headings by name so a regression that drops a section kind is
    caught immediately.
    """
    from token_goat.languages.markdown import FRONTMATTER_HEADING, extract

    src = b"""---
title: Demo Article
author: tester
---

ATX H1 Top
==========

# Real ATX H1

## ATX H2

### ATX H3 Subsection

Setext H2 Underlined
--------------------

<details>
<summary>Click to expand</summary>

hidden content body

</details>
"""
    _symbols, _refs, _imports, sections = extract(src, "demo.md")
    headings = [s.heading for s in sections]

    assert FRONTMATTER_HEADING in headings, headings
    assert "ATX H1 Top" in headings, headings
    assert "Real ATX H1" in headings, headings
    assert "ATX H2" in headings, headings
    assert "ATX H3 Subsection" in headings, headings
    assert "Setext H2 Underlined" in headings, headings
    assert "Click to expand" in headings, headings

    # 1 frontmatter + 2 setext + 4 ATX + 1 details = 8.  Pin the count so a
    # silent over- or under-emit (e.g. ATX-inside-fence regression) flags here.
    assert len(sections) == 8, [s.heading for s in sections]


# ---------------------------------------------------------------------------
# 7. Default excludes drop generated lockfiles like package-lock.json
# ---------------------------------------------------------------------------

def test_default_excludes_skip_package_lock_json(tmp_path: Path) -> None:
    """package-lock.json has the indexed ``.json`` extension but must be skipped.

    Belongs to the generated-filename gate.  A single fixture file is the
    smallest possible regression case: if the gate is removed or the basename
    list shrinks, the walker will yield the lockfile and the assertion fails.
    """
    from token_goat import parser
    from token_goat.project import make_project_at

    proj_root = tmp_path / "lock_root"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    # The would-be victim — present but must not be indexed.
    (proj_root / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
    # A real source file so the project isn't empty.
    (proj_root / "app.py").write_text("def hi(): pass\n", encoding="utf-8")

    proj = make_project_at(proj_root)
    rel_paths = {p.relative_to(proj.root).as_posix() for p in parser.iter_source_files(proj)}

    assert "app.py" in rel_paths
    assert "package-lock.json" not in rel_paths, rel_paths
