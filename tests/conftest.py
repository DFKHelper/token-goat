"""Shared test fixtures and helpers for the token-goat test suite.

Quick reference — fixtures available to all test files
=======================================================

Data isolation (use one per test or test class)
------------------------------------------------
``tmp_data_dir`` (function-scoped)
    Patches ``token_goat.paths.data_dir`` to a fresh pytest ``tmp_path``.
    Use this in any test that calls ``skill_cache.store_output``,
    ``session.load/save``, ``db.open_*``, or any other code that writes
    under ``data_dir()``.  Yields the ``Path`` object so you can inspect
    what was written.

    To apply to every method in a class without repeating the parameter::

        class TestFoo:
            @pytest.fixture(autouse=True)
            def _isolate_data_dir(self, tmp_data_dir):
                self.tmp_data_dir = tmp_data_dir

``module_tmp_data_dir`` (module-scoped)
    Same as ``tmp_data_dir`` but shared across the whole test module.
    Only safe for read-only test groups — tests that write embeddings or
    mutate the indexed DB should stay at function scope.

Home directory isolation
------------------------
``patched_home``
    Creates a fake home dir under ``tmp_path/home`` and monkeypatches
    ``Path.home()`` to point at it.  Used by install tests.

Helper functions (module-level, import from conftest directly)
--------------------------------------------------------------
``make_project_from_root(root)``
    Build a ``Project`` from a directory path.  Pair with ``tmp_data_dir``.

``make_fake_git_repo(parent, name)``
    Create a minimal ``.git/HEAD`` stub — no subprocesses, ~5x faster than
    ``make_git_repo``.  Use when the test only needs project detection, not
    actual git operations.

``make_git_repo(parent, name, *, files, commits, ...)``
    Create a real git repo under ``parent/name``.  Optional ``files`` dict
    seeds a single initial commit; ``commits`` list seeds multiple commits.
    Marked ``@pytest.mark.slow`` — inject into tests that need real history.

``make_large_skill_body(size_bytes)``
    Return a padded skill body string of at least *size_bytes* bytes.
    Useful for testing gzip compression thresholds.

``make_skill_body_with_sections(size_bytes)``
    Return a multi-section skill body (## Overview, ## Rules, etc.) of
    at least *size_bytes* bytes.  Used by section-extraction tests.

``fire_skill_hook(session_id, skill_name, body)``
    Fire the ``PostToolUse(Skill)`` hook and return the response dict.
    Replaces the 8-line payload-build + ``hooks_skill.post_skill`` call.

Skill preservation helpers (fixtures, import via parameter)
-----------------------------------------------------------
``skill_compress_cfg``
    Returns ``SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)``.
    The most common skill-preservation config in iter tests.

``patch_skill_config``
    Context-manager factory.  Usage::

        with patch_skill_config(skill_compress_cfg) as mock_cfg:
            meta = skill_cache.store_output("sess", "skill", body)

Session factory
---------------
``make_session`` (fixture, requires ``tmp_data_dir``)
    Returns the ``_make_session`` factory.  Build a ``SessionCache`` with
    optional backdated timestamp, pre-read files, edits, web fetches, and
    bash runs.  See ``_make_session`` docstring for keyword args.

Project fixtures (function-scoped, index the sample fixtures)
-------------------------------------------------------------
``ts_project``, ``py_project``, ``md_project``
    Index the sample fixture directory and return just the ``Project``.

``ts_project_tuple``, ``py_project_tuple``, ``md_project_tuple``
    Same but return ``(proj_root, project)`` for tests that need the path.

``ts_project_unindexed``, ``py_project_unindexed``, ``md_project_unindexed``
    Copy sample fixture to tmp dir without indexing.  Tests that do their
    own indexing use these.

Module-scoped project fixtures (index once per test module)
-----------------------------------------------------------
``ts_project_module``, ``py_project_module``, ``md_project_module``
    Module-scoped equivalents of the function-scoped project fixtures.
    Only safe for read-only test groups.

``ts_project_tuple_module``, ``py_project_tuple_module``, ``md_project_tuple_module``
    Module-scoped ``(proj_root, project)`` tuple equivalents.

Autouse fixtures (active for all tests, no import needed)
---------------------------------------------------------
``isolate_hooks_stderr_log``
    Redirects ``hooks-stderr.log`` writes to a session-scoped temp file.
    Prevents test hook crashes from polluting the real log.  Session-scoped
    (one directory for the whole run) to eliminate per-test tmpdir creation.

``isolate_registry``
    Replaces ``winreg`` with an in-memory fake so no test touches the real
    Windows registry.

``isolate_worker_autostart``
    Stubs ``worker._register_autostart`` to a no-op.

``_disable_user_git_hooks`` (session-scoped)
    Points ``core.hooksPath`` at an empty directory for the pytest session.
    Prevents user-global lefthook from firing on every ``git init/commit``
    (~20-30 s overhead per call on Windows).

``isolate_hook_logging``
    Prevents hook dispatch from writing to the real daily log file.
"""
import logging
import os
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

