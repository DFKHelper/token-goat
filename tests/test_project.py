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


def test_project_hash_known_vectors_durable_format():
    """Lock down the on-disk DB filename format against silent algorithm swaps.

    The hash output is the filename of ``projects/{hash}.db`` on the user's
    machine.  Any algorithm change (e.g. "let's switch to xxhash for speed")
    invalidates EVERY existing per-project DB on upgrade — the user loses
    indexed symbols, embeddings, stats, and decision-log history without
    so much as a warning.  These known-value vectors guarantee a CI failure
    the moment such a swap is attempted.

    If this test ever needs to change, the accompanying commit MUST include
    a migration shim (try new-style hash, fall back to old-style hash if
    not found) so live installs keep working.

    Vectors are derived from the documented algorithm: sha1 of
    ``canonical_root.as_posix().encode("utf-8")``.  ``canonicalize`` is
    responsible for lowercasing the drive letter; the hash sees that already
    in lowercase form.
    """
    from pathlib import PurePosixPath

    # Use PurePosixPath so the canonical-posix surface is consistent across
    # the Windows test runner and the Linux CI runner.  Real callers pass the
    # output of ``canonicalize()`` which has already collapsed both shells
    # onto this same posix form.
    cases = {
        # Lowercased Windows drive letter, posix separators — typical Windows
        # canonical form coming out of canonicalize("C:\\work\\foo").
        "c:/work/foo": "5009f1e60b77a0e38e173f99c447b9f004d9b338",
        # POSIX/WSL form.
        "/home/u/repo": "d971d9f4d1c16fc77a6f96201e08b16fd0d76cb4",
    }
    for posix_path, expected_hash in cases.items():
        # The function signature takes Path, not str — passing PurePosixPath
        # keeps the test cross-platform.  project_hash uses .as_posix() so any
        # Path subclass with the same posix surface yields the same hash.
        actual = project_hash(PurePosixPath(posix_path))  # type: ignore[arg-type]
        assert actual == expected_hash, (
            f"project_hash format change detected for {posix_path!r}: "
            f"got {actual}, expected {expected_hash}. "
            "If this is intentional, the commit MUST include a migration "
            "shim that finds existing projects/{old_hash}.db files."
        )
    # Edge case: PurePosixPath("") normalises to "." (current dir), so the
    # hash is sha1(b".") — NOT sha1(b""), because Path discards the empty
    # string.  This vector confirms the canonical-string contract: project_hash
    # operates on as_posix() output, not the raw constructor input.
    assert (
        project_hash(PurePosixPath(""))  # type: ignore[arg-type]
        == "3a52ce780950d4d969792a2559cd519d7ee8c727"
    )


def test_root_hash_matches_project_hash_for_same_canonical_path():
    """``stats._root_hash`` and ``project_hash`` MUST agree on the same canonical
    posix string.  The stats module uses ``_root_hash`` for project roots that
    have no entry in the global ``projects`` table (so the projects.id JOIN
    cannot be used); a divergence between the two would silently double-count
    or orphan stats rows.  This test guards the invariant.
    """
    from pathlib import PurePosixPath

    from token_goat.stats import _root_hash

    for posix_path in ("c:/work/foo", "/home/u/repo", "c:/long/path/with/many/segments"):
        assert _root_hash(posix_path) == project_hash(
            PurePosixPath(posix_path)  # type: ignore[arg-type]
        )


def test_grep_pattern_hash_known_vectors_durable_format():
    """Lock down the SQL-primary-key format for ``global.db::grep_patterns``.

    The hash is the primary key for cross-session grep pattern dedup.  Changing
    it (e.g. switching to xxhash for speed) silently breaks every previously
    recorded grep pattern: the new code can never find the old rows, and the
    old rows become orphaned dead weight in global.db.

    Same migration-shim requirement applies as for project_hash: if this test
    ever needs to change, the commit MUST migrate existing rows.
    """
    from token_goat.session import _grep_pattern_hash

    # ASCII pattern.
    assert (
        _grep_pattern_hash("def foo")
        == "a56cfa66045cc9bb9983be19974153631bbce34a"
    )
    # Non-ASCII pattern — surrogateescape handling matters here, so a known
    # vector also confirms the encoding contract.
    assert (
        _grep_pattern_hash("café")
        == "f424452a9673918c6f09b0cdd35b20be8e6ae7d7"
    )
    # hints._cross_session_grep_hint computes the same hash inline; they MUST
    # match or the cross-session hint never fires.  Verify the contract.
    import hashlib

    inline = hashlib.sha1(
        "def foo".encode("utf-8", errors="replace")
    ).hexdigest()
    assert _grep_pattern_hash("def foo") == inline


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


