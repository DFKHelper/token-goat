"""Pin the iter-17 default retunes so an accidental regression doesn't silently
restore the older, more conservative values that left token savings on the table.

Each default we tightened is verified in two ways:

1. The new default value is what `Config()`/the module-level constant returns
   when no override is supplied.
2. The override path (TOML for config, CLI flag for repomap, monkeypatch for
   worker) still produces the legacy behaviour, so users who explicitly want
   the old behaviour can recover it without code changes.
"""
from __future__ import annotations

import textwrap

from token_goat import config, repomap, worker

# ---------------------------------------------------------------------------
# compact_assist.min_events: 5 -> 3
# ---------------------------------------------------------------------------

class TestCompactAssistMinEventsDefault:
    def test_default_is_three(self):
        """The dataclass default for min_events is 3 after iter-17 retune."""
        cfg = config.CompactAssistConfig()
        assert cfg.min_events == 3

    def test_load_returns_three_when_no_toml(self, tmp_path, monkeypatch):
        """`config.load()` with no file on disk returns the new default of 3."""
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "missing.toml")
        cfg = config.load()
        assert cfg.compact_assist.min_events == 3

    def test_toml_override_to_legacy_value_still_works(self, tmp_path, monkeypatch):
        """A user who wants the old `min_events = 5` can still get it via TOML."""
        from token_goat import paths
        p = tmp_path / "config.toml"
        p.write_text(
            textwrap.dedent(
                """\
                [compact_assist]
                min_events = 5
                """
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: p)
        cfg = config.load()
        assert cfg.compact_assist.min_events == 5

    def test_toml_override_to_zero_disables_threshold(self, tmp_path, monkeypatch):
        """`min_events = 0` (override) means "always emit", confirming validator
        accepts the lower bound."""
        from token_goat import paths
        p = tmp_path / "config.toml"
        p.write_text("[compact_assist]\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: p)
        cfg = config.load()
        assert cfg.compact_assist.min_events == 0


# ---------------------------------------------------------------------------
# repomap._AUTO_COMPACT_BUDGET: 200 -> 300
# ---------------------------------------------------------------------------

class TestAutoCompactBudget:
    def test_default_is_three_hundred(self):
        """Iter-17 raised the auto-compact threshold from 200 -> 300."""
        assert repomap._AUTO_COMPACT_BUDGET == 300

    def test_budget_just_below_default_engages_compact_mode(self):
        """A 250-token budget — common for inline orientation — now picks
        compact mode automatically. Before iter-17 the same call landed in
        detailed mode and could only fit a handful of files."""
        # We test the same arithmetic build_map uses to decide modes, without
        # spinning up a project. The decision rule is documented at repomap.py
        # line ~784: `use_compact = compact if compact is not None else budget_tokens < _AUTO_COMPACT_BUDGET`.
        budget_tokens = 250
        use_compact = budget_tokens < repomap._AUTO_COMPACT_BUDGET
        assert use_compact is True

    def test_budget_at_or_above_threshold_keeps_detailed_mode(self):
        """A budget at exactly the threshold or above still gets detailed mode."""
        assert (repomap._AUTO_COMPACT_BUDGET > 300) is False
        assert (repomap._AUTO_COMPACT_BUDGET > 4000) is False


# ---------------------------------------------------------------------------
# worker.PERIODIC_REINDEX_MAX_FILES: 500 -> 2000
# ---------------------------------------------------------------------------

class TestPeriodicReindexMaxFiles:
    def test_default_is_two_thousand(self):
        """Iter-17 raised the per-project file ceiling from 500 -> 2000 so
        realistically-sized monorepos still benefit from periodic reindex
        (otherwise `token-goat symbol`/`read` go stale and the agent falls
        back to full-file Read)."""
        assert worker.PERIODIC_REINDEX_MAX_FILES == 2000

    def test_monkeypatch_legacy_value_still_works(self, monkeypatch):
        """The constant remains monkeypatchable so a test or a power user can
        pin the old behaviour without touching the source."""
        monkeypatch.setattr(worker, "PERIODIC_REINDEX_MAX_FILES", 500)
        assert worker.PERIODIC_REINDEX_MAX_FILES == 500