import token_goat.paths as paths
from token_goat.project import Project, canonicalize, project_hash
from token_goat.session import SessionCache

# ---------------------------------------------------------------------------
# Hypothesis CI profile — register before any test file imports hypothesis.
#
# In CI (CI=true) we use max_examples=50 to cut the 3 300-example property
# test suite down to ~450 examples.  Locally, we use 200 examples for a
# faster feedback loop while still catching edge cases.  The default
# hypothesis profile (300-500 per-test) is kept for dedicated fuzz/property
# runs via ``-m hypothesis`` or explicit profile override.
# ---------------------------------------------------------------------------
try:
    from hypothesis import HealthCheck
    from hypothesis import settings as _h_settings

    _h_settings.register_profile(
        "ci",
        max_examples=50,
        suppress_health_check=list(HealthCheck),
    )
    _h_settings.register_profile(
        "default",
        max_examples=200,
        suppress_health_check=[HealthCheck.too_slow],
    )
    if os.environ.get("CI") == "true":
        _h_settings.load_profile("ci")
    else:
        _h_settings.load_profile("default")
except ImportError:
    pass  # hypothesis optional; test_parser_malformed.py / test_range_overlap_props.py skip without it

# ---------------------------------------------------------------------------
# Home-directory helpers (used by test_install.py and test_install_codex.py)
# ---------------------------------------------------------------------------


def fake_home(tmp_path: Path) -> Path:
    """Return a fake home directory rooted at tmp_path/home."""
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    return home


def patch_home(monkeypatch, home: Path) -> None:
    """Monkeypatch Path.home() to return *home*."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))


@pytest.fixture
def patched_home(tmp_path, monkeypatch) -> Path:
    """Fixture: create a fake home dir and monkeypatch Path.home() to point at it.

    Replaces the repeated two-liner in install tests::

        home = _fake_home(tmp_path)
        _patch_home(monkeypatch, home)

    Tests that still need ``monkeypatch`` for other setattr calls can declare
    both ``patched_home`` and ``monkeypatch`` — pytest injects the same
    ``monkeypatch`` instance to both.
    """
    home = fake_home(tmp_path)
    patch_home(monkeypatch, home)
    return home

# ---------------------------------------------------------------------------
# Shared hook-response assertions — see tests/hook_helpers.py
# ---------------------------------------------------------------------------
# assert_continue and assert_deny live in hook_helpers.py (importable module).
# Test files import them directly: from hook_helpers import assert_continue

# Sample fixture directories - centralized to avoid duplication across test files
FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"
PY_SAMPLE = FIXTURE_DIR / "py_sample"
MD_SAMPLE = FIXTURE_DIR / "md_sample"
GO_SAMPLE = FIXTURE_DIR / "go_sample"
RUST_SAMPLE = FIXTURE_DIR / "rust_sample"
JS_SAMPLE = FIXTURE_DIR / "js_sample"


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch token_goat.paths.data_dir to a temporary directory.

    Also clears module-level caches that would otherwise carry stale data
    across tests when the data_dir changes between test invocations:
    - session._proc_load_cache: process-local session load cache (keyed by
      session_id; stale entries from a prior tmp_path would be served to
      the next test that reuses the same session_id string).
    - compact._manifest_sha_written_this_process: set that gates sidecar
      re-reads; if a test writes a manifest for "sid-1" the entry persists
      into the next test's context, corrupting the sidecar cache-hit check.
    - compact git-related caches (keyed by cwd/project_root): stale entries
      from tests in other modules running on the same xdist worker can
      populate these with data from a different tmp_path, corrupting
      uncommitted-changes or diff-stat sections of the manifest.
    """
    from token_goat import compact as _compact_mod
    from token_goat import config as _config_mod
    from token_goat import session as _session_mod

    def _clear_caches() -> None:
        _session_mod._proc_load_cache.clear()
        _compact_mod._manifest_sha_written_this_process.clear()
        _compact_mod._diff_stat_summary_cache.clear()
        _compact_mod._uncommitted_changes_cache.clear()
        _compact_mod._is_git_repo_cache.clear()
        _compact_mod._whole_diff_cache.clear()
        _compact_mod._blocker_preview_cache.clear()
        _config_mod._config_mtime_cache = None

    _clear_caches()
    with patch.object(paths, 'data_dir', return_value=tmp_path):
        yield tmp_path
    _clear_caches()


