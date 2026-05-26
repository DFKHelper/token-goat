"""Tests for the opt-in decision log: session storage, manifest surfacing, CLI.

The decision log preserves the *why* behind agent steps so reasoning survives
compaction alongside edited files and skill bodies.  Coverage spans:

* :func:`token_goat.session.mark_decision` mutator (append, cap, sanitize)
* :class:`token_goat.session.DecisionEntry` JSON roundtrip
* Compact manifest surfacing via the **Decisions:** section
* CLI ``token-goat decision`` append / list / session-id resolution
"""
from __future__ import annotations

from typer.testing import CliRunner

from token_goat import compact, session
from token_goat.cli import app

# ---------------------------------------------------------------------------
# session.mark_decision + DecisionEntry roundtrip
# ---------------------------------------------------------------------------

class TestMarkDecision:
    def test_appends_entry_with_text_and_timestamp(self, tmp_data_dir):
        sid = "decision-basic-session-abcd"
        cache = session.mark_decision(sid, "Picked option A over B")
        assert len(cache.decisions) == 1
        entry = cache.decisions[0]
        assert entry.text == "Picked option A over B"
        assert entry.ts > 0.0
        assert entry.tag == ""

    def test_persists_across_load(self, tmp_data_dir):
        sid = "decision-persist-session-abc"
        session.mark_decision(sid, "Locked invariant: X must hold", tag="invariant")
        reloaded = session.load(sid)
        assert len(reloaded.decisions) == 1
        assert reloaded.decisions[0].text == "Locked invariant: X must hold"
        assert reloaded.decisions[0].tag == "invariant"

    def test_tag_capped_at_24_chars(self, tmp_data_dir):
        sid = "decision-longtag-session-ab"
        long_tag = "rationale-" * 5  # 50 chars
        cache = session.mark_decision(sid, "Body text", tag=long_tag)
        assert len(cache.decisions[0].tag) <= 24

    def test_empty_text_is_skipped(self, tmp_data_dir):
        sid = "decision-empty-session-abcd"
        cache = session.mark_decision(sid, "")
        assert cache.decisions == []
        cache = session.mark_decision(sid, "   \n\t  ")
        assert cache.decisions == []

    def test_text_trimmed_when_oversized(self, tmp_data_dir):
        sid = "decision-trim-session-abcdef"
        huge = "x" * 1000
        cache = session.mark_decision(sid, huge)
        assert 0 < len(cache.decisions[0].text) <= session._MAX_DECISION_TEXT_LEN

    def test_fifo_cap_enforced(self, tmp_data_dir, monkeypatch):
        # Shrink the cap so the test is fast.  Patch the constant in both
        # session and the module-attribute used by mark_decision.
        monkeypatch.setattr(session, "DECISION_HISTORY_MAX", 5)
        monkeypatch.setattr(session, "_DECISION_HISTORY_EVICT", 2)
        sid = "decision-fifo-session-abcdef"
        for i in range(20):
            session.mark_decision(sid, f"step {i}")
        cache = session.load(sid)
        # After 20 appends with cap=5 + evict=2, length is between 1 and 5.
        assert 1 <= len(cache.decisions) <= 5
        # Newest entry must be the last appended one — FIFO drops oldest.
        assert cache.decisions[-1].text == "step 19"

    def test_invalid_session_id_does_not_crash(self, tmp_data_dir):
        # Empty / oversized session ids should not raise — mark_decision
        # logs a warning and returns the (empty) cache.
        cache = session.mark_decision("", "some text")
        # Either we got an empty cache back, or the cache has no decisions
        # because the session id was rejected and the load failed silently.
        assert cache is None or not getattr(cache, "decisions", None)

    def test_roundtrip_through_json(self, tmp_data_dir):
        import json

        sid = "decision-rt-session-abcdefgh"
        session.mark_decision(sid, "Step A", tag="rationale")
        session.mark_decision(sid, "Step B")
        cache = session.load(sid)
        js = cache.to_json()
        d = json.loads(js)
        assert "decisions" in d
        assert len(d["decisions"]) == 2
        # Reload via from_dict and compare
        c2 = session.SessionCache.from_dict(d)
        assert len(c2.decisions) == 2
        assert c2.decisions[0].text == "Step A"
        assert c2.decisions[0].tag == "rationale"
        assert c2.decisions[1].text == "Step B"
        assert c2.decisions[1].tag == ""

    def test_legacy_cache_without_decisions_field(self, tmp_data_dir):
        # An older session cache predating the field should load with an empty list.
        legacy = {
            "schema_version": 1,
            "session_id": "legacy-decisions-session-ab",
            "started_ts": 1.0,
            "last_activity_ts": 2.0,
            "edited_files": {},
        }
        c = session.SessionCache.from_dict(legacy)
        assert c.decisions == []


# ---------------------------------------------------------------------------
# Compact manifest surfacing
# ---------------------------------------------------------------------------