# ---------------------------------------------------------------------------
# Cross-shell drive-letter prefix normalisation
#
# A project at C:\Projects\foo is accessed from multiple shells under different
# literal path strings:
#
#   cmd / PowerShell:     C:\Projects\foo  or  C:/Projects/foo
#   Git Bash (MSYS):      /c/Projects/foo
#   Cygwin:               /cygdrive/c/Projects/foo
#   WSL / Linux mount:    /mnt/c/Projects/foo
#
# All five must canonicalize to the same path so project_hash() yields one
# SHA1.  Without this, switching between PowerShell and Git Bash on the same
# project would fragment the index across multiple per-project DB files.
#
# These tests run on every platform because the normalisation is a pure
# string transform — no filesystem operations are needed.
# ---------------------------------------------------------------------------


from pathlib import Path  # noqa: E402  (imported locally to keep added block self-contained)

from token_goat.project import _normalize_shell_drive_prefix  # noqa: E402


def test_normalize_shell_prefix_wsl_mount():
    """/mnt/c/Projects/foo (WSL) -> c:/Projects/foo."""
    assert _normalize_shell_drive_prefix("/mnt/c/Projects/foo") == "c:/Projects/foo"


def test_normalize_shell_prefix_wsl_uppercase_drive():
    """/mnt/C/Projects/foo -> c:/Projects/foo (drive letter lowercased)."""
    assert _normalize_shell_drive_prefix("/mnt/C/Projects/foo") == "c:/Projects/foo"


def test_normalize_shell_prefix_cygwin():
    """/cygdrive/c/Projects/foo -> c:/Projects/foo."""
    assert _normalize_shell_drive_prefix("/cygdrive/c/Projects/foo") == "c:/Projects/foo"


def test_normalize_shell_prefix_msys_git_bash():
    """/c/Projects/foo (Git Bash MSYS) -> c:/Projects/foo."""
    assert _normalize_shell_drive_prefix("/c/Projects/foo") == "c:/Projects/foo"


def test_normalize_shell_prefix_alternate_drive_letter():
    """Drive letters other than 'c' are also handled."""
    assert _normalize_shell_drive_prefix("/mnt/d/Code/proj") == "d:/Code/proj"
    assert _normalize_shell_drive_prefix("/e/Code/proj") == "e:/Code/proj"
    assert _normalize_shell_drive_prefix("/cygdrive/z/Code/proj") == "z:/Code/proj"


def test_normalize_shell_prefix_leaves_posix_paths_alone():
    """Real POSIX paths (no drive-letter ambiguity) pass through unchanged."""
    assert _normalize_shell_drive_prefix("/usr/local/bin") == "/usr/local/bin"
    assert _normalize_shell_drive_prefix("/home/user/proj") == "/home/user/proj"
    assert _normalize_shell_drive_prefix("/var/log/app") == "/var/log/app"


def test_normalize_shell_prefix_leaves_already_canonical_alone():
    """A path that already has a c:/ prefix is left alone."""
    assert _normalize_shell_drive_prefix("c:/Projects/foo") == "c:/Projects/foo"
    assert _normalize_shell_drive_prefix("C:/Projects/foo") == "C:/Projects/foo"


def test_normalize_shell_prefix_handles_multi_segment_msys():
    """MSYS only strips the *first* single-letter segment, not later ones."""
    # /c/foo/d -> c:/foo/d  (drive letter is the leading single-letter segment)
    assert _normalize_shell_drive_prefix("/c/foo/d") == "c:/foo/d"


def test_normalize_shell_prefix_no_match_for_multi_letter_top_level():
    """A multi-letter top-level directory like /usr/ is not mistaken for a drive."""
    # /us/foo would only match if the regex were too greedy — verify it doesn't.
    assert _normalize_shell_drive_prefix("/us/foo") == "/us/foo"
    assert _normalize_shell_drive_prefix("/home/foo") == "/home/foo"