@pytest.fixture(autouse=True, scope="session")
def isolate_hooks_stderr_log(tmp_path_factory):
    """Redirect hooks-stderr.log writes to an isolated tmp file for the test session.

    Prevents test-induced hook crashes (``RuntimeError: boom``, ``_CustomBaseExc: boom``,
    etc.) from polluting the production logs/hooks-stderr.log, which keeps
    ``token-goat doctor --crashes`` output free of test noise.

    Session-scoped so that pytest creates only ONE temporary directory for this
    purpose across the entire 11 K-test suite, rather than one per test.  The
    production log is fully redirected for the whole session; test isolation is
    maintained because paths.set_hooks_stderr_log_override() is a process-global
    override and serial execution (-n 0) means no two tests run concurrently.
    """
    isolated = tmp_path_factory.mktemp("hooks_stderr") / "test-hooks-stderr.log"
    paths.set_hooks_stderr_log_override(isolated)
    yield isolated
    paths.set_hooks_stderr_log_override(None)


def make_project_from_root(root: Path) -> Project:
    """Construct a Project from a root directory.

    Helper function for test fixtures. Use in project fixtures like:
        proj_root = tmp_path / "sample"
        shutil.copytree(SOURCE, proj_root)
        return make_project_from_root(proj_root)
    """
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


def make_fake_git_repo(parent: Path, name: str = "repo") -> Path:
    """Create a minimal fake git repo under ``parent/name`` without spawning any subprocess.

    Creates only the directory structure needed for ``project.find_project()`` to
    detect the directory as a git repo: a ``.git/`` subdirectory and a ``HEAD`` file
    pointing at ``refs/heads/main``.  No git binary is invoked, so this is ~3–7x
    faster than :func:`make_git_repo` for tests that only need the marker to exist.

    Use this instead of ``make_git_repo`` when the test:

    * only calls ``find_project()`` or checks that the project is detected
    * does NOT run ``git status``, ``git log``, ``git diff``, or ``git commit``
    * does NOT need real commit history, staged files, or a usable worktree

    Returns the repo root path (``parent/name``).
    """
    repo = parent / name
    repo.mkdir()
    git_dir = repo / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    return repo


def make_git_repo(
    parent: Path,
    name: str = "repo",
    *,
    files: dict[str, str] | None = None,
    commits: list[tuple[dict[str, str], str]] | None = None,
    email: str = "t@t.com",
    user: str = "T",
    commit_message: str = "init",
    init_branch: str | None = None,
) -> Path:
    """Create a minimal git repo under ``parent/name`` and return its path.

    Consolidates the ``git init`` + two ``git config`` calls (plus an optional
    initial add + commit when ``files`` is provided) that test_compact.py and
    test_git_history.py would otherwise repeat across every integration site —
    each site previously expanded to ~7 subprocess invocations. Pair with the
    session-scoped ``_disable_user_git_hooks`` fixture (also in this conftest)
    so the call chain doesn't fire any global lefthook on each commit.

    Two ways to seed history:
    - ``files`` + ``commit_message``: single commit with the given content
    - ``commits``: list of ``(files_dict, commit_message)`` tuples — each
      becomes a separate commit so the resulting repo has multi-commit history
      (used by tests that exercise git-log walking)

    ``init_branch`` lets tests pin the initial branch name (e.g. ``"main"``)
    so they don't depend on the user's global init.defaultBranch.
    """
    import subprocess
    repo = parent / name
    repo.mkdir()
    init_cmd = ["git", "init"]
    if init_branch:
        init_cmd += ["-b", init_branch]
    subprocess.run(init_cmd, cwd=repo, capture_output=True, check=True, timeout=30)
    subprocess.run(
        ["git", "config", "user.email", email],
        cwd=repo,
        capture_output=True,
        check=True,
        timeout=30,
    )
    subprocess.run(
        ["git", "config", "user.name", user],
        cwd=repo,
        capture_output=True,
        check=True,
        timeout=30,
    )

    def _stage_and_commit(payload: dict[str, str], msg: str) -> None:
        for rel, content in payload.items():
            path = repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        subprocess.run(
            ["git", "add", "."], cwd=repo, capture_output=True, check=True, timeout=30,
        )
        subprocess.run(
            ["git", "commit", "-m", msg], cwd=repo, capture_output=True, check=True, timeout=30,
        )

    if commits is not None:
        for payload, msg in commits:
            _stage_and_commit(payload, msg)
    elif files:
        _stage_and_commit(files, commit_message)
    return repo


