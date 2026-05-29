"""Regression tests for config-controlled features at non-default values.

Covers three config keys that gate important behavior but had no tests
exercising the non-default value at the hook / feature level:

1. compact_assist.enabled=False  pre_compact hook returns CONTINUE without
   building a manifest and without calling build_manifest_with_count.

2. compact_assist.triggers=["manual"]  pre_compact skips when trigger="auto"
   because "auto" is absent from the allowed list.

3. repomap.compact_file_threshold=0  disables the summary-line path so the
   full file list is always emitted regardless of file count.
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# 1. compact_assist.enabled=False  pre_compact returns CONTINUE immediately
# ---------------------------------------------------------------------------


class TestPreCompactDisabled:
    """pre_compact hook returns CONTINUE without manifest when enabled=False."""

    def _make_disabled_cfg(self):
        from token_goat import config as config_mod

        cfg = config_mod.Config()
        cfg.compact_assist.enabled = False
        return cfg

    def test_disabled_returns_continue(self, tmp_data_dir, monkeypatch):
        """pre_compact with compact_assist.enabled=False returns {"continue": True}."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import config as config_mod
        from token_goat import hooks_cli

        disabled_cfg = self._make_disabled_cfg()
        with patch.object(config_mod, "load", return_value=disabled_cfg):
            result = hooks_cli.pre_compact(
                {"session_id": "iter285-disabled-compact", "trigger": "manual"}
            )

        assert result.get("continue") is True

    def test_disabled_does_not_call_build_manifest(self, tmp_data_dir, monkeypatch):
        """pre_compact with enabled=False must not invoke build_manifest_with_count."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import compact as compact_mod
        from token_goat import config as config_mod
        from token_goat import hooks_cli

        disabled_cfg = self._make_disabled_cfg()
        with patch.object(config_mod, "load", return_value=disabled_cfg), \
             patch.object(compact_mod, "build_manifest_with_count") as mock_build:
            hooks_cli.pre_compact(
                {"session_id": "iter285-disabled-no-manifest", "trigger": "manual"}
            )

        mock_build.assert_not_called()

    def test_disabled_result_has_no_system_message(self, tmp_data_dir, monkeypatch):
        """pre_compact with enabled=False must not inject a systemMessage."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import config as config_mod
        from token_goat import hooks_cli

        disabled_cfg = self._make_disabled_cfg()
        with patch.object(config_mod, "load", return_value=disabled_cfg):
            result = hooks_cli.pre_compact(
                {"session_id": "iter285-disabled-no-sys", "trigger": "auto"}
            )

        assert "systemMessage" not in result


# ---------------------------------------------------------------------------
# 2. compact_assist.triggers=["manual"]  pre_compact skips trigger="auto"
# ---------------------------------------------------------------------------


class TestPreCompactTriggerFilter:
    """pre_compact skips when the incoming trigger is not in cfg.triggers."""

    def _make_manual_only_cfg(self):
        from token_goat import config as config_mod

        cfg = config_mod.Config()
        cfg.compact_assist.enabled = True
        cfg.compact_assist.triggers = ["manual"]
        return cfg

    def test_auto_trigger_skipped_when_not_in_list(self, tmp_data_dir, monkeypatch):
        """trigger=auto is rejected when cfg.triggers only contains manual."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import config as config_mod
        from token_goat import hooks_cli

        manual_only_cfg = self._make_manual_only_cfg()
        with patch.object(config_mod, "load", return_value=manual_only_cfg):
            result = hooks_cli.pre_compact(
                {"session_id": "iter285-trigger-filter", "trigger": "auto"}
            )

        assert result.get("continue") is True
        assert "systemMessage" not in result

    def test_auto_trigger_skipped_does_not_call_build_manifest(self, tmp_data_dir, monkeypatch):
        """When trigger=auto is not in the allowed list, build_manifest is never called."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import compact as compact_mod
        from token_goat import config as config_mod
        from token_goat import hooks_cli

        manual_only_cfg = self._make_manual_only_cfg()
        with patch.object(config_mod, "load", return_value=manual_only_cfg), \
             patch.object(compact_mod, "build_manifest_with_count") as mock_build:
            hooks_cli.pre_compact(
                {"session_id": "iter285-trigger-no-manifest", "trigger": "auto"}
            )

        mock_build.assert_not_called()

    def test_manual_trigger_proceeds_past_trigger_gate(self, tmp_data_dir, monkeypatch):
        """trigger=manual is accepted when cfg.triggers=[manual], proceeds to build."""
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        monkeypatch.delenv("TOKENWISE_COMPACT_ASSIST", raising=False)

        from token_goat import compact as compact_mod
        from token_goat import config as config_mod
        from token_goat import hooks_cli
        from token_goat import session as session_mod

        manual_only_cfg = self._make_manual_only_cfg()
        manual_only_cfg.compact_assist.min_events = 0

        mock_cache = MagicMock()
        mock_cache.created_ts = time.time()
        mock_cache.edited_files = {}
        mock_cache.files = {}
        mock_cache.bash_history = None
        mock_cache.web_history = None

        captured: dict = {}

        def _fake_build(session_id, max_tokens=400):
            captured["called"] = True
            return ("## manifest", 5)

        with patch.object(config_mod, "load", return_value=manual_only_cfg), \
             patch.object(session_mod, "safe_load", return_value=mock_cache), \
             patch.object(compact_mod, "build_manifest_with_count", side_effect=_fake_build):
            hooks_cli.pre_compact(
                {"session_id": "iter285-manual-proceeds", "trigger": "manual"}
            )

        assert captured.get("called") is True, (
            "build_manifest_with_count should be called for manual trigger"
        )


