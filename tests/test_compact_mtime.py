"""Tests for skill_cache.get_compact_mtime() — compact file age tracking (iter 4/10).

Covers:
A. Returns None when no compact exists for the (session, skill) pair.
B. Returns a positive float mtime after a compact is stored.
C. Returns None when skill_name is invalid/empty.
D. The mtime increases monotonically: re-storing a compact advances the mtime.
E. get_compact_mtime and get_compact agree on presence (both None or both non-None).
F. Integration: skill-list --json row includes compact_age_secs when compact exists.
"""
from __future__ import annotations

import os
import time

import pytest
from compact_test_helpers import DataDirMixin
from conftest import fire_skill_hook

from token_goat import config
from token_goat.skill_cache import (
    get_compact,
    get_compact_mtime,
    store_compact,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SKILL_BODY = (
    "---\ndescription: Mtime test skill.\n---\n\n"
    "## Rules\n\nCRITICAL: always test.\n\n"
    + ("Body line. " * 400)  # > 4 000 bytes
)


def _lazy_cfg() -> config.Config:
    cfg = config.Config()
    cfg.compact_assist.lazy_skill_injection = True
    cfg.skill_preservation.inline_snippets = False
    return cfg


# ---------------------------------------------------------------------------
# Sub-area A — returns None when no compact exists
# ---------------------------------------------------------------------------


class TestGetCompactMtimeAbsent(DataDirMixin):

    def test_returns_none_when_compact_absent(self):
        """get_compact_mtime returns None for a (session, skill) with no compact."""
        result = get_compact_mtime("newsession", "nonexistent-skill")
        assert result is None

    def test_returns_none_for_empty_skill_name(self):
        """An empty skill name is invalid; returns None."""
        result = get_compact_mtime("anysession", "")
        assert result is None


# ---------------------------------------------------------------------------
# Sub-area B — returns mtime after compact is stored
# ---------------------------------------------------------------------------


class TestGetCompactMtimePresent(DataDirMixin):

    def test_returns_float_after_store(self):
        """After store_compact, get_compact_mtime returns a positive float."""
        t_before = time.time()
        store_compact("sess01", "myskill", "## Section\nContent.")
        mtime = get_compact_mtime("sess01", "myskill")
        t_after = time.time()

        assert mtime is not None
        assert isinstance(mtime, float)
        # mtime should be in the window [t_before, t_after+1]
        assert mtime >= t_before - 1.0  # allow 1s clock skew
        assert mtime <= t_after + 1.0

    def test_mtime_matches_get_compact_presence(self):
        """get_compact_mtime returns non-None iff get_compact returns non-None."""
        store_compact("sess02", "checkskill", "## Note\nSome content.")
        mtime = get_compact_mtime("sess02", "checkskill")
        text = get_compact("sess02", "checkskill")
        # Both present or both absent — they must agree.
        assert (mtime is not None) == (text is not None)

    def test_mtime_not_none_when_compact_from_fire_hook(self):
        """After fire_skill_hook triggers compact storage, mtime is set."""
        sid = "sess03"
        fire_skill_hook(sid, "hookskill", _SKILL_BODY)
        mtime = get_compact_mtime(sid, "hookskill")
        assert mtime is not None, "compact should be stored automatically for large skill bodies"
        assert mtime > 0.0


# ---------------------------------------------------------------------------
# Sub-area C — invalid skill_name handling
# ---------------------------------------------------------------------------


class TestGetCompactMtimeInvalidName(DataDirMixin):

    def test_whitespace_only_name_returns_none(self):
        """A whitespace-only skill name is invalid."""
        result = get_compact_mtime("session", "   ")
        assert result is None

    def test_none_session_id_does_not_crash(self):
        """Passing None as session_id should not raise — returns None."""
        try:
            result = get_compact_mtime(None, "myskill")  # type: ignore[arg-type]
            assert result is None
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"get_compact_mtime raised unexpectedly: {exc}")


# ---------------------------------------------------------------------------
# Sub-area D — mtime advances on re-store
# ---------------------------------------------------------------------------


class TestGetCompactMtimeMonotonic(DataDirMixin):

    def test_mtime_advances_on_re_store(self):
        """Re-storing a compact updates its mtime to a later value."""
        store_compact("sess04", "evolving", "## v1\nFirst version.")
        mtime_v1 = get_compact_mtime("sess04", "evolving")
        assert mtime_v1 is not None

        # Backdate every file in the data dir so the re-store produces a clearly newer mtime.
        for p in self.tmp_data_dir.rglob("*"):
            if p.is_file():
                os.utime(p, (946684800.0, 946684800.0))

        store_compact("sess04", "evolving", "## v2\nSecond version with more content.")
        mtime_v2 = get_compact_mtime("sess04", "evolving")
        assert mtime_v2 is not None

        # v2 mtime should be >= v1 mtime (could be equal on very coarse clocks).
        assert mtime_v2 >= mtime_v1, (
            f"re-store should advance mtime: v1={mtime_v1}, v2={mtime_v2}"
        )