# Expose as fixture for use in test files
@pytest.fixture
def make_project(tmp_data_dir):
    """Fixture that provides make_project_from_root function.

    Use in test functions like:
        def test_something(make_project):
            proj_root = tmp_path / "sample"
            shutil.copytree(SOURCE, proj_root)
            proj = make_project(proj_root)
    """
    return make_project_from_root


# ---------------------------------------------------------------------------
# Module-scoped data-dir fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def module_tmp_data_dir(tmp_path_factory):
    """Like tmp_data_dir but module-scoped: one patched data_dir per test module.

    Use ONLY in read-only test groups where no test mutates the indexed DB in
    a way that would corrupt later tests in the same module.  Tests that write
    embeddings, re-index, or mutate project files must keep function scope.
    """
    from token_goat import compact as _compact_mod
    from token_goat import session as _session_mod

    _session_mod._proc_load_cache.clear()
    _compact_mod._manifest_sha_written_this_process.clear()
    tmp_path = tmp_path_factory.mktemp("module_data")
    with patch.object(paths, "data_dir", return_value=tmp_path):
        yield tmp_path


class _FakeRegistryKey:
    """In-memory stand-in for an open registry key handle."""

    def __init__(self, values: dict):
        self.values = values

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeWinreg:
    """In-memory fake of the stdlib ``winreg`` module.

    Covers exactly the surface token-goat's install/uninstall/doctor code uses.
    Backed by one dict so a write through one handle is visible to a read
    through another within the same test. Used by the ``isolate_registry``
    autouse fixture so no test can ever touch the real Windows registry.
    """

    HKEY_CURRENT_USER = "HKCU"
    HKEY_LOCAL_MACHINE = "HKLM"
    REG_SZ = 1
    KEY_SET_VALUE = 0x0002
    KEY_READ = 0x20019

    def __init__(self) -> None:
        self._values: dict[str, object] = {}

    def OpenKey(self, hive, path, reserved, access):  # noqa: N802
        return _FakeRegistryKey(self._values)

    def OpenKeyEx(self, hive, path, reserved=0, access=0):  # noqa: N802
        return self.OpenKey(hive, path, reserved, access)

    def SetValueEx(self, key, name, reserved, reg_type, value):  # noqa: N802
        key.values[name] = value

    def QueryValueEx(self, key, name):  # noqa: N802
        if name not in key.values:
            raise FileNotFoundError(name)
        return key.values[name], self.REG_SZ

    def DeleteValue(self, key, name):  # noqa: N802
        if name not in key.values:
            raise FileNotFoundError(name)
        del key.values[name]

    def CloseKey(self, key):  # noqa: N802
        pass


@pytest.fixture(autouse=True)
def isolate_registry(monkeypatch):
    r"""Stop any test from reading or writing the real Windows registry.

    install_all()/uninstall_all() — and install_worker_task()/uninstall_tasks()
    — call ``winreg`` directly. A test exercising them unmocked writes, then
    DELETES, the user's real ``token-goat-worker`` HKCU Run key (the worker's
    autostart entry) on every ``pytest`` run — which is exactly what
    test_install_uninstall_round_trip did. Replace ``winreg`` in sys.modules
    with an in-memory fake for every test. A test that needs to assert on
    specific registry writes installs its own fake on top — it wins, being set
    up after this fixture.
    """
    import sys

    monkeypatch.setitem(sys.modules, "winreg", _FakeWinreg())
    yield