# ---------------------------------------------------------------------------
# 3. repomap.compact_file_threshold=0  always emits full list
# ---------------------------------------------------------------------------


class TestRepomapThresholdZeroDisabled:
    """repomap.compact_file_threshold=0 disables the summary-line path."""

    def _make_map_worthy_project(self, tmp_path, make_project, n_files: int, name: str):
        """Create and index a project with *n_files* map-worthy Python files.

        Each file is padded past the _is_map_worthy threshold (approx_lines >= 4,
        i.e. size >= 200 bytes) following the same pattern as test_repomap.py's
        _make_synthetic_project helper.
        """
        from token_goat.parser import index_project

        proj_root = tmp_path / name
        src = proj_root / "src"
        src.mkdir(parents=True)
        pad = "# padding line to clear _MIN_DISPLAY_LINES threshold\n" * 6
        for i in range(n_files):
            (src / f"mod_{i:03d}.py").write_text(
                f"{pad}"
                f"def fn_{i}_a():\n    pass\n\n"
                f"def fn_{i}_b():\n    pass\n\n"
                f"class Cls_{i}:\n    pass\n",
                encoding="utf-8",
            )
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj

    def test_threshold_zero_does_not_trigger_summary_line(
        self, tmp_path, tmp_data_dir, make_project
    ):
        """With threshold=0, compact mode never emits the N files indexed summary."""
        from token_goat import repomap

        proj = self._make_map_worthy_project(tmp_path, make_project, 60, "summary_disabled")

        text = repomap.build_map(
            proj,
            budget_tokens=10000,
            compact=True,
            compact_file_threshold=0,
        )

        assert "files indexed. Top modules:" not in text, (
            f"threshold=0 must suppress the summary line; got:\n{text[:500]}"
        )

    def test_threshold_zero_shows_individual_file_entries(
        self, tmp_path, tmp_data_dir, make_project
    ):
        """With threshold=0, individual file entries are still emitted (not collapsed)."""
        from token_goat import repomap

        proj = self._make_map_worthy_project(tmp_path, make_project, 10, "full_list")

        text = repomap.build_map(
            proj,
            budget_tokens=10000,
            compact=True,
            compact_file_threshold=0,
        )

        file_lines = [line for line in text.splitlines() if "[python," in line]
        assert len(file_lines) == 10, (
            f"expected 10 individual file entries with threshold=0, got {len(file_lines)}"
        )

    def test_threshold_zero_vs_active_threshold_behaviour_contrast(
        self, tmp_path, tmp_data_dir, make_project
    ):
        """Contrast: threshold=0 (full list) vs threshold=5 (summary line) on same project."""
        from token_goat import repomap

        # 20 map-worthy files; threshold=5 should trigger the summary-line path,
        # while threshold=0 should always emit the full list.
        proj = self._make_map_worthy_project(tmp_path, make_project, 20, "contrast")

        # threshold=5 with 20 files triggers the summary-line path
        text_summary = repomap.build_map(
            proj,
            budget_tokens=300,
            compact=True,
            compact_file_threshold=5,
        )

        # threshold=0 means full list, no summary line
        text_full = repomap.build_map(
            proj,
            budget_tokens=300,
            compact=True,
            compact_file_threshold=0,
        )

        assert "files indexed. Top modules:" in text_summary, (
            "threshold=5 with 20 files should trigger summary line"
        )
        assert "files indexed. Top modules:" not in text_full, (
            "threshold=0 must never emit summary line"
        )
