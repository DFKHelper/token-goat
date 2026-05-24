"""Dispatch and golden-output tests for token_goat.bash_compress.

Covers:
- Filter dispatch table: every registered filter class routes correctly.
- Golden-output per filter: real representative output goes in; signal
  survives, noise is stripped, savings ratio >= 20%.
- No-match pass-through: unrecognised commands are returned verbatim.
- Filter precedence: compound / overlapping commands resolve to the expected
  winner and the decision is documented.
"""
from __future__ import annotations

import pytest

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply(filter_: bc.Filter, stdout: str = "", stderr: str = "", exit_code: int = 0) -> str:
    """Run *filter_.apply()* with a synthetic argv and return the compressed text."""
    argv = [filter_.name]
    result = filter_.apply(stdout, stderr, exit_code, argv)
    return result.text


def _savings_ratio(filter_: bc.Filter, stdout: str, stderr: str = "") -> float:
    """Return the byte-savings fraction (0.0–1.0) for the given input."""
    result = filter_.apply(stdout, stderr, 0, [filter_.name])
    return result.percent_saved / 100.0


# ---------------------------------------------------------------------------
# 1. Dispatch table: parametrized per-filter match assertions
# ---------------------------------------------------------------------------

# Each entry: (command_tokens, expected_filter_name)
_DISPATCH_CASES: list[tuple[list[str], str]] = [
    # ---- PytestFilter ----
    (["pytest", "tests/"], "pytest"),
    (["pytest", "-x", "-v", "tests/unit/"], "pytest"),
    # NOTE: py.test is in PytestFilter.binaries but Path('py.test').stem == 'py',
    # so the binary-stem match misses it.  This is a known limitation — the
    # filter relies on Path.stem which stops at the first dot.  Omit from the
    # dispatch table and document in test_py_dot_test_limitation below.
    (["python", "-m", "pytest", "tests/"], "pytest"),
    (["uv", "run", "pytest", "tests/"], "pytest"),
    # ---- JestFilter ----
    (["jest", "--watchAll=false"], "jest"),
    (["vitest", "run"], "jest"),
    (["mocha", "tests/*.spec.js"], "jest"),
    # ---- CargoFilter ----
    (["cargo", "build", "--release"], "cargo"),
    (["cargo", "test"], "cargo"),
    (["cargo", "check"], "cargo"),
    # ---- NodePackageFilter ----
    (["npm", "install"], "npm"),
    (["npm", "ci"], "npm"),
    (["pnpm", "install"], "npm"),
    (["yarn", "install"], "npm"),
    (["bun", "install"], "npm"),
    # ---- DockerFilter ----
    (["docker", "build", "-t", "my-image", "."], "docker"),
    (["docker", "run", "--rm", "alpine"], "docker"),
    (["podman", "build", "."], "docker"),
    # ---- KubectlFilter ----
    (["kubectl", "get", "pods"], "kubectl"),
    (["kubectl", "logs", "my-pod"], "kubectl"),
    (["helm", "install", "my-release", "chart/"], "kubectl"),
    # ---- AwsFilter ----
    (["aws", "s3", "ls"], "aws"),
    (["aws", "ec2", "describe-instances"], "aws"),
    # ---- RuffFilter ----
    (["ruff", "check", "src/"], "ruff"),
    (["ruff", "check", "."], "ruff"),
    # ---- MypyFilter ----
    (["mypy", "src/"], "mypy"),
    (["dmypy", "run", "--", "src/"], "mypy"),
    # ---- LinterFilter ----
    (["eslint", "src/", "--ext", ".ts"], "linter"),
    (["pylint", "src/"], "linter"),
    (["pyright", "src/"], "linter"),
    (["tsc", "--noEmit"], "linter"),
    # ---- GrepFilter ----
    (["grep", "-r", "pattern", "src/"], "grep"),
    (["rg", "pattern", "src/"], "grep"),
    (["ag", "pattern"], "grep"),
    # ---- GitFilter ----
    (["git", "status"], "git"),
    (["git", "log", "--oneline"], "git"),
    (["git", "diff", "HEAD"], "git"),
    (["git", "push", "origin", "main"], "git"),
    # ---- MakeFilter ----
    (["make", "all"], "make"),
    (["ninja", "-C", "build/"], "make"),
    (["go", "build", "./..."], "make"),
    (["gradle", "build"], "make"),
    # ---- TerraformFilter ----
    (["terraform", "plan"], "terraform"),
    (["terraform", "apply", "-auto-approve"], "terraform"),
    (["tofu", "plan"], "terraform"),
    # ---- PipFilter ----
    (["pip", "install", "requests"], "pip"),
    (["pip3", "install", "-r", "requirements.txt"], "pip"),
    # ---- UvFilter ----
    (["uv", "sync"], "uv"),
    (["uv", "add", "requests"], "uv"),
    # NOTE: 'uv pip install' is NOT routed to UvFilter by select_filter because
    # _strip_prefixes treats 'uv pip' as a two-token launcher, stripping both
    # tokens and leaving ['install', 'mypackage'] which has no filter.
    # UvFilter.matches() *would* match if called on the raw argv, but
    # select_filter calls matches() on the *stripped* argv.
    # This is documented in test_uv_pip_stripped_by_prefix_stripping below.
    # ---- PythonFilter ----
    (["python", "script.py"], "python"),
    (["python3", "-c", "print('hello')"], "python"),
]