@pytest.fixture(autouse=True)
def isolate_worker_autostart(monkeypatch):
    """Stop the worker from touching the real HKCU Run key during tests.

    run_daemon() self-registers autostart via worker._register_autostart(),
    which writes to the user's actual Windows registry. Every run_daemon test
    would otherwise mutate the real machine. Stub the worker's registration
    seam to a no-op; tests that exercise the registration itself capture the
    real callable at import time and invoke it directly.
    """
    import token_goat.worker as worker
    monkeypatch.setattr(worker, "_register_autostart", lambda: None)
    yield


@pytest.fixture(autouse=True)
def _pin_claudecode_harness(monkeypatch):
    """Pin the detected harness to claudecode so manifest output is environment-independent.

    compact.build_manifest() resolves the harness via detect_harness(config.harness);
    with the default config value "auto" that falls through to ambient env probes
    (CLAUDE_CODE_SESSION_ID / ANTHROPIC_API_KEY -> "claudecode", otherwise "generic").
    On a Claude Code dev machine those keys are present, so the whole suite rendered the
    full-section claudecode manifest and passed; on a plain shell or CI the identical
    tests resolved to "generic" — which strips the bash/web/symbol/skill sections — and
    51 manifest assertions failed. Setting TOKEN_GOAT_HARNESS_OVERRIDE removes that
    ambient dependency for every test, reproducing the dev-machine behaviour everywhere.

    Tests that intentionally exercise a different harness are unaffected: they either
    pass an explicit ``harness=`` argument (bypassing env detection entirely), pin it via
    config through ``_load_config`` (detect_harness returns a non-"auto" config_override
    directly, never consulting the env var), or ``delenv`` this override in their own body
    (the function-scoped monkeypatch runs after this fixture, so the test wins).
    """
    monkeypatch.setenv("TOKEN_GOAT_HARNESS_OVERRIDE", "claudecode")
    yield


@pytest.fixture(autouse=True, scope="session")
def _suppress_real_spawns():
    """Block spawn_detached() and spawn_index_detached() from forking real processes.

    Both functions check TOKEN_GOAT_NO_WORKER_SPAWN and return None immediately
    when it is set. This fixture sets that variable for the entire pytest session
    so that any code path reaching a spawn function (e.g. via _nudge_worker_if_down
    -> ensure_running -> spawn_detached) cannot leave orphaned daemon processes
    after the test suite exits.

    Tests that specifically exercise the spawn code path (Popen mocked, PID
    assertions) must opt out with::

        monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    """
    import os
    prev = os.environ.get("TOKEN_GOAT_NO_WORKER_SPAWN")
    os.environ["TOKEN_GOAT_NO_WORKER_SPAWN"] = "1"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop("TOKEN_GOAT_NO_WORKER_SPAWN", None)
        else:
            os.environ["TOKEN_GOAT_NO_WORKER_SPAWN"] = prev


@pytest.fixture(autouse=True, scope="session")
def _disable_user_git_hooks(tmp_path_factory):
    """Stop the user's global ``core.hooksPath`` from firing on every test git call.

    Many test files spin up real git repos (`git init`, `git commit`, ...). If the
    user has ``core.hookspath`` set globally (e.g. to a lefthook wrapper), each
    `git` invocation triggers that hook — adding 20-30 s per call on Windows.
    The whole test_compact integration suite balloons to several minutes from
    this alone.

    We inject an override via the ``GIT_CONFIG_*`` env-var protocol that points
    ``core.hooksPath`` at an empty directory. The override applies for the
    pytest session, is undone on teardown, and doesn't require monkeypatching
    every test that touches git.
    """
    import os

    empty_hooks = tmp_path_factory.mktemp("empty_git_hooks")
    overrides = {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.hooksPath",
        "GIT_CONFIG_VALUE_0": str(empty_hooks),
    }
    saved = {k: os.environ.get(k) for k in overrides}
    os.environ.update(overrides)
    try:
        yield
    finally:
        for k, prev in saved.items():
            if prev is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = prev


