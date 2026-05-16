"""Tests for project detection and path canonicalization."""

import sys

import pytest

from token_goat.project import canonicalize, find_project, make_project_at, project_hash


def test_canonicalize_lowercases_windows_drive(tmp_path):
    p = canonicalize(tmp_path)
    s = p.as_posix()
    if len(s) >= 2 and s[1] == ":":
        assert s[0].islower(), f"drive letter not lowercased: {s}"


def test_canonicalize_is_idempotent(tmp_path):
    a = canonicalize(tmp_path)
    b = canonicalize(a)
    assert a == b


def test_project_hash_is_stable_and_deterministic(tmp_path):
    h1 = project_hash(canonicalize(tmp_path))
    h2 = project_hash(canonicalize(tmp_path))
    assert h1 == h2
    assert len(h1) == 40  # sha1 hex


def test_find_project_with_git_marker(tmp_path):
    (tmp_path / ".git").mkdir()
    proj = find_project(tmp_path)
    assert proj is not None
    assert proj.root == canonicalize(tmp_path)
    assert proj.marker == ".git"


def test_find_project_walks_up(tmp_path):
    (tmp_path / "package.json").write_text("{}")
    nested = tmp_path / "sub" / "deeper"
    nested.mkdir(parents=True)
    proj = find_project(nested)
    assert proj is not None
    assert proj.root == canonicalize(tmp_path)


def test_find_project_does_not_find_marker_in_same_dir(tmp_path):
    # Verify: if no marker exists, we walk up (or return None at root)
    nested = tmp_path / "sub" / "deeper"
    nested.mkdir(parents=True)
    proj = find_project(nested)
    # Either we find a marker in a parent (which is fine), or None (if we hit root)
    # The important part: we don't crash on empty dirs
    assert proj is None or proj.root != nested


def test_find_project_shopify_marker(tmp_path):
    (tmp_path / "shopify.app.toml").write_text("")
    proj = find_project(tmp_path)
    assert proj is not None
    assert proj.marker == "shopify.app.toml"


def test_find_project_skips_repo_container(tmp_path):
    """A stray `.git` at a directory that merely holds many independent repos
    must not swallow the whole supertree into one giant project.

    This is the environmental half of the "unknown project hash" bug: an
    accidental `git init` at a container like C:\\Projects made find_project
    return the container, and everything under it indexed as one project.
    """
    container = tmp_path / "Projects"
    container.mkdir()
    (container / ".git").mkdir()  # the stray accidental `git init`
    for name in ("repo_a", "repo_b", "repo_c"):
        child = container / name
        child.mkdir()
        (child / ".git").mkdir()

    # A markerless scratch dir directly under the container.
    scratch = container / "scratch"
    scratch.mkdir()
    proj = find_project(scratch)
    assert proj is None or proj.root != canonicalize(container), (
        "find_project returned the repo-container as a project"
    )

    # Querying the container directly also does not treat it as a project.
    direct = find_project(container)
    assert direct is None or direct.root != canonicalize(container)

    # A real repo nested in the container is still detected as itself.
    repo_a = find_project(container / "repo_a")
    assert repo_a is not None
    assert repo_a.root == canonicalize(container / "repo_a")


# ---------------------------------------------------------------------------
# Security: make_project_at must reject non-directories
# ---------------------------------------------------------------------------


def test_make_project_at_rejects_file(tmp_path):
    """make_project_at must raise ValueError when given a file path, not a directory."""
    f = tmp_path / "notadir.txt"
    f.write_text("content")
    with pytest.raises(ValueError, match="not a directory"):
        make_project_at(f)


def test_make_project_at_rejects_nonexistent(tmp_path):
    """make_project_at must raise ValueError for a path that does not exist."""
    missing = tmp_path / "does_not_exist"
    with pytest.raises(ValueError, match="not a directory"):
        make_project_at(missing)


def test_make_project_at_accepts_real_directory(tmp_path):
    """make_project_at must succeed for a real existing directory."""
    proj = make_project_at(tmp_path)
    assert proj.root == canonicalize(tmp_path)
    assert proj.marker == "manual"


# ---------------------------------------------------------------------------
# Security: find_project must reject out-of-root symlinks used as markers
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks require elevated privileges on Windows")
def test_find_project_rejects_symlink_marker_pointing_outside_root(tmp_path):
    """A symlinked .git that points outside the candidate directory must not
    make find_project accept that directory as a project root.

    Attack vector: attacker plants mydir/.git -> /etc/passwd (or any path
    outside mydir). Without this guard, find_project would return mydir as a
    project and the indexer would crawl it, potentially triggering further
    operations on unrelated filesystem paths.
    """
    # Create a real directory that the symlink will point to (not a git repo).
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()

    candidate = tmp_path / "candidate"
    candidate.mkdir()

    # Plant a symlink: candidate/.git -> ../outside (escapes candidate)
    (candidate / ".git").symlink_to(outside_dir)

    proj = find_project(candidate)
    # candidate should NOT be returned as a project because its .git symlink
    # resolves outside candidate's own tree.
    assert proj is None or proj.root != canonicalize(candidate), (
        "find_project accepted a candidate whose .git marker is a symlink escaping the root"
    )


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks require elevated privileges on Windows")
def test_find_project_accepts_symlink_marker_within_root(tmp_path):
    """A symlinked marker that resolves within the project root is legitimate and accepted."""
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    # Create a real .git dir inside the project
    real_git = project_dir / ".git-real"
    real_git.mkdir()

    # Symlink .git -> .git-real (within the project root — legitimate)
    (project_dir / ".git").symlink_to(real_git)

    proj = find_project(project_dir)
    assert proj is not None
    assert proj.root == canonicalize(project_dir)
    assert proj.marker == ".git"
