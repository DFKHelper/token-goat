"""Tests for cli_stats._render_top_session_files."""
from __future__ import annotations


def _seed_session(sid: str, file_counts: dict[str, int]) -> None:
    """Create a session file with the given file_access_counts."""
    from token_goat import paths as _paths
    from token_goat import session as _session
    cache = _session.load(sid)
    cache.file_access_counts.update(file_counts)
    sessions_dir = _paths.data_dir() / "sessions"
    _paths.ensure_dir(sessions_dir)
    (sessions_dir / f"{sid}.json").write_text(cache.to_json(), encoding="utf-8")
    _session._proc_load_cache.pop(sid, None)


class TestRenderTopSessionFiles:

    def test_no_sessions_dir_returns_empty(self, tmp_data_dir) -> None:
        from token_goat.cli_stats import _render_top_session_files
        assert _render_top_session_files() == ""

    def test_empty_sessions_dir_returns_empty(self, tmp_data_dir) -> None:
        from token_goat import paths as _paths
        from token_goat.cli_stats import _render_top_session_files
        (_paths.data_dir() / "sessions").mkdir(parents=True, exist_ok=True)
        assert _render_top_session_files() == ""

    def test_single_access_files_filtered_out(self, tmp_data_dir) -> None:
        from token_goat.cli_stats import _render_top_session_files
        _seed_session("topfiles-filter-01", {"/proj/src/auth.py": 1})
        assert _render_top_session_files() == ""

    def test_multi_access_files_appear_in_output(self, tmp_data_dir) -> None:
        from token_goat.cli_stats import _render_top_session_files
        _seed_session("topfiles-multi-01", {
            "/proj/src/auth.py": 5,
            "/proj/src/models.py": 3,
        })
        result = _render_top_session_files()
        assert "Top files this session" in result
        assert "auth.py" in result
        assert "models.py" in result

    def test_output_sorted_descending_by_count(self, tmp_data_dir) -> None:
        from token_goat.cli_stats import _render_top_session_files
        _seed_session("topfiles-sort-01", {
            "/proj/a.py": 2,
            "/proj/b.py": 10,
            "/proj/c.py": 7,
        })
        result = _render_top_session_files()
        assert result.index("b.py") < result.index("c.py") < result.index("a.py")

    def test_top_n_limits_output(self, tmp_data_dir) -> None:
        from token_goat.cli_stats import _render_top_session_files
        counts = {f"/proj/file{i}.py": i + 2 for i in range(10)}
        _seed_session("topfiles-topn-01", counts)
        result = _render_top_session_files(top_n=3)
        file_lines = [ln for ln in result.splitlines() if "x  " in ln]
        assert len(file_lines) <= 3