@pytest.fixture(autouse=True)
def isolate_hook_logging(monkeypatch):
    """Stop hook handlers from writing to the production log file during tests.

    The hook dispatcher attaches a FileHandler at paths.logs_dir() / YYYY-MM-DD.log
    — the user's real daily log. Without this fixture, every test that dispatches
    a hook (including fail-soft tests that intentionally throw) pollutes it.
    We disable _setup_logging() for the test and clear any handlers that were
    already attached to the hooks logger before/after.
    """
    import token_goat.hooks_cli as hooks_cli
    monkeypatch.setattr(hooks_cli, "_setup_logging", lambda: None)

    log = logging.getLogger("token_goat.hooks")
    saved = list(log.handlers)
    for h in saved:
        log.removeHandler(h)
    try:
        yield
    finally:
        for h in list(log.handlers):
            log.removeHandler(h)
        for h in saved:
            log.addHandler(h)


# ============================================================================
# Project Fixture Factories
# ============================================================================
# Consolidated project-creation fixtures to eliminate duplication across
# test_read_replacement.py, test_embeddings.py, test_index_pipeline.py, test_repomap.py


def _make_sample_project(tmp_path: Path, tmp_data_dir, make_project, sample_path: Path, indexed: bool = False):
    """Internal helper: copy sample fixture to tmp dir, optionally index, return (proj_root, project).

    Args:
        tmp_path: pytest tmp_path fixture
        tmp_data_dir: monkeypatched data_dir fixture
        make_project: project-builder fixture
        sample_path: source fixture directory (e.g., TS_SAMPLE)
        indexed: if True, call index_project(proj, full=True) before returning

    Returns:
        (proj_root, project) tuple, or just project if indexed (for repomap fixture pattern)
    """
    sample_name = sample_path.name
    proj_root = tmp_path / sample_name
    shutil.copytree(sample_path, proj_root)
    # Create a minimal .git dir so find_project() detects this as a project
    # when the CLI runs internal find_project(Path.cwd()) after monkeypatch.chdir.
    (proj_root / ".git").mkdir(exist_ok=True)
    proj = make_project(proj_root)
    if indexed:
        from token_goat.parser import (
            index_project,  # noqa: PLC0415 — deferred to avoid loading tree-sitter on every worker
        )
        index_project(proj, full=True)
    return (proj_root, proj) if indexed else proj


# Unindexed project fixtures (for tests that do their own indexing)
@pytest.fixture
def ts_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=False)


@pytest.fixture
def py_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=False)


@pytest.fixture
def md_project_unindexed(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, return project (not indexed)."""
    return _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=False)


# Indexed project fixtures - tuple variants (for read_replacement tests)
@pytest.fixture
def ts_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, index it, return (proj_root, project).

    Used by test_read_replacement.py. Returns a tuple for unpacking:
        proj_root, proj = ts_project_tuple
    """
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=True)
    return proj_root, proj


@pytest.fixture
def py_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=True)
    return proj_root, proj


@pytest.fixture
def md_project_tuple(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=True)
    return proj_root, proj


# Indexed project fixtures - project-only (for embeddings, repomap, index_pipeline tests)
@pytest.fixture
def ts_project(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, index it, return just the Project.

    Used by test_embeddings.py, test_repomap.py, test_index_pipeline.py.
    """
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, TS_SAMPLE, indexed=True)
    return proj


@pytest.fixture
def py_project(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, index it, return just the Project.

    Used by test_index_pipeline.py.
    """
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, PY_SAMPLE, indexed=True)
    return proj


