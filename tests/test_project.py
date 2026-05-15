"""Tests for project detection and path canonicalization."""

from token_goat.project import canonicalize, find_project, project_hash


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
