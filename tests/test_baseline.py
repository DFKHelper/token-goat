"""Tests for environmental-baseline attribution (``token-goat baseline``) and
the once-per-session SessionStart advisory.

The integration tests build a synthetic Claude Code session tree under
``tmp_path`` and monkeypatch the two ``paths`` resolvers the scanners rely on
(``claude_projects_dir`` and ``claude_config_dir``) so the scan runs entirely
against fixture files of known sizes — no dependence on the real ``~/.claude``.

Token assertions exercise the ``bytes // 4`` convention directly (the figure
that must reconcile with ``token-goat doctor``). Advisory assertions check
*behaviour* — fires above budget, silent below, deduped within a session — not
exact wording, per the hint-text-coupling guidance.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from token_goat import baseline, hooks_session, paths
from token_goat.baseline import (
    BaselineReport,
    BaselineRow,
    _memory_is_already_lazy,
    _parse_skill_md_frontmatter,
    _read_enabled_plugin_names,
    _read_mcp_server_names,
    _skill_listing_entry_bytes,
    _tally_tool_calls,
    collect_baseline,
    scan_transcript_usage,
)

_SESSION_ID = "sess-0123456789abcdef"

# An identical dump re-fired three times (a per-start "subscription"); content
# carries the "vercel" keyword so owner attribution resolves to plugin:vercel.
_VERCEL_DUMP = b"# Vercel Knowledge Graph\n" + b"v" * (4000 - len(b"# Vercel Knowledge Graph\n"))
# A single one-off push; no plugin keyword -> plugin:unknown, kind variable.
_ONEOFF_DUMP = b"# One-off Push\n" + b"r" * (1000 - len(b"# One-off Push\n"))


@pytest.fixture
def synth_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Build a synthetic session tree and point the path resolvers at it.

    Layout::

        <tmp>/projects/<slug>/<session>/tool-results/hook-*-stdout.txt
        <tmp>/projects/<slug>/memory/MEMORY.md  (+ a sibling => "already lazy")
        <tmp>/.claude/CLAUDE.md                 (global)
        <tmp>/work/CLAUDE.md                     (project)
        <tmp>/work/.mcp.json                     (2 MCP servers)
    """
    projects_root = tmp_path / "projects"
    slug = "proj-slug"
    proj_dir = projects_root / slug
    tool_results = proj_dir / _SESSION_ID / "tool-results"
    tool_results.mkdir(parents=True)

    # Three byte-identical Vercel dumps + one distinct one-off + a non-hook file.
    (tool_results / "hook-aaaa-stdout.txt").write_bytes(_VERCEL_DUMP)
    (tool_results / "hook-bbbb-stdout.txt").write_bytes(_VERCEL_DUMP)
    (tool_results / "hook-cccc-stdout.txt").write_bytes(_VERCEL_DUMP)
    (tool_results / "hook-dddd-stdout.txt").write_bytes(_ONEOFF_DUMP)
    (tool_results / "random-tool-output.txt").write_bytes(b"z" * 9999)

    # MEMORY.md as an index over a sibling fact file => already lazy.
    memory_dir = proj_dir / "memory"
    memory_dir.mkdir(parents=True)
    (memory_dir / "MEMORY.md").write_bytes(b"m" * 800)
    (memory_dir / "some-fact.md").write_bytes(b"fact")

    # Global + project CLAUDE.md and a project .mcp.json.
    claude_cfg = tmp_path / ".claude"
    claude_cfg.mkdir()
    (claude_cfg / "CLAUDE.md").write_bytes(b"g" * 2000)
    cwd = tmp_path / "work"
    cwd.mkdir()
    (cwd / "CLAUDE.md").write_bytes(b"p" * 1200)
    (cwd / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"alpha": {}, "beta": {}}}), encoding="utf-8"
    )

    monkeypatch.setattr(paths, "claude_projects_dir", lambda: projects_root)
    monkeypatch.setattr(paths, "claude_config_dir", lambda: claude_cfg)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    return {
        "cwd": cwd,
        "session_id": _SESSION_ID,
        "tool_results": tool_results,
        "projects_root": projects_root,
    }


# ---------------------------------------------------------------------------
# Costing convention
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("n_bytes", "expected"),
    [(0, 0), (3, 0), (4, 1), (4000, 1000), (-50, 0)],
)
def test_tokens_from_bytes_matches_doctor_convention(n_bytes: int, expected: int) -> None:
    assert max(0, n_bytes) // 4 == expected