@pytest.fixture
def md_project(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, index it, return just the Project."""
    _, proj = _make_sample_project(tmp_path, tmp_data_dir, make_project, MD_SAMPLE, indexed=True)
    return proj


# ---------------------------------------------------------------------------
# Module-scoped project fixtures — index once per test module, not per test.
# SAFE only for read-only test groups (no index_project re-runs, no DB writes,
# no write_text on the project root that affects indexed content).
# ---------------------------------------------------------------------------


def _make_sample_project_module(tmp_path_factory, sample_path: Path):
    """Build an indexed project under a single module-scoped temp dir.

    Uses one tmp dir as both the data_dir and the parent for the project tree
    to minimise mktemp calls.  Returns (proj_root, project, data_dir) so the
    caller can hold the paths.data_dir patch open for the fixture's lifetime.
    """
    base = tmp_path_factory.mktemp(f"mod_{sample_path.name}")
    proj_root = base / sample_path.name
    shutil.copytree(sample_path, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)
    data_dir = base / "data"
    data_dir.mkdir()
    with patch.object(paths, "data_dir", return_value=data_dir):
        proj = make_project_from_root(proj_root)
        from token_goat.parser import (
            index_project,  # noqa: PLC0415 — deferred to avoid loading tree-sitter on every worker
        )
        index_project(proj, full=True)
    return proj_root, proj, data_dir


@pytest.fixture(scope="module")
def ts_project_module(tmp_path_factory):
    """Module-scoped ts_sample project — indexed once per test module.

    The fixture manages its own paths.data_dir context for the duration of the
    module run.  Suitable for read-only symbol/section query tests.
    """
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, TS_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj


@pytest.fixture(scope="module")
def py_project_module(tmp_path_factory):
    """Module-scoped py_sample project — indexed once per test module."""
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, PY_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj


@pytest.fixture(scope="module")
def md_project_module(tmp_path_factory):
    """Module-scoped md_sample project — indexed once per test module."""
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, MD_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj


@pytest.fixture(scope="module")
def ts_project_tuple_module(tmp_path_factory):
    """Module-scoped ts_sample project — returns (proj_root, project) tuple.

    Module-scoped equivalent of ts_project_tuple.  Safe for read-only tests.
    """
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, TS_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj_root, proj


@pytest.fixture(scope="module")
def py_project_tuple_module(tmp_path_factory):
    """Module-scoped py_sample project — returns (proj_root, project) tuple."""
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, PY_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj_root, proj


@pytest.fixture(scope="module")
def md_project_tuple_module(tmp_path_factory):
    """Module-scoped md_sample project — returns (proj_root, project) tuple."""
    proj_root, proj, data_dir = _make_sample_project_module(tmp_path_factory, MD_SAMPLE)
    with patch.object(paths, "data_dir", return_value=data_dir):
        yield proj_root, proj


# ============================================================================
# Session Fixture Factory
# ============================================================================


def _make_session(
    session_id: str,
    *,
    age_seconds: float = 0.0,
    files_read: int = 0,
    greps: int = 0,
    edits: int = 0,
    web_fetches: dict | None = None,
    bash_runs: dict | None = None,
) -> SessionCache:
    """Create and populate a SessionCache with optional backdating and activity.

    Args:
        session_id: Unique session identifier
        age_seconds: Backdate created_ts by this many seconds (0 = now)
        files_read: Number of files to mark as read (default 0)
        greps: Number of grep patterns to record (default 0)
        edits: Number of files to mark as edited (default 0)
        web_fetches: Dict of {url: body_bytes} for web fetch entries (default None)
        bash_runs: Dict of {command: (output_bytes, exit_code)} for bash runs (default None)

    Returns:
        Populated SessionCache object.

    Example:
        cache = make_session(
            "test-abc",
            age_seconds=7200,
            files_read=2,
            edits=1,
            web_fetches={"https://docs.example.com/api": 12000},
            bash_runs={"pytest -v": (8000, 0)},
        )
    """
    import time

    from token_goat import bash_cache, session

    # Create or load session
    cache = session.load(session_id)

    # Backdate if requested
    if age_seconds > 0:
        cache.created_ts = time.time() - age_seconds
        session.save(cache)

    # Populate with file reads
    for i in range(files_read):
        session.mark_file_read(session_id, f"/proj/src/file{i}.py", offset=0, limit=100)

    # Populate with greps
    for i in range(greps):
        session.mark_grep(session_id, f"pattern{i}", "/proj/src")

    # Populate with file edits
    for i in range(edits):
        session.mark_file_edited(session_id, f"/proj/src/edited{i}.py")

    # Populate with web fetches
    if web_fetches:
        import hashlib
        for url, body_bytes in web_fetches.items():
            url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
            session.mark_web_fetch(
                session_id=session_id,
                url_sha=url_sha,
                url_preview=url[:200],
                output_id=f"web-{url_sha}",
                body_bytes=body_bytes,
                status_code=200,
                truncated=False,
            )

    # Populate with bash runs
    if bash_runs:
        for cmd, (output_bytes, exit_code) in bash_runs.items():
            cmd_sha = bash_cache.command_hash(cmd)
            session.mark_bash_run(
                session_id=session_id,
                cmd_sha=cmd_sha,
                cmd_preview=cmd,
                output_id=f"out-{cmd_sha}",
                stdout_bytes=output_bytes,
                stderr_bytes=0,
                exit_code=exit_code,
                truncated=False,
            )

    return session.load(session_id)


@pytest.fixture
def make_session(tmp_data_dir) -> callable:
    """Fixture that provides a session factory function.

    Use in test functions like:
        def test_something(make_session):
            cache = make_session("test-id", age_seconds=3600, files_read=2, edits=1)
            assert cache.session_id == "test-id"
    """
    return _make_session


# ============================================================================
# Skill Cache / SkillPreservationConfig Helpers
# ============================================================================
# These fixtures eliminate the repeated 3-line pattern found throughout the
# skill iter tests:
#   from token_goat.config import SkillPreservationConfig
#   cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
#   with patch("token_goat.config.load") as mock_cfg:
#       mock_cfg.return_value.skill_preservation = cfg_sp
#       ...
# Use `skill_compress_cfg` when you only need the config object, and
# `patch_skill_config` when you need the patcher itself.


@pytest.fixture
def skill_compress_cfg():
    """Return a SkillPreservationConfig with compression enabled at a 1 KB threshold.

    The most common config in skill iter tests.  Equivalent to:
        SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)
    """
    from token_goat.config import SkillPreservationConfig

    return SkillPreservationConfig(compress_bodies=True, compress_min_bytes=1024)


@pytest.fixture
def patch_skill_config():
    """Context-manager factory that patches token_goat.config.load with a given skill_preservation.

    Usage::

        def test_something(tmp_data_dir, patch_skill_config, skill_compress_cfg):
            from token_goat import skill_cache
            with patch_skill_config(skill_compress_cfg) as mock_cfg:
                meta = skill_cache.store_output("sess", "skill", body)
    """
    from contextlib import contextmanager

    @contextmanager
    def _patch(skill_preservation_cfg):
        with patch("token_goat.config.load") as mock_cfg:
            mock_cfg.return_value.skill_preservation = skill_preservation_cfg
            yield mock_cfg

    return _patch


def make_large_skill_body(size_bytes: int = 20_000) -> str:
    """Return a padded skill body string at least *size_bytes* long.

    Used by tests that need a large body to trigger gzip compression or other
    size-sensitive code paths. Module-level function (not a fixture) so tests can
    call it with different sizes without fixture overhead.
    """
    line = "# Skill Body\n\n" + ("This is skill content with words. " * 20 + "\n") * 20
    while len(line.encode("utf-8")) < size_bytes:
        line += "More content here for padding purposes.\n"
    return line


def make_skill_body_with_sections(size_bytes: int = 20_000) -> str:
    """Return a multi-section skill body at least *size_bytes* long.

    Contains ## Overview, ## Rules, ## Implementation Details, and ## Summary
    sections. Used by tests that exercise section extraction on compressed bodies.
    Module-level function (not a fixture) so tests can call it with different sizes.
    """
    lines = [
        "# Big Skill",
        "",
        "## Overview",
        "",
        "This skill does many things.",
        "",
        "## Rules",
        "",
        "MUST follow rules.",
        "NEVER skip steps.",
        "",
        "## Implementation Details",
        "",
    ]
    filler = "This is detailed implementation content with lots of words. " * 10
    while sum(len(ln) + 1 for ln in lines) < size_bytes:
        lines.append(filler)
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("The summary section.")
    return "\n".join(lines)


def fire_skill_hook(session_id: str, skill_name: str, body: str) -> dict:
    """Fire the PostToolUse(Skill) hook and return the response dict.

    Consolidates the repeated 8-line payload-build + ``hooks_skill.post_skill``
    call that previously appeared in test_skill_compact_integration.py,
    test_skill_final_chain_integration.py, test_skill_iter10_integration.py, and
    test_skill_preservation.py.

    Usage::

        from conftest import fire_skill_hook

        def test_something(tmp_data_dir):
            resp = fire_skill_hook("my-session", "ralph", body_text)
            assert resp.get("continue") is True
    """
    from token_goat import hooks_skill

    payload = {
        "session_id": session_id,
        "tool_name": "Skill",
        "tool_input": {"skill": skill_name},
        "tool_response": body,
    }
    return hooks_skill.post_skill(payload)