class TestManifestSurfacing:
    def test_decisions_section_present_when_logged(self, tmp_data_dir):
        sid = "decisions-in-manifest-abcdefab"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        session.mark_decision(
            sid, "Picked option A because lower regression risk", tag="rationale"
        )
        manifest = compact.build_manifest(sid)
        assert "**Decisions:**" in manifest
        assert "rationale" in manifest
        assert "Picked option A" in manifest

    def test_no_decisions_section_when_empty(self, tmp_data_dir):
        sid = "decisions-empty-manifest-abcdef"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        manifest = compact.build_manifest(sid)
        assert "**Decisions:**" not in manifest

    def test_overflow_recall_hint_when_above_render_cap(self, tmp_data_dir, monkeypatch):
        # Force a small render cap so we can trigger the overflow hint with
        # just a few logged decisions.
        monkeypatch.setattr(compact, "_MAX_DECISIONS", 2)
        sid = "decisions-overflow-manifest-ab"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        for i in range(5):
            session.mark_decision(sid, f"decision {i}", tag=f"t{i}")
        manifest = compact.build_manifest(sid)
        # Newest 2 surface, with an overflow line for the remaining 3.
        assert "**Decisions:**" in manifest
        assert "decision 4" in manifest
        assert "+3 more" in manifest
        assert "token-goat decision --list" in manifest

    def test_decisions_alone_keep_manifest_alive(self, tmp_data_dir):
        # When only decisions exist (no edits/reads/etc.), the manifest must
        # still render — this verifies the suppression gate honours the field.
        sid = "decisions-only-session-abcdefab"
        session.mark_decision(sid, "Spike: try approach Y", tag="rationale")
        manifest = compact.build_manifest(sid)
        assert "**Decisions:**" in manifest
        assert "approach Y" in manifest

    def test_section_count_includes_decisions(self, tmp_data_dir):
        sid = "decisions-count-session-abcdef"
        session.mark_decision(sid, "step 1")
        session.mark_decision(sid, "step 2")
        cache = session.load(sid)
        counts = compact._compute_section_counts(cache)
        assert counts.get("decision") == 2


# ---------------------------------------------------------------------------
# CLI ``token-goat decision``
# ---------------------------------------------------------------------------

class TestCliDecision:
    def test_appends_and_records_stat(self, tmp_data_dir, monkeypatch):
        from token_goat import db as _db
        sid = "cli-decision-session-abcdefab"
        # Pre-create the session so the CLI's "most recently modified" picker
        # selects it deterministically.
        session.mark_file_edited(sid, "/proj/src/foo.py")
        recorded: list[tuple] = []

        def _spy(project_hash, kind, *, tokens_saved=0, bytes_saved=0, detail=None):
            recorded.append((kind, tokens_saved, bytes_saved, detail))
        monkeypatch.setattr(_db, "record_stat", _spy)

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["decision", "Picked option A because cheaper", "--session-id", sid, "--tag", "rationale"],
        )
        assert result.exit_code == 0, result.output
        assert "recorded decision" in result.output
        cache = session.load(sid)
        assert any(
            d.text == "Picked option A because cheaper" and d.tag == "rationale"
            for d in cache.decisions
        )
        assert any(r[0] == "decision_log" for r in recorded)

    def test_list_prints_recent_entries(self, tmp_data_dir):
        sid = "cli-decision-list-session-abc"
        session.mark_decision(sid, "step 1", tag="t1")
        session.mark_decision(sid, "step 2", tag="t2")
        session.mark_decision(sid, "step 3")
        runner = CliRunner()
        result = runner.invoke(app, ["decision", "", "--list", "--session-id", sid])
        assert result.exit_code == 0, result.output
        assert "[t1] step 1" in result.output
        assert "[t2] step 2" in result.output
        assert "step 3" in result.output

    def test_list_with_limit_truncates_oldest(self, tmp_data_dir):
        sid = "cli-decision-limit-session-ab"
        for i in range(5):
            session.mark_decision(sid, f"step {i}")
        runner = CliRunner()
        result = runner.invoke(app, ["decision", "", "--list", "-s", sid, "--limit", "2"])
        assert result.exit_code == 0, result.output
        # Newest 2 must be present; oldest 3 must not.
        assert "step 4" in result.output
        assert "step 3" in result.output
        assert "step 0" not in result.output

    def test_empty_text_without_list_fails(self, tmp_data_dir):
        sid = "cli-decision-empty-session-ab"
        session.mark_file_edited(sid, "/proj/src/foo.py")
        runner = CliRunner()
        result = runner.invoke(app, ["decision", "", "-s", sid])
        assert result.exit_code != 0
        assert "empty" in result.output.lower()

    def test_missing_session_id_when_no_caches_exists_errors(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["decision", "any text"])
        assert result.exit_code != 0
        # Either "no session cache" or "no session found" — both are valid.
        assert "no session" in result.output.lower()

    def test_short_session_id_resolves(self, tmp_data_dir):
        sid = "cli-decision-short-resolve-abc"
        session.mark_file_edited(sid, "/proj/src/foo.py")  # ensure cache exists
        runner = CliRunner()
        # Use the first 8 chars as a short prefix.
        short = sid[:8]
        result = runner.invoke(app, ["decision", "text body", "-s", short])
        assert result.exit_code == 0, result.output
        cache = session.load(sid)
        assert any(d.text == "text body" for d in cache.decisions)


# ---------------------------------------------------------------------------
# Stats integration
# ---------------------------------------------------------------------------

class TestStatsIntegration:
    def test_decision_log_kind_routes_to_compact_bucket(self):
        from token_goat import stats
        assert stats.kind_to_source("decision_log") == stats.SOURCE_COMPACT