def test_normalize_shell_prefix_empty_and_root():
    """Edge cases: empty string and bare root pass through."""
    assert _normalize_shell_drive_prefix("") == ""
    assert _normalize_shell_drive_prefix("/") == "/"
    # /c/ with no trailing component still matches and yields c:/ — that's the
    # bare-drive form, which is fine.
    assert _normalize_shell_drive_prefix("/c/") == "c:/"


def test_canonicalize_cross_shell_paths_produce_same_hash():
    """All Windows-drive shell representations canonicalize to the same hash.

    This is the linchpin test for cross-platform consistency.  Without
    _normalize_shell_drive_prefix, the same project accessed from PowerShell,
    Git Bash, Cygwin, and WSL would produce four different SHA1 hashes and
    fragment the index into four separate per-project DB files.

    Windows-only: on POSIX ``Path.resolve()`` treats ``C:/Projects/foo`` as a
    relative path against ``cwd`` and the drive-letter lowercase rule never
    fires, so the assertion would test against synthesised POSIX paths rather
    than the intended Windows canonicalisation invariant.
    """
    if sys.platform != "win32":
        pytest.skip("Windows-only: cross-shell drive normalisation only matters on Windows")
    forms = [
        "C:/Projects/foo",
        "c:/Projects/foo",
        "/c/Projects/foo",
        "/mnt/c/Projects/foo",
        "/cygdrive/c/Projects/foo",
    ]
    hashes = {project_hash(canonicalize(Path(f))) for f in forms}
    assert len(hashes) == 1, (
        f"Expected one hash across all shell forms, got {len(hashes)}: {hashes}"
    )


def test_canonicalize_backslash_and_forward_slash_match_on_windows():
    """C:\\Projects\\foo and C:/Projects/foo canonicalize identically."""
    a = canonicalize(Path("C:/Projects/foo"))
    b = canonicalize(Path("C:\\Projects\\foo"))
    # On non-Windows, Path("C:\\Projects\\foo") is a literal POSIX filename
    # (backslashes are not separators), so the two will not match. Skip there.
    if sys.platform != "win32":
        pytest.skip("Backslash is not a separator on non-Windows")
    assert a == b


def test_canonicalize_drive_case_collapsed():
    """C:/foo and c:/foo canonicalize identically (drive letter lowercased).

    Windows-only: on POSIX ``Path("C:/Projects/foo").resolve()`` is treated as
    a relative path against ``cwd`` and becomes e.g. ``/home/x/C:/Projects/foo``,
    where the drive-letter lowercasing rule (``s[1] == ':'``) no longer applies.
    The canonicalization logic targets Windows shells specifically; running this
    assertion on POSIX would be testing a non-existent invariant.
    """
    if sys.platform != "win32":
        pytest.skip("Windows-only: drive-letter normalisation only fires on Windows paths")
    a = canonicalize(Path("C:/Projects/foo"))
    b = canonicalize(Path("c:/Projects/foo"))
    assert a == b
    assert project_hash(a) == project_hash(b)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: pre-resolve MSYS conversion")
def test_canonicalize_msys_path_on_windows_does_not_double_drive():
    """On Windows, /c/Projects/foo must NOT resolve to C:\\c\\Projects\\foo.

    Path.resolve() on Windows treats a leading slash as relative-to-current-drive,
    so /c/Projects/foo would naïvely become C:/c/Projects/foo (an extra "c"
    directory).  The pre-resolve normalisation step converts /c/... to c:/...
    *before* resolve sees it, avoiding the double-drive trap.
    """
    c = canonicalize(Path("/c/Projects/foo"))
    s = c.as_posix()
    # Must be exactly c:/Projects/foo, never c:/c/Projects/foo.
    assert s == "c:/Projects/foo", f"MSYS path mis-resolved on Windows: {s}"


def test_canonicalize_real_tmp_path_idempotent_after_normalization(tmp_path):
    """Round-tripping a real directory through canonicalize is idempotent
    even after the new shell-prefix step."""
    a = canonicalize(tmp_path)
    b = canonicalize(a)
    c = canonicalize(b)
    assert a == b == c
    assert project_hash(a) == project_hash(b) == project_hash(c)


def test_project_hash_stable_across_shell_forms_on_real_dir(tmp_path):
    """A real directory hashed via its native Path equals the hash from the
    canonicalize() output — i.e. the hash is stable through one extra
    normalisation pass."""
    h_direct = project_hash(canonicalize(tmp_path))
    h_via_str = project_hash(canonicalize(Path(str(tmp_path))))
    assert h_direct == h_via_str