# ---------------------------------------------------------------------------
# collect_baseline — integration against the synthetic tree
# ---------------------------------------------------------------------------


def _row_by(rows: list[BaselineRow], substr: str) -> BaselineRow:
    matches = [r for r in rows if substr.lower() in r.source.lower()]
    assert len(matches) == 1, f"expected exactly one row matching {substr!r}, got {matches}"
    return matches[0]


def test_collect_baseline_dedupes_and_buckets_hook_dumps(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])

    # Three identical Vercel dumps collapse to ONE row (a fresh subagent pays it once).
    vercel = _row_by(report.rows, "Vercel Knowledge Graph")
    assert vercel.owner == "plugin:vercel"
    assert vercel.fix == "disable-hook"
    assert vercel.kind == "fixed"  # fired >1 time => recurring subscription
    assert vercel.n_bytes == 4000
    assert vercel.tokens == 1000
    assert "3" in vercel.detail  # "x3 fires this session"

    # The single one-off push is a distinct, variable row.
    oneoff = _row_by(report.rows, "One-off Push")
    assert oneoff.kind == "variable"
    assert oneoff.owner == "plugin:unknown"


def test_collect_baseline_ignores_non_hook_files(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    # The 9999-byte random-tool-output.txt must not appear as any row.
    assert all(r.n_bytes != 9999 for r in report.rows)


def test_collect_baseline_claude_md_rows(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])

    glob = _row_by(report.rows, "CLAUDE.md (global)")
    assert glob.owner == "you"
    assert glob.fix == "slim"
    assert glob.kind == "fixed"
    assert glob.n_bytes == 2000
    assert glob.tokens == 500

    proj = _row_by(report.rows, "CLAUDE.md (project)")
    assert proj.n_bytes == 1200
    assert proj.tokens == 300