@pytest.mark.parametrize("argv,expected_name", _DISPATCH_CASES)
def test_dispatch_matches(argv: list[str], expected_name: str) -> None:
    """select_filter routes each command to the expected filter."""
    result = bc.select_filter(argv)
    assert result is not None, f"select_filter({argv!r}) returned None; expected {expected_name!r}"
    assert result.name == expected_name, (
        f"select_filter({argv!r}) -> {result.name!r}; expected {expected_name!r}"
    )


# ---------------------------------------------------------------------------
# 2. No-match pass-through
# ---------------------------------------------------------------------------

_NO_MATCH_COMMANDS: list[list[str]] = [
    ["ls", "-la"],
    ["cat", "file.txt"],
    ["curl", "-s", "https://example.com"],
    ["ssh", "user@host"],
    ["custom-build-tool", "--all"],
    ["echo", "hello"],
    ["find", ".", "-name", "*.py"],
]


@pytest.mark.parametrize("argv", _NO_MATCH_COMMANDS)
def test_no_match_returns_none(argv: list[str]) -> None:
    """Commands with no matching filter return None from select_filter."""
    assert bc.select_filter(argv) is None


def test_no_match_output_verbatim() -> None:
    """When no filter matches, the caller gets raw output back.

    In practice the hook layer won't wrap such a command at all (select_filter
    returns None), but we verify that calling compress_output with the Generic
    filter still preserves signal when no structural noise is present.
    """
    stdout = "special-tool: v1.2.3 installed successfully\nDone."
    stderr = ""
    # No filter → caller passes through unchanged; verify select_filter is None.
    assert bc.select_filter(["special-tool"]) is None
    # Directly using GenericFilter should preserve all signal content.
    gf = bc.GenericFilter()
    result = gf.apply(stdout, stderr, 0, ["special-tool"])
    assert "special-tool: v1.2.3 installed successfully" in result.text
    assert "Done." in result.text


# ---------------------------------------------------------------------------
# 3. Filter precedence documentation
# ---------------------------------------------------------------------------