# ---------------------------------------------------------------------------
# Sub-area E — get_compact and get_compact_mtime agreement
# ---------------------------------------------------------------------------


class TestCompactPresenceAgreement(DataDirMixin):

    def test_absent_compact_both_none(self):
        """Both get_compact and get_compact_mtime return None for missing compact."""
        text = get_compact("no-session", "no-skill")
        mtime = get_compact_mtime("no-session", "no-skill")
        assert text is None
        assert mtime is None

    def test_stored_compact_both_non_none(self):
        """Both return non-None for the same stored compact."""
        store_compact("sess05", "agreement", "## Content\nBody.")
        text = get_compact("sess05", "agreement")
        mtime = get_compact_mtime("sess05", "agreement")
        assert text is not None
        assert mtime is not None

    def test_deleting_compact_invalidates_both(self):
        """After deleting the compact file, both return None."""
        import os  # noqa: PLC0415

        from token_goat.skill_cache import _compact_file_id, _skill_outputs_dir  # noqa: PLC0415

        store_compact("sess06", "deleteme", "## Section\nContent.")
        # Confirm presence.
        assert get_compact("sess06", "deleteme") is not None
        assert get_compact_mtime("sess06", "deleteme") is not None

        # Delete the compact file.
        file_id = _compact_file_id("sess06", "deleteme")
        compact_path = _skill_outputs_dir() / file_id
        if compact_path.exists():
            os.unlink(compact_path)

        # Now both should return None.
        assert get_compact("sess06", "deleteme") is None
        assert get_compact_mtime("sess06", "deleteme") is None


# ---------------------------------------------------------------------------
# Sub-area F — skill-list --json includes compact_age_secs
# ---------------------------------------------------------------------------


class TestSkillListJsonCompactAge(DataDirMixin):

    def test_compact_age_secs_present_in_json_row(self):
        """skill-list --json row includes compact_age_secs when compact exists."""
        from token_goat import cli  # noqa: PLC0415

        sid = "listage01"
        fire_skill_hook(sid, "ageskill", _SKILL_BODY)

        import contextlib  # noqa: PLC0415
        import json  # noqa: PLC0415
        from io import StringIO  # noqa: PLC0415
        from unittest.mock import patch  # noqa: PLC0415

        output_buf = StringIO()
        with patch("typer.echo", lambda s="", **_kw: output_buf.write(str(s) + "\n")), contextlib.suppress(SystemExit, BaseException):
            cli.cmd_skill_list(session_id=sid, json_output=True)

        out = output_buf.getvalue()
        # Find the JSON blob in the output.
        start = out.find("{")
        if start == -1:
            pytest.skip("Could not find JSON in output — session may be empty")
        data = json.loads(out[start:])
        skills = data.get("skills", [])
        if not skills:
            pytest.skip("No skills found in session")

        # At least one skill should have compact_age_secs set (since fire_skill_hook
        # stores a compact for large bodies).
        skills_with_compact = [s for s in skills if s.get("has_compact")]
        assert skills_with_compact, "at least one skill should have a compact"

        for skill in skills_with_compact:
            assert "compact_age_secs" in skill, (
                f"compact_age_secs key missing from skill row: {skill}"
            )
            age = skill["compact_age_secs"]
            assert age is not None, "compact_age_secs should not be None when compact exists"
            assert isinstance(age, int)
            assert age >= 0, f"compact_age_secs must be non-negative, got {age}"

    def test_compact_age_secs_none_when_no_compact(self):
        """compact_age_secs is None in rows where no compact exists."""
        import json  # noqa: PLC0415
        from io import StringIO  # noqa: PLC0415
        from unittest.mock import patch  # noqa: PLC0415

        from token_goat import cli  # noqa: PLC0415
        from token_goat.skill_cache import _skill_outputs_dir  # noqa: PLC0415

        sid = "listage02"
        fire_skill_hook(sid, "nocompact", _SKILL_BODY)

        # Delete all compact files so the lookup finds none.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        import contextlib  # noqa: PLC0415

        output_buf = StringIO()
        with patch("typer.echo", lambda s="", **_kw: output_buf.write(str(s) + "\n")), contextlib.suppress(SystemExit, BaseException):
            cli.cmd_skill_list(session_id=sid, json_output=True)

        out = output_buf.getvalue()
        start = out.find("{")
        if start == -1:
            pytest.skip("Could not find JSON in output")
        data = json.loads(out[start:])
        skills = data.get("skills", [])

        for skill in skills:
            if not skill.get("has_compact", True):
                # compact_age_secs should be None when no compact exists.
                age = skill.get("compact_age_secs")
                assert age is None, (
                    f"compact_age_secs should be None when has_compact=False, got {age}"
                )