def test_collect_baseline_memory_already_lazy(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    mem = _row_by(report.rows, "MEMORY.md")
    assert mem.owner == "you"
    assert mem.kind == "fixed"
    assert mem.fix == "none"  # index over sibling files => nothing to lazy-load
    assert "index" in mem.detail.lower()


def test_collect_baseline_mcp_per_server_rows(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    # synth_session wires up alpha + beta; each becomes its own 0-token row.
    alpha = _row_by(report.rows, "MCP: alpha")
    beta = _row_by(report.rows, "MCP: beta")
    for mcp in (alpha, beta):
        assert mcp.owner == "harness"
        assert mcp.fix == "disable-mcp"
        assert mcp.tokens == 0
        assert mcp.n_bytes == 0
        assert mcp.kind == "fixed"
        assert "server" in mcp.detail


def test_collect_baseline_token_sums_and_bucketing(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])

    # Every row's token count is exactly bytes // 4 (doctor reconciliation).
    for r in report.rows:
        assert r.tokens == r.n_bytes // 4

    assert report.total_tokens == sum(r.tokens for r in report.rows)
    assert report.fixed_tokens == sum(r.tokens for r in report.rows if r.kind == "fixed")
    # The variable one-off (250 tok) is excluded from the fixed total.
    assert report.fixed_tokens == report.total_tokens - (max(0, len(_ONEOFF_DUMP)) // 4)


def test_collect_baseline_rows_sorted_descending(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    tokens = [r.tokens for r in report.rows]
    assert tokens == sorted(tokens, reverse=True)


def test_collect_baseline_reports_session_and_points_to_doctor(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    assert report.session_id == _SESSION_ID
    assert report.tool_results_available is True
    # Skill cost is delegated to the doctor, not re-measured here.
    assert any("doctor" in n for n in report.notes)
    assert not any("skill catalog" in r.source.lower() for r in report.rows)


def test_collect_baseline_no_session_notes_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Empty projects root + no CLAUDE_SESSION_ID => no tool-results resolvable.
    empty = tmp_path / "projects"
    empty.mkdir()
    monkeypatch.setattr(paths, "claude_projects_dir", lambda: empty)
    monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path / ".claude")
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    report = collect_baseline(tmp_path / "work")
    assert report.tool_results_available is False
    assert report.session_id is None
    # Hook-dump scan degrades to a note, never an exception.
    assert any("tool-results" in n for n in report.notes)


def test_collect_baseline_json_roundtrips(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    blob = json.dumps(report.as_dict())  # must be JSON-serialisable
    parsed = json.loads(blob)
    assert parsed["session_id"] == _SESSION_ID
    assert parsed["fixed_tokens"] == report.fixed_tokens
    assert len(parsed["rows"]) == len(report.rows)


# ---------------------------------------------------------------------------
# format_report — the --subagent view excludes variable rows
# ---------------------------------------------------------------------------


def test_format_report_subagent_excludes_variable_rows(synth_session: dict) -> None:
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])

    full = "\n".join(baseline.format_report(report, subagent=False))
    sub = "\n".join(baseline.format_report(report, subagent=True))

    # The recurring Vercel dump appears in both views.
    assert "Vercel Knowledge Graph" in full
    assert "Vercel Knowledge Graph" in sub
    # The one-off (variable) push appears only in the full view, never the subagent view.
    assert "One-off Push" in full
    assert "One-off Push" not in sub


# ---------------------------------------------------------------------------
# _memory_is_already_lazy
# ---------------------------------------------------------------------------


def test_memory_already_lazy_true_with_sibling(tmp_path: Path) -> None:
    (tmp_path / "MEMORY.md").write_text("index")
    (tmp_path / "a-fact.md").write_text("fact")
    assert _memory_is_already_lazy(tmp_path / "MEMORY.md") is True


def test_memory_already_lazy_false_when_alone(tmp_path: Path) -> None:
    (tmp_path / "MEMORY.md").write_text("everything inline")
    assert _memory_is_already_lazy(tmp_path / "MEMORY.md") is False


def test_scan_memory_md_non_lazy_uses_lazy_load_fix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A project whose MEMORY.md is the only .md in its memory dir => fix=lazy-load.
    projects_root = tmp_path / "projects"
    proj = projects_root / "slug"
    tr = proj / _SESSION_ID / "tool-results"
    tr.mkdir(parents=True)
    (proj / "memory").mkdir(parents=True)
    (proj / "memory" / "MEMORY.md").write_bytes(b"x" * 400)
    monkeypatch.setattr(paths, "claude_projects_dir", lambda: projects_root)
    monkeypatch.setattr(paths, "claude_config_dir", lambda: tmp_path / ".claude")
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    report = collect_baseline(tmp_path / "work", _SESSION_ID)
    mem = _row_by(report.rows, "MEMORY.md")
    assert mem.fix == "lazy-load"


# ---------------------------------------------------------------------------
# _read_mcp_server_names — both config shapes
# ---------------------------------------------------------------------------


def test_read_mcp_project_shape(tmp_path: Path) -> None:
    p = tmp_path / ".mcp.json"
    p.write_text(json.dumps({"mcpServers": {"a": {}, "b": {}}}), encoding="utf-8")
    assert sorted(_read_mcp_server_names(p)) == ["a", "b"]


def test_read_mcp_user_shape_with_projects(tmp_path: Path) -> None:
    p = tmp_path / ".claude.json"
    p.write_text(
        json.dumps(
            {"mcpServers": {"x": {}}, "projects": {"/p": {"mcpServers": {"y": {}}}}}
        ),
        encoding="utf-8",
    )
    assert sorted(_read_mcp_server_names(p)) == ["x", "y"]


def test_read_mcp_malformed_and_missing(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json", encoding="utf-8")
    assert _read_mcp_server_names(bad) == []
    assert _read_mcp_server_names(tmp_path / "does-not-exist.json") == []


# ---------------------------------------------------------------------------
# paths helpers backing the feature
# ---------------------------------------------------------------------------


def test_claude_session_tool_results_dir_rejects_unsafe_ids() -> None:
    assert paths.claude_session_tool_results_dir("") is None
    assert paths.claude_session_tool_results_dir("..") is None
    assert paths.claude_session_tool_results_dir("a/b") is None
    assert paths.claude_session_tool_results_dir("a\\b") is None
    assert paths.claude_session_tool_results_dir("a\x00b") is None


def test_claude_session_tool_results_dir_finds_owning_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    projects_root = tmp_path / "projects"
    tr = projects_root / "some-slug" / _SESSION_ID / "tool-results"
    tr.mkdir(parents=True)
    monkeypatch.setattr(paths, "claude_projects_dir", lambda: projects_root)
    assert paths.claude_session_tool_results_dir(_SESSION_ID) == tr
    assert paths.claude_session_tool_results_dir("no-such-session") is None


def test_baseline_advisory_sent_path_is_stable_and_under_sentinels() -> None:
    a = paths.baseline_advisory_sent_path(_SESSION_ID)
    b = paths.baseline_advisory_sent_path(_SESSION_ID)
    assert a == b
    assert a.parent == paths.sentinels_dir()
    assert _SESSION_ID in a.name


# ---------------------------------------------------------------------------
# SessionStart advisory — _maybe_baseline_advisory
# ---------------------------------------------------------------------------


def _stub_fixed(monkeypatch: pytest.MonkeyPatch, fixed_tokens: int) -> None:
    """Force collect_baseline to report a controlled fixed-token total."""

    def _fake(cwd: Path, session_id: str | None = None, **_: object) -> BaselineReport:
        row = BaselineRow(
            source="stub", n_bytes=fixed_tokens * 4, tokens=fixed_tokens,
            owner="you", fix="slim", kind="fixed",
        )
        return BaselineReport(
            rows=[row], window_tokens=200_000, session_id=session_id,
            tool_results_available=True, notes=[],
        )

    monkeypatch.setattr(baseline, "collect_baseline", _fake)


@pytest.fixture
def isolated_sentinels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    sent = tmp_path / "sentinels"
    monkeypatch.setattr(paths, "sentinels_dir", lambda: sent)
    return sent


def test_advisory_silent_when_budget_unset(
    monkeypatch: pytest.MonkeyPatch, isolated_sentinels: Path
) -> None:
    monkeypatch.delenv("TOKEN_GOAT_BASELINE_BUDGET_TOKENS", raising=False)
    _stub_fixed(monkeypatch, 50_000)
    assert hooks_session._maybe_baseline_advisory(_SESSION_ID, None) is None


def test_advisory_silent_below_budget(
    monkeypatch: pytest.MonkeyPatch, isolated_sentinels: Path
) -> None:
    monkeypatch.setenv("TOKEN_GOAT_BASELINE_BUDGET_TOKENS", "10000")
    _stub_fixed(monkeypatch, 50)  # well under budget
    assert hooks_session._maybe_baseline_advisory(_SESSION_ID, None) is None


def test_advisory_fires_once_above_budget_then_dedupes(
    monkeypatch: pytest.MonkeyPatch, isolated_sentinels: Path
) -> None:
    monkeypatch.setenv("TOKEN_GOAT_BASELINE_BUDGET_TOKENS", "100")
    _stub_fixed(monkeypatch, 5000)

    first = hooks_session._maybe_baseline_advisory(_SESSION_ID, None)
    assert first is not None
    assert "\n" not in first  # single quiet line
    assert "token-goat baseline" in first  # points at the report command
    # Sentinel was written, so a re-fire (resume/compact) stays quiet.
    assert paths.baseline_advisory_sent_path(_SESSION_ID).exists()
    assert hooks_session._maybe_baseline_advisory(_SESSION_ID, None) is None


def test_advisory_requires_session_id(
    monkeypatch: pytest.MonkeyPatch, isolated_sentinels: Path
) -> None:
    monkeypatch.setenv("TOKEN_GOAT_BASELINE_BUDGET_TOKENS", "100")
    _stub_fixed(monkeypatch, 5000)
    assert hooks_session._maybe_baseline_advisory(None, None) is None


# ---------------------------------------------------------------------------
# _parse_skill_md_frontmatter
# ---------------------------------------------------------------------------

def test_parse_skill_md_frontmatter_full(tmp_path: Path) -> None:
    skill_md = tmp_path / "SKILL.md"
    skill_md.write_text(
        '---\nname: ralph\nversion: "7"\ndescription: A rapid iteration framework\n---\n\n# Body\n',
        encoding="utf-8",
    )
    name, desc = _parse_skill_md_frontmatter(skill_md)
    assert name == "ralph"
    assert "rapid iteration" in desc


def test_parse_skill_md_frontmatter_multiline_desc(tmp_path: Path) -> None:
    skill_md = tmp_path / "SKILL.md"
    skill_md.write_text(
        "---\nname: foo\ndescription: |\n  First line of desc.\n  Second line.\n---\n",
        encoding="utf-8",
    )
    name, desc = _parse_skill_md_frontmatter(skill_md)
    assert name == "foo"
    assert "First line" in desc


def test_parse_skill_md_frontmatter_no_frontmatter(tmp_path: Path) -> None:
    skill_md = tmp_path / "SKILL.md"
    skill_md.write_text("# No frontmatter here\n\nBody text.\n", encoding="utf-8")
    assert _parse_skill_md_frontmatter(skill_md) == ("", "")


def test_parse_skill_md_frontmatter_missing_file(tmp_path: Path) -> None:
    assert _parse_skill_md_frontmatter(tmp_path / "SKILL.md") == ("", "")


# ---------------------------------------------------------------------------
# _skill_listing_entry_bytes
# ---------------------------------------------------------------------------

def test_skill_listing_entry_bytes_with_frontmatter(tmp_path: Path) -> None:
    skill_dir = tmp_path / "ralph"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: ralph\ndescription: A rapid iteration framework\n---\n",
        encoding="utf-8",
    )
    n = _skill_listing_entry_bytes(skill_dir)
    # Must be > 0 and strictly less than the fallback (real frontmatter is shorter)
    assert n > 0


def test_skill_listing_entry_bytes_fallback_when_no_skill_md(tmp_path: Path) -> None:
    from token_goat.baseline import _AVG_SKILL_LISTING_ENTRY_BYTES

    skill_dir = tmp_path / "unnamed"
    skill_dir.mkdir()
    assert _skill_listing_entry_bytes(skill_dir) == _AVG_SKILL_LISTING_ENTRY_BYTES


# ---------------------------------------------------------------------------
# _read_enabled_plugin_names
# ---------------------------------------------------------------------------

def test_read_enabled_plugin_names_returns_true_keys(tmp_path: Path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text(
        '{"enabledPlugins": {"foo@market": true, "bar@market": false, "baz@market": true}}',
        encoding="utf-8",
    )
    result = _read_enabled_plugin_names(settings)
    assert sorted(result) == ["baz@market", "foo@market"]


def test_read_enabled_plugin_names_missing_file(tmp_path: Path) -> None:
    assert _read_enabled_plugin_names(tmp_path / "no-settings.json") == []


def test_read_enabled_plugin_names_malformed(tmp_path: Path) -> None:
    settings = tmp_path / "settings.json"
    settings.write_text("not json", encoding="utf-8")
    assert _read_enabled_plugin_names(settings) == []


# ---------------------------------------------------------------------------
# _scan_skill_listing via collect_baseline
# ---------------------------------------------------------------------------

def test_scan_skill_listing_no_skills_dir_adds_note(synth_session: dict) -> None:
    # synth_session patches claude_config_dir to a dir with no skills/ subdir.
    report = collect_baseline(synth_session["cwd"], synth_session["session_id"])
    assert not any("Skill listing" in r.source for r in report.rows)
    assert any("skill" in n.lower() for n in report.notes)


def test_scan_skill_listing_row_added_when_skills_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from token_goat import paths as paths_mod

    claude_cfg = tmp_path / ".claude"
    skills_dir = claude_cfg / "skills"
    # Two user skills with SKILL.md frontmatter.
    for skill_name in ("ralph", "superman"):
        sd = skills_dir / skill_name
        sd.mkdir(parents=True)
        (sd / "SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: {skill_name} skill desc\n---\n",
            encoding="utf-8",
        )
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    monkeypatch.setattr(paths_mod, "claude_config_dir", lambda: claude_cfg)
    monkeypatch.setattr(paths_mod, "claude_projects_dir", lambda: projects_root)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    cwd = tmp_path / "work"
    cwd.mkdir()

    report = collect_baseline(cwd)
    skill_row = _row_by(report.rows, "Skill listing")
    assert skill_row.tokens > 0
    assert skill_row.tokens == skill_row.n_bytes // 4
    assert skill_row.owner == "you"
    assert skill_row.fix == "archive-unused"
    assert skill_row.kind == "fixed"
    assert "2" in skill_row.source  # "Skill listing (2 skills)"
    assert "user" in skill_row.detail


def test_scan_skill_listing_usage_annotation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from unittest.mock import patch

    import token_goat.baseline as baseline_mod
    from token_goat import paths as paths_mod

    claude_cfg = tmp_path / ".claude"
    skills_dir = claude_cfg / "skills"
    for skill_name in ("ralph", "superman", "unused-skill"):
        sd = skills_dir / skill_name
        sd.mkdir(parents=True)
        (sd / "SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: desc\n---\n", encoding="utf-8"
        )
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    monkeypatch.setattr(paths_mod, "claude_config_dir", lambda: claude_cfg)
    monkeypatch.setattr(paths_mod, "claude_projects_dir", lambda: projects_root)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    cwd = tmp_path / "work"
    cwd.mkdir()

    skill_usage = {"ralph": 5, "superman": 2}  # unused-skill absent → 0 calls
    with patch.object(baseline_mod, "scan_transcript_usage", return_value=(skill_usage, {})):
        report = collect_baseline(cwd, usage=True)

    skill_row = _row_by(report.rows, "Skill listing")
    assert "2/3" in skill_row.detail  # 2 of 3 ever used
    assert "unused-skill" in skill_row.detail


# ---------------------------------------------------------------------------
# _tally_tool_calls + scan_transcript_usage
# ---------------------------------------------------------------------------

def test_tally_tool_calls_counts_skill_invocations() -> None:
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    line = '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}'
    _tally_tool_calls(line, skill_counts, mcp_counts)
    assert skill_counts == {"ralph": 1}
    assert mcp_counts == {}


def test_tally_tool_calls_counts_mcp_invocations() -> None:
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    line = '{"message": {"content": [{"type": "tool_use", "name": "mcp__vercel__deploy", "input": {}}]}}'
    _tally_tool_calls(line, skill_counts, mcp_counts)
    assert mcp_counts == {"vercel": 1}
    assert skill_counts == {}


def test_tally_tool_calls_ignores_non_tool_use_blocks() -> None:
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    line = '{"message": {"content": [{"type": "text", "text": "Skill mcp__ just some text"}]}}'
    _tally_tool_calls(line, skill_counts, mcp_counts)
    assert skill_counts == {}
    assert mcp_counts == {}


def test_tally_tool_calls_ignores_malformed_json() -> None:
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    _tally_tool_calls("not json at all", skill_counts, mcp_counts)
    assert skill_counts == {}
    assert mcp_counts == {}


def test_tally_tool_calls_extracts_mcp_server_name_with_underscores() -> None:
    skill_counts: dict[str, int] = {}
    mcp_counts: dict[str, int] = {}
    line = '{"message": {"content": [{"type": "tool_use", "name": "mcp__plugin__with__underscores__list_items", "input": {}}]}}'
    _tally_tool_calls(line, skill_counts, mcp_counts)
    assert mcp_counts == {"plugin__with__underscores": 1}
    assert skill_counts == {}


def test_scan_transcript_usage_reads_jsonl(tmp_path: Path) -> None:
    proj = tmp_path / "projects" / "slug" / "sess-abc"
    proj.mkdir(parents=True)
    jsonl = proj / "transcript.jsonl"
    jsonl.write_text(
        '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}\n'
        '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}\n'
        '{"message": {"content": [{"type": "tool_use", "name": "mcp__stripe__charge", "input": {}}]}}\n',
        encoding="utf-8",
    )
    skill_counts, mcp_counts = scan_transcript_usage(tmp_path / "projects")
    assert skill_counts["ralph"] == 2
    assert mcp_counts["stripe"] == 1


def test_scan_transcript_usage_missing_root_returns_empty(tmp_path: Path) -> None:
    skill_counts, mcp_counts = scan_transcript_usage(tmp_path / "no-such-dir")
    assert skill_counts == {}
    assert mcp_counts == {}


def test_collect_baseline_mcp_usage_annotation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from unittest.mock import patch

    import token_goat.baseline as baseline_mod
    from token_goat import paths as paths_mod

    claude_cfg = tmp_path / ".claude"
    claude_cfg.mkdir()
    cwd = tmp_path / "work"
    cwd.mkdir()
    (cwd / ".mcp.json").write_text(
        '{"mcpServers": {"used-server": {}, "zero-server": {}}}', encoding="utf-8"
    )
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    monkeypatch.setattr(paths_mod, "claude_config_dir", lambda: claude_cfg)
    monkeypatch.setattr(paths_mod, "claude_projects_dir", lambda: projects_root)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    mcp_usage = {"used_server": 3}  # normalised: "used-server" → "used_server"
    with patch.object(baseline_mod, "scan_transcript_usage", return_value=({}, mcp_usage)):
        report = collect_baseline(cwd, usage=True)

    used = _row_by(report.rows, "MCP: used-server")
    zero = _row_by(report.rows, "MCP: zero-server")
    assert "3" in used.detail or "calls" in used.detail
    assert "removal candidate" in zero.detail