def test_pytest_beats_python() -> None:
    """'python -m pytest tests/' → PytestFilter, not PythonFilter.

    PytestFilter is registered before PythonFilter and PythonFilter.matches()
    explicitly returns False when argv includes 'pytest' as a positional after
    prefix-stripping.
    """
    argv = ["python", "-m", "pytest", "tests/"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "pytest", (
        "python -m pytest should route to PytestFilter, not PythonFilter; "
        "PytestFilter precedes PythonFilter in FILTERS and PythonFilter.matches() "
        "explicitly excludes this case."
    )


def test_ruff_beats_linter() -> None:
    """'ruff check src/' → RuffFilter, not LinterFilter.

    RuffFilter is registered before LinterFilter and ruff is not in
    LinterFilter.binaries, so this is straightforward.  If the order were ever
    swapped or ruff added to LinterFilter.binaries the test documents intent.
    """
    argv = ["ruff", "check", "src/"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "ruff"


def test_git_grep_routes_to_grep() -> None:
    """'git grep pattern' → GrepFilter (not GitFilter).

    GrepFilter.matches() has a special case for 'git grep'.  GrepFilter is
    registered *before* GitFilter in FILTERS, so it wins when the subcommand
    is 'grep'.
    """
    argv = ["git", "grep", "TODO"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "grep", (
        "git grep should route to GrepFilter (registered before GitFilter)"
    )


def test_git_status_routes_to_git() -> None:
    """'git status' → GitFilter (not GrepFilter)."""
    argv = ["git", "status"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "git"


def test_py_dot_test_limitation() -> None:
    """Document known limitation: 'py.test' binary is NOT dispatched to PytestFilter.

    BUG (bash_compress.py line 676): Filter.matches() uses Path(argv[0]).stem
    which stops at the first dot.  Path('py.test').stem == 'py', not 'py.test',
    so 'py.test' in PytestFilter.binaries never matches even though the entry
    exists.  Workaround: invoke as 'pytest' instead.

    This test documents the current (broken) behavior so any fix is visible.
    """
    # 'py.test' currently returns None (no filter dispatched).
    result = bc.select_filter(["py.test", "tests/"])
    assert result is None, (
        "If this assertion fails, py.test dispatch has been fixed — "
        "update this test to assert result.name == 'pytest'."
    )


def test_uv_pip_stripped_by_prefix_stripping() -> None:
    """Document known gap: 'uv pip install pkg' is NOT routed to UvFilter.

    _strip_prefixes treats 'uv' as a two-token prefix and 'pip' as its
    dispatch keyword, consuming both and leaving ['install', 'mypackage'].
    No filter matches 'install', so select_filter returns None.

    This means 'uv pip install' output is NOT compressed.
    UvFilter.matches() correctly returns True when given the raw argv, but
    select_filter calls matches() on the *stripped* argv.
    """
    # Current behavior: no filter dispatched.
    result = bc.select_filter(["uv", "pip", "install", "mypackage"])
    assert result is None, (
        "If this assertion fails, 'uv pip install' dispatch has been fixed — "
        "update this test to assert result.name == 'uv'."
    )


def test_uv_run_pytest_routes_to_pytest() -> None:
    """'uv run pytest tests/' strips the 'uv run' prefix and routes to PytestFilter."""
    argv = ["uv", "run", "pytest", "tests/"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "pytest"


def test_uv_sync_routes_to_uv_not_generic() -> None:
    """'uv sync' → UvFilter, not GenericFilter or PipFilter."""
    argv = ["uv", "sync"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "uv"


def test_uv_run_go_routes_to_make() -> None:
    """'uv run go build ./...' strips 'uv run', leaving 'go build', → MakeFilter."""
    argv = ["uv", "run", "go", "build", "./..."]
    f = bc.select_filter(argv)
    # 'uv run' is a two-token prefix, stripping leaves ['go', 'build', './...']
    # MakeFilter covers 'go'.
    assert f is not None
    assert f.name == "make"


# ---------------------------------------------------------------------------
# 4. Golden-output tests — per filter
# ---------------------------------------------------------------------------

# --- PytestFilter -----------------------------------------------------------

_PYTEST_PASSING_OUTPUT = """\
============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-7.4.0
rootdir: /src
plugins: cov-4.1.0, xdist-3.3.1
collected 150 items

...............F..............................................s................ [ 52%]
.................................................................[100%]

=================================== FAILURES ===================================
_______________ test_login_with_bad_password _______________

    def test_login_with_bad_password():
>       assert login("user", "wrong") is False
E       AssertionError: assert None is False

tests/test_auth.py:42: AssertionError
=========================== short test summary info ============================
FAILED tests/test_auth.py::test_login_with_bad_password
========================= 1 failed, 149 passed in 2.54s ========================
"""


class TestPytestFilter:
    def test_failure_block_preserved(self) -> None:
        f = bc.PytestFilter()
        out = _apply(f, _PYTEST_PASSING_OUTPUT)
        assert "AssertionError: assert None is False" in out
        assert "test_login_with_bad_password" in out

    def test_summary_preserved(self) -> None:
        f = bc.PytestFilter()
        out = _apply(f, _PYTEST_PASSING_OUTPUT)
        assert "1 failed" in out
        assert "149 passed" in out

    def test_dots_progress_stripped(self) -> None:
        f = bc.PytestFilter()
        out = _apply(f, _PYTEST_PASSING_OUTPUT)
        # The dots line should not appear verbatim.
        assert "[ 52%]" not in out

    def test_savings_ratio(self) -> None:
        f = bc.PytestFilter()
        # Build a large all-passing output with many dots lines to ensure savings.
        dots = "." * 80 + " [ 50%]\n"
        big_output = (
            "============================= test session starts ==============================\n"
            "collected 500 items\n\n"
            + (dots * 50)
            + "\n========================= 500 passed in 10.00s ========================\n"
        )
        ratio = _savings_ratio(f, big_output)
        assert ratio >= 0.20, f"PytestFilter savings {ratio:.0%} < 20%"

    def test_verbose_passed_lines_collapsed(self) -> None:
        verbose = (
            "============================= test session starts ==============================\n"
            "collected 5 items\n\n"
            "PASSED tests/test_a.py::test_one\n"
            "PASSED tests/test_a.py::test_two\n"
            "PASSED tests/test_a.py::test_three\n"
            "========================= 3 passed in 0.10s ========================\n"
        )
        f = bc.PytestFilter()
        out = _apply(f, verbose)
        # PASSED lines individually stripped; summary preserved.
        assert "3 passed" in out
        # Collapsed marker present.
        assert "collapsed 3 PASSED" in out

    def test_empty_input_no_crash(self) -> None:
        f = bc.PytestFilter()
        out = _apply(f, "", "")
        assert out == "" or out.strip() == ""


# --- JestFilter -------------------------------------------------------------

_JEST_OUTPUT = """\
PASS src/components/Button.test.tsx
PASS src/utils/format.test.ts
FAIL src/api/auth.test.ts
  ● AuthService › login › should reject bad password

    expect(received).toBe(expected)

    Expected: false
    Received: null

      40 |   it('should reject bad password', async () => {
    > 41 |     expect(await service.login('user', 'wrong')).toBe(false);
         |                                                  ^
      42 |   });

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 8 passed, 9 total
Snapshots:   0 total
Time:        3.241 s
Ran all test suites.
"""


class TestJestFilter:
    def test_fail_block_preserved(self) -> None:
        f = bc.JestFilter()
        out = _apply(f, _JEST_OUTPUT)
        assert "Expected: false" in out
        assert "Received: null" in out

    def test_pass_lines_collapsed(self) -> None:
        f = bc.JestFilter()
        out = _apply(f, _JEST_OUTPUT)
        assert "PASS src/components/Button.test.tsx" not in out
        assert "collapsed 2 PASS files" in out

    def test_summary_preserved(self) -> None:
        f = bc.JestFilter()
        out = _apply(f, _JEST_OUTPUT)
        assert "Test Suites:" in out
        assert "1 failed" in out

    def test_savings_ratio(self) -> None:
        f = bc.JestFilter()
        big = "\n".join([f"PASS src/module{i}/test.spec.ts" for i in range(200)])
        big += "\n\nTest Suites: 200 passed, 200 total\nTests: 400 passed, 400 total\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"JestFilter savings {ratio:.0%} < 20%"


# --- CargoFilter ------------------------------------------------------------

_CARGO_OUTPUT_STDERR = """\
   Compiling proc-macro2 v1.0.79
   Compiling quote v1.0.35
   Compiling unicode-ident v1.0.12
   Compiling syn v2.0.60
   Compiling serde_derive v1.0.197
   Compiling serde v1.0.197
   Compiling thiserror-impl v1.0.58
   Compiling thiserror v1.0.58
   Compiling my-project v0.1.0 (/src)
error[E0308]: mismatched types
 --> src/main.rs:10:5
  |
10 |     "not a number"
  |     ^^^^^^^^^^^^^^ expected `i32`, found `&str`

error: aborting due to previous error
"""


class TestCargoFilter:
    def test_error_preserved(self) -> None:
        f = bc.CargoFilter()
        out = _apply(f, stdout="", stderr=_CARGO_OUTPUT_STDERR)
        assert "mismatched types" in out
        assert "expected `i32`, found `&str`" in out

    def test_compiling_lines_collapsed(self) -> None:
        f = bc.CargoFilter()
        out = _apply(f, stdout="", stderr=_CARGO_OUTPUT_STDERR)
        # 9 Compiling lines → collapsed summary should appear.
        assert "Compiling" in out  # first two are kept
        assert "collapsed" in out  # marker for the collapsed ones

    def test_savings_ratio(self) -> None:
        f = bc.CargoFilter()
        big_stderr = "\n".join(
            [f"   Compiling crate{i} v1.0.{i}" for i in range(100)]
        ) + "\n   Finished dev [unoptimized] target(s) in 30s\n"
        ratio = _savings_ratio(f, stdout="", stderr=big_stderr)
        assert ratio >= 0.20, f"CargoFilter savings {ratio:.0%} < 20%"


# --- NodePackageFilter ------------------------------------------------------

_NPM_OUTPUT = """\
npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm warn deprecated @humanwhocodes/config-array@0.11.14: Use @eslint/config-array

added 247 packages, and audited 248 packages in 12s

34 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
"""


class TestNodePackageFilter:
    def test_summary_preserved(self) -> None:
        f = bc.NodePackageFilter()
        out = _apply(f, _NPM_OUTPUT)
        assert "added 247 packages" in out

    def test_deprecation_warnings_collapsed(self) -> None:
        f = bc.NodePackageFilter()
        out = _apply(f, _NPM_OUTPUT)
        # Individual deprecation lines should be replaced with the summary.
        assert "collapsed 4 deprecation" in out

    def test_savings_ratio(self) -> None:
        f = bc.NodePackageFilter()
        big = "\n".join(
            [f"npm warn deprecated package{i}@1.0.{i}: outdated" for i in range(100)]
        ) + "\nadded 300 packages in 30s\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"NodePackageFilter savings {ratio:.0%} < 20%"

    def test_npm_err_block_preserved(self) -> None:
        stderr = "npm ERR! code ENOTFOUND\nnpm ERR! network request failed\n"
        f = bc.NodePackageFilter()
        out = _apply(f, stdout="", stderr=stderr)
        assert "ENOTFOUND" in out


# --- DockerFilter -----------------------------------------------------------

_DOCKER_STDERR = """\
#1 [internal] load build definition from Dockerfile
#1 sha256:abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890
#1 transferring dockerfile: 1.2kB 0.0s done
#1 DONE 0.1s

#2 [internal] load .dockerignore
#2 sha256:deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12
#2 transferring context: 35B done
#2 DONE 0.0s

#3 [1/3] FROM python:3.12-slim
#3 0.3s
#3 1.2MB / 50.0MB 0.5s
#3 50.0MB / 50.0MB 2.1s
#3 DONE 2.5s

#4 [2/3] RUN pip install --no-cache-dir requests
#4 2.3 Successfully installed requests-2.31
#4 DONE 5.2s

#5 exporting to image
#5 exporting layers done
#5 writing image sha256:f00cafe1234 done
"""


class TestDockerFilter:
    def test_successful_build_image_line_preserved(self) -> None:
        f = bc.DockerFilter()
        out = _apply(f, stdout="", stderr=_DOCKER_STDERR)
        assert "writing image sha256:f00cafe1234 done" in out

    def test_digest_lines_dropped(self) -> None:
        f = bc.DockerFilter()
        out = _apply(f, stdout="", stderr=_DOCKER_STDERR)
        assert "sha256:abcd1234ef567890" not in out

    def test_transfer_progress_dropped(self) -> None:
        f = bc.DockerFilter()
        out = _apply(f, stdout="", stderr=_DOCKER_STDERR)
        assert "50.0MB / 50.0MB" not in out

    def test_savings_ratio(self) -> None:
        f = bc.DockerFilter()
        big = ""
        for i in range(1, 50):
            big += f"#{i} [internal] load something\n"
            big += f"#{i} sha256:{'a' * 63}\n"
            big += f"#{i} {i}.0MB / 100.0MB 1.0s\n"
            big += f"#{i} DONE {i}.0s\n\n"
        ratio = _savings_ratio(f, stdout="", stderr=big)
        assert ratio >= 0.20, f"DockerFilter savings {ratio:.0%} < 20%"


# --- GrepFilter -------------------------------------------------------------

_GREP_OUTPUT = "\n".join(
    [f"src/module_{i//5}.py:{i}:    result = process_item(i)" for i in range(1, 101)]
) + "\n"


class TestGrepFilter:
    def test_small_output_passes_through(self) -> None:
        """Output <= 30 non-empty lines is returned verbatim."""
        f = bc.GrepFilter()
        small = "\n".join(f"src/file.py:{i}: match" for i in range(10))
        out = _apply(f, small)
        # All 10 lines should be present.
        for i in range(10):
            assert f"src/file.py:{i}: match" in out

    def test_large_output_gets_summary(self) -> None:
        f = bc.GrepFilter()
        out = _apply(f, _GREP_OUTPUT)
        assert "grep:" in out
        assert "matches across" in out

    def test_summary_includes_file_counts(self) -> None:
        f = bc.GrepFilter()
        out = _apply(f, _GREP_OUTPUT)
        # Should show per-file match counts.
        assert "match(es)" in out

    def test_savings_ratio(self) -> None:
        f = bc.GrepFilter()
        ratio = _savings_ratio(f, _GREP_OUTPUT)
        assert ratio >= 0.20, f"GrepFilter savings {ratio:.0%} < 20%"

    def test_git_grep_argv_matches(self) -> None:
        """GrepFilter.matches() accepts ['git', 'grep', 'pattern'] after prefix stripping."""
        f = bc.GrepFilter()
        assert f.matches(["git", "grep", "TODO"])
        assert not f.matches(["git", "status"])


# --- RuffFilter -------------------------------------------------------------

_RUFF_OUTPUT = """\
src/module_a.py:10:80: E501 Line too long (82 > 79 characters)
src/module_b.py:15:80: E501 Line too long (95 > 79 characters)
src/module_c.py:22:80: E501 Line too long (88 > 79 characters)
src/module_a.py:5:1: F401 `os` imported but unused
src/module_b.py:3:1: F401 `sys` imported but unused
src/module_a.py:8:1: F401 `re` imported but unused
src/module_c.py:2:1: F401 `typing.List` imported but unused
src/module_d.py:100:5: E711 Comparison to `None` (use `is` or `is not`)
Found 8 errors.
"""


class TestRuffFilter:
    def test_footer_preserved(self) -> None:
        f = bc.RuffFilter()
        out = _apply(f, _RUFF_OUTPUT)
        assert "Found 8 errors." in out

    def test_high_frequency_rule_summarised(self) -> None:
        """E501 fires 3 times across 3 files → should be summarised."""
        f = bc.RuffFilter()
        out = _apply(f, _RUFF_OUTPUT)
        assert "E501: 3 occurrences in 3 files" in out

    def test_low_frequency_rule_kept_verbatim(self) -> None:
        """E711 fires only once → kept verbatim, not summarised."""
        f = bc.RuffFilter()
        out = _apply(f, _RUFF_OUTPUT)
        assert "E711" in out
        assert "Comparison to `None`" in out

    def test_savings_ratio(self) -> None:
        f = bc.RuffFilter()
        big = ""
        for i in range(1, 101):
            big += f"src/file_{i % 5}.py:{i}:80: E501 Line too long ({80 + i} > 79)\n"
        big += "Found 100 errors.\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"RuffFilter savings {ratio:.0%} < 20%"


# --- MypyFilter -------------------------------------------------------------

_MYPY_OUTPUT = """\
src/auth.py:10: error: Incompatible return value type (got "None", expected "str")
src/auth.py:25: error: Incompatible return value type (got "None", expected "str")
src/auth.py:40: error: Incompatible return value type (got "None", expected "str")
src/auth.py:55: error: Incompatible return value type (got "None", expected "str")
src/models.py:5: error: Name "User" is not defined
src/models.py:10: note: See https://mypy.readthedocs.io/en/stable/error_codes.html
src/utils.py:3: error: Module "missing_mod" has no attribute "helper"
Found 6 errors in 3 files (checked 5 source files)
"""


class TestMypyFilter:
    def test_summary_preserved(self) -> None:
        f = bc.MypyFilter()
        out = _apply(f, _MYPY_OUTPUT)
        assert "Found 6 errors in 3 files" in out

    def test_duplicate_error_messages_collapsed(self) -> None:
        """The repeated 'Incompatible return value' error should be deduped."""
        f = bc.MypyFilter()
        out = _apply(f, _MYPY_OUTPUT)
        assert "suppressed" in out or "duplicate" in out

    def test_see_https_note_dropped(self) -> None:
        f = bc.MypyFilter()
        out = _apply(f, _MYPY_OUTPUT)
        assert "mypy.readthedocs.io" not in out

    def test_unique_errors_preserved(self) -> None:
        f = bc.MypyFilter()
        out = _apply(f, _MYPY_OUTPUT)
        assert 'Module "missing_mod"' in out
        assert 'Name "User" is not defined' in out

    def test_savings_ratio(self) -> None:
        f = bc.MypyFilter()
        big = ""
        for i in range(1, 201):
            big += f'src/file_{i % 10}.py:{i}: error: Incompatible return value type (got "None", expected "str")\n'
        big += "Found 200 errors in 10 files\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"MypyFilter savings {ratio:.0%} < 20%"


# --- GitFilter --------------------------------------------------------------

_GIT_STATUS_OUTPUT = """\
On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
\t(use "git restore --staged <file>..." to unstage)
\tmodified:   src/auth.py
\tnew file:   src/oauth.py

Changes not staged for commit:
\t(use "git add <file>..." to update what will be committed)
"""

_GIT_LOG_OUTPUT = "\n".join(
    [
        f"commit {'a' * 40}\nAuthor: Dev <dev@example.com>\nDate: Mon Jan {i:02d} 00:00:00 2024\n\n    Commit message {i}\n"
        for i in range(1, 16)
    ]
)


class TestGitFilter:
    def test_status_headers_preserved(self) -> None:
        f = bc.GitFilter()
        out = f.compress(
            _GIT_STATUS_OUTPUT, "", 0, ["git", "status"]
        )
        assert "Changes to be committed" in out
        assert "Changes not staged for commit" in out

    def test_status_file_list_preserved(self) -> None:
        f = bc.GitFilter()
        out = f.compress(_GIT_STATUS_OUTPUT, "", 0, ["git", "status"])
        assert "src/auth.py" in out
        assert "src/oauth.py" in out

    def test_long_log_collapses_older_commits(self) -> None:
        """git log with >10 commits should collapse older entries."""
        f = bc.GitFilter()
        out = f.compress(_GIT_LOG_OUTPUT, "", 0, ["git", "log"])
        assert "elided" in out or "earlier commits" in out

    def test_diff_hunk_limit(self) -> None:
        """git diff with many hunks per file should truncate."""
        hunk_template = "@@ -{n},10 +{n},10 @@\n" + ("-old line {n}\n" * 5) + ("+new line {n}\n" * 5)
        diff = "diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n"
        diff += "".join(hunk_template.format(n=i * 10) for i in range(10))
        f = bc.GitFilter()
        out = f.compress(diff, "", 0, ["git", "diff"])
        assert "more hunks" in out

    def test_push_drops_remote_counting(self) -> None:
        stderr = (
            "remote: Counting objects: 5, done.\n"
            "remote: Compressing objects: 100% (3/3), done.\n"
            "remote: Total 5 (delta 1), reused 0 (delta 0)\n"
            "To github.com:user/repo.git\n"
            "   abc1234..def5678  main -> main\n"
        )
        f = bc.GitFilter()
        out = f.compress("", stderr, 0, ["git", "push"])
        # ref-update line must survive.
        assert "main -> main" in out
        # Remote counting lines should be dropped.
        assert "Counting objects" not in out


# --- MakeFilter -------------------------------------------------------------

_MAKE_OUTPUT_STDERR = """\
make[1]: Entering directory '/src/build'
cc -O2 -Wall -c src/main.c -o build/main.o
cc -O2 -Wall -c src/utils.c -o build/utils.o
src/utils.c:42:5: warning: implicit declaration of function 'helper' [-Wimplicit-function-declaration]
cc -O2 -Wall -c src/extra.c -o build/extra.o
gcc build/main.o build/utils.o build/extra.o -o myprogram
make[1]: Leaving directory '/src/build'
"""


class TestMakeFilter:
    def test_warning_preserved(self) -> None:
        f = bc.MakeFilter()
        out = _apply(f, stdout="", stderr=_MAKE_OUTPUT_STDERR)
        assert "implicit declaration" in out

    def test_recurse_lines_dropped(self) -> None:
        f = bc.MakeFilter()
        out = _apply(f, stdout="", stderr=_MAKE_OUTPUT_STDERR)
        # The raw "Entering/Leaving directory" lines should not appear verbatim.
        # The filter replaces them with a summary marker that mentions the words
        # "Entering/Leaving directory" in a count line, which is acceptable.
        # Verify the original lines are gone (not verbatim match).
        assert "make[1]: Entering directory" not in out
        assert "make[1]: Leaving directory" not in out

    def test_compiler_echoes_dropped(self) -> None:
        f = bc.MakeFilter()
        out = _apply(f, stdout="", stderr=_MAKE_OUTPUT_STDERR)
        # 'cc' lines without warnings/errors should be dropped.
        assert "cc -O2 -Wall -c src/main.c" not in out

    def test_savings_ratio(self) -> None:
        f = bc.MakeFilter()
        big = ""
        for i in range(50):
            big += f"make[1]: Entering directory '/src/sub{i}'\n"
            big += f"cc -O2 -Wall -c src/file{i}.c -o build/file{i}.o\n"
            big += f"make[1]: Leaving directory '/src/sub{i}'\n"
        ratio = _savings_ratio(f, stdout="", stderr=big)
        assert ratio >= 0.20, f"MakeFilter savings {ratio:.0%} < 20%"


# --- TerraformFilter --------------------------------------------------------

_TF_OUTPUT = """\
aws_s3_bucket.main: Refreshing state... [id=my-bucket]
aws_iam_role.lambda: Refreshing state... [id=my-lambda-role]
aws_lambda_function.api: Refreshing state... [id=my-api]
aws_cloudfront_distribution.cdn: Reading...
aws_cloudfront_distribution.cdn: Read complete after 1s [id=ABCDEFGHIJK]

Terraform used the selected providers to generate the following execution plan.

Plan: 2 to add, 1 to change, 0 to destroy.

  # aws_s3_bucket.logs will be created
  + resource "aws_s3_bucket" "logs" {
      + bucket = "my-logs-bucket"
    }

Apply complete! Resources: 2 added, 1 changed, 0 destroyed.
"""


class TestTerraformFilter:
    def test_plan_line_preserved(self) -> None:
        f = bc.TerraformFilter()
        out = _apply(f, _TF_OUTPUT)
        assert "Plan: 2 to add" in out

    def test_apply_complete_preserved(self) -> None:
        f = bc.TerraformFilter()
        out = _apply(f, _TF_OUTPUT)
        assert "Apply complete!" in out

    def test_refresh_lines_dropped(self) -> None:
        f = bc.TerraformFilter()
        out = _apply(f, _TF_OUTPUT)
        assert "Refreshing state" not in out
        assert "Read complete" not in out

    def test_savings_ratio(self) -> None:
        f = bc.TerraformFilter()
        big = "\n".join(
            [f"aws_resource_{i}.item: Refreshing state... [id=resource-{i}]" for i in range(100)]
        ) + "\nPlan: 0 to add, 0 to change, 0 to destroy.\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"TerraformFilter savings {ratio:.0%} < 20%"


# --- PipFilter --------------------------------------------------------------

_PIP_OUTPUT = """\
Collecting requests
  Downloading requests-2.31.0-py3-none-any.whl (62 kB)
Collecting charset-normalizer<4,>=2
  Downloading charset_normalizer-3.3.2-cp312-cp312-linux_x86_64.whl (507 kB)
Collecting idna<4,>=2.5
  Downloading idna-3.7-py3-none-any.whl (66 kB)
Collecting urllib3<3,>=1.21.1
  Downloading urllib3-2.2.1-py3-none-any.whl (54 kB)
Collecting certifi>=2017.4.17
  Downloading certifi-2024.2.2-py3-none-any.whl (163 kB)
Installing collected packages: certifi, idna, urllib3, charset-normalizer, requests
Successfully installed certifi-2024.2.2 charset-normalizer-3.3.2 idna-3.7 requests-2.31.0 urllib3-2.2.1
"""


class TestPipFilter:
    def test_success_line_preserved(self) -> None:
        f = bc.PipFilter()
        out = _apply(f, _PIP_OUTPUT)
        assert "Successfully installed" in out

    def test_downloading_lines_dropped(self) -> None:
        f = bc.PipFilter()
        out = _apply(f, _PIP_OUTPUT)
        assert "Downloading requests-2.31.0" not in out

    def test_collecting_lines_limited(self) -> None:
        f = bc.PipFilter()
        out = _apply(f, _PIP_OUTPUT)
        # Only first 5 'Collecting' lines kept; there are exactly 5 so all kept.
        assert "Collecting requests" in out

    def test_savings_ratio(self) -> None:
        f = bc.PipFilter()
        big = ""
        for i in range(50):
            big += f"Collecting package{i}\n"
            big += f"  Downloading package{i}-1.0.whl (100 kB)\n"
        big += "Installing collected packages: " + " ".join(f"package{i}" for i in range(50)) + "\n"
        big += "Successfully installed all packages\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"PipFilter savings {ratio:.0%} < 20%"


# --- UvFilter ---------------------------------------------------------------

_UV_OUTPUT = """\
Resolved 150 packages in 1.23s
   Downloading pydantic-2.6.4-cp312-cp312-linux_x86_64.whl (2.4 MB)
   Fetching pydantic-core-2.16.3-cp312-cp312-linux_x86_64.whl (2.1 MB)
   + pydantic==2.6.4
   + pydantic-core==2.16.3
   + annotated-types==0.6.0
Installed 3 packages in 0.89s
"""


class TestUvFilter:
    def test_resolved_and_installed_preserved(self) -> None:
        f = bc.UvFilter()
        out = _apply(f, _UV_OUTPUT)
        assert "Resolved 150 packages" in out
        assert "Installed 3 packages" in out

    def test_downloading_lines_dropped(self) -> None:
        f = bc.UvFilter()
        out = _apply(f, _UV_OUTPUT)
        assert "Downloading pydantic" not in out
        assert "Fetching pydantic-core" not in out

    def test_diff_lines_dropped(self) -> None:
        f = bc.UvFilter()
        out = _apply(f, _UV_OUTPUT)
        assert "+ pydantic==2.6.4" not in out
        assert "+ pydantic-core==2.16.3" not in out

    def test_savings_ratio(self) -> None:
        f = bc.UvFilter()
        big = "Resolved 300 packages in 2.5s\n"
        for i in range(100):
            big += f"   Downloading package{i}-1.0.whl (1.0 MB)\n"
            big += f"   + package{i}==1.0\n"
        big += "Installed 100 packages in 5.0s\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.20, f"UvFilter savings {ratio:.0%} < 20%"

    def test_uv_run_not_matched(self) -> None:
        """'uv run my_script.py' is NOT a package-management subcommand."""
        f = bc.UvFilter()
        assert not f.matches(["uv", "run", "my_script.py"])

    def test_uv_sync_matched(self) -> None:
        f = bc.UvFilter()
        assert f.matches(["uv", "sync"])

    def test_uv_add_matched(self) -> None:
        f = bc.UvFilter()
        assert f.matches(["uv", "add", "requests"])


# --- PythonFilter -----------------------------------------------------------

_PYTHON_TRACEBACK = """\
Running analysis...
Traceback (most recent call last):
  File "script.py", line 5, in <module>
    main()
  File "script.py", line 3, in main
    result = compute(None)
  File "script.py", line 10, in compute
    return value.strip()
AttributeError: 'NoneType' object has no attribute 'strip'
"""

_PYTHON_LONG_TRACEBACK = """\
Traceback (most recent call last):
""" + "".join(
    f'  File "frame{i}.py", line {i}, in func{i}\n    code_{i}()\n'
    for i in range(15)
) + "RuntimeError: deep error\n"


class TestPythonFilter:
    def test_error_line_preserved(self) -> None:
        f = bc.PythonFilter()
        out = _apply(f, stderr=_PYTHON_TRACEBACK)
        assert "AttributeError" in out
        assert "'NoneType' object has no attribute 'strip'" in out

    def test_innermost_frame_preserved(self) -> None:
        f = bc.PythonFilter()
        out = _apply(f, stderr=_PYTHON_TRACEBACK)
        # The innermost frame is the one in compute().
        assert "return value.strip()" in out

    def test_intermediate_frames_stripped(self) -> None:
        f = bc.PythonFilter()
        out = _apply(f, stderr=_PYTHON_TRACEBACK)
        # Middle frame (in main()) should be stripped for short tracebacks.
        assert "result = compute(None)" not in out

    def test_long_traceback_compressed(self) -> None:
        f = bc.PythonFilter()
        out = _apply(f, stderr=_PYTHON_LONG_TRACEBACK)
        # Error line must survive.
        assert "RuntimeError: deep error" in out
        # An omission marker must appear (>10 frames triggers compression).
        assert "frames omitted" in out

    def test_savings_ratio(self) -> None:
        f = bc.PythonFilter()
        ratio = _savings_ratio(f, stdout="", stderr=_PYTHON_LONG_TRACEBACK)
        assert ratio >= 0.20, f"PythonFilter savings {ratio:.0%} < 20%"

    def test_no_traceback_passes_through(self) -> None:
        """Plain output without tracebacks is not mangled."""
        stdout = "Result: 42\nDone in 0.01s\n"
        f = bc.PythonFilter()
        out = _apply(f, stderr=stdout)
        assert "Result: 42" in out

    def test_python_minus_m_pytest_not_matched(self) -> None:
        """PythonFilter explicitly excludes 'python -m pytest'."""
        f = bc.PythonFilter()
        # After prefix-stripping 'python -m pytest tests/' resolves to
        # ['pytest', 'tests/'] which hits PytestFilter first.  But also
        # verify that PythonFilter.matches() itself rejects the full argv.
        assert not f.matches(["python", "-m", "pytest", "tests/"])


# --- LinterFilter -----------------------------------------------------------

_ESLINT_OUTPUT = """\
/src/components/Button.tsx
  10:5   error    'React' must be in scope when using JSX  react/react-in-jsx-scope
  15:10  warning  'onClick' is missing in props validation  react/prop-types
  20:3   error    'React' must be in scope when using JSX  react/react-in-jsx-scope
  25:8   error    'React' must be in scope when using JSX  react/react-in-jsx-scope
  30:15  warning  'onClick' is missing in props validation  react/prop-types
  35:1   error    'React' must be in scope when using JSX  react/react-in-jsx-scope

/src/utils/format.ts
  5:1    error    'unused' is defined but never used  no-unused-vars

✖ 7 problems (5 errors, 2 warnings)
"""


class TestLinterFilter:
    def test_summary_line_preserved(self) -> None:
        f = bc.LinterFilter()
        out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"])
        assert "7 problems" in out

    def test_high_frequency_rule_collapsed(self) -> None:
        """react/react-in-jsx-scope fires 4 times → should be collapsed to 3 + marker."""
        f = bc.LinterFilter()
        out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"])
        # At most 3 occurrences kept, then +N marker.
        assert "+1 more react/react-in-jsx-scope violations" in out

    def test_unique_rule_preserved(self) -> None:
        f = bc.LinterFilter()
        out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"])
        assert "no-unused-vars" in out

    def test_savings_ratio(self) -> None:
        f = bc.LinterFilter()
        lines = ["/src/App.tsx"]
        for i in range(50):
            lines.append(f"  {i}:1  error  msg  react/react-in-jsx-scope")
        lines.append("\n✖ 50 problems")
        big = "\n".join(lines)
        out = f.compress(big, "", 0, ["eslint"])
        ratio = 1.0 - len(out.encode()) / max(1, len(big.encode()))
        assert ratio >= 0.20, f"LinterFilter savings {ratio:.0%} < 20%"


# --- KubectlFilter ----------------------------------------------------------

_KUBECTL_GET_OUTPUT = "NAME                          READY   STATUS    RESTARTS   AGE\n" + "\n".join(
    [f"pod-{i:04d}-abc123            1/1     Running   0          {i}d" for i in range(1, 51)]
) + "\n"


class TestKubectlFilter:
    def test_table_header_preserved(self) -> None:
        f = bc.KubectlFilter()
        out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"])
        assert "NAME" in out
        assert "STATUS" in out

    def test_long_table_truncated(self) -> None:
        f = bc.KubectlFilter()
        out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"])
        assert "more rows" in out

    def test_first_rows_kept(self) -> None:
        f = bc.KubectlFilter()
        out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"])
        assert "pod-0001" in out

    def test_savings_ratio(self) -> None:
        f = bc.KubectlFilter()
        result = f.apply(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.20, f"KubectlFilter savings {ratio:.0%} < 20%"


# ---------------------------------------------------------------------------
# 5. detect_from_command convenience wrapper
# ---------------------------------------------------------------------------


class TestDetectFromCommand:
    def test_simple_command_detected(self) -> None:
        result = bc.detect_from_command("pytest tests/")
        assert result is not None
        filter_, argv = result
        assert filter_.name == "pytest"

    def test_command_with_pipe_not_detected(self) -> None:
        """Commands with shell operators are intentionally skipped."""
        assert bc.detect_from_command("pytest tests/ | head -20") is None

    def test_command_with_redirect_not_detected(self) -> None:
        assert bc.detect_from_command("pytest tests/ > output.log") is None

    def test_empty_command_returns_none(self) -> None:
        assert bc.detect_from_command("") is None

    def test_unknown_command_returns_none(self) -> None:
        assert bc.detect_from_command("unknown-tool --flag") is None

    def test_prefix_stripped_correctly(self) -> None:
        result = bc.detect_from_command("sudo uv run pytest tests/")
        assert result is not None
        filter_, argv = result
        assert filter_.name == "pytest"


# ---------------------------------------------------------------------------
# 6. FILTERS registry completeness
# ---------------------------------------------------------------------------


def test_all_filter_names_unique() -> None:
    """Every filter in FILTERS must have a unique name."""
    names = [f.name for f in bc.FILTERS]
    assert len(names) == len(set(names)), f"Duplicate filter names: {names}"


def test_filter_by_name_round_trips() -> None:
    """filter_by_name(f.name) returns the same filter for every registered filter."""
    for f in bc.FILTERS:
        found = bc.filter_by_name(f.name)
        assert found is not None, f"filter_by_name({f.name!r}) returned None"
        assert found.name == f.name


def test_filters_list_covers_expected_tools() -> None:
    """Verify the expected set of tool names is covered by the registry."""
    names = {f.name for f in bc.FILTERS}
    expected = {
        "pytest", "jest", "cargo", "npm", "docker", "kubectl",
        "aws", "ruff", "mypy", "linter", "grep", "git",
        "make", "terraform", "pip", "uv", "python",
    }
    missing = expected - names
    assert not missing, f"Missing filters in FILTERS registry: {missing}"
