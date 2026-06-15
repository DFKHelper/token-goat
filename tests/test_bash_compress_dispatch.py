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
from filter_test_helpers import apply_filter as _apply
from filter_test_helpers import savings_ratio as _savings_ratio

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# 1. Dispatch table: parametrized per-filter match assertions
# ---------------------------------------------------------------------------

# Each entry: (command_tokens, expected_filter_name)
_DISPATCH_CASES: list[tuple[list[str], str]] = [
    # ---- PytestFilter ----
    (["pytest", "tests/"], "pytest"),
    (["pytest", "-x", "-v", "tests/unit/"], "pytest"),
    # py.test: Filter.matches() now checks both Path.stem *and* Path.name so the
    # full filename 'py.test' matches PytestFilter.binaries even though
    # Path('py.test').stem == 'py'.
    (["py.test", "tests/"], "pytest"),
    (["python", "-m", "pytest", "tests/"], "pytest"),
    (["uv", "run", "pytest", "tests/"], "pytest"),
    # ---- JestFilter ----
    (["jest", "--watchAll=false"], "jest"),
    (["mocha", "tests/*.spec.js"], "jest"),
    # ---- VitestFilter ----
    (["vitest", "run"], "vitest"),
    (["vitest", "--watch"], "vitest"),
    # ---- CargoFilter ----
    (["cargo", "build", "--release"], "cargo"),
    (["cargo", "test"], "cargo"),
    (["cargo", "check"], "cargo"),
    (["cargo", "clippy"], "cargo"),
    (["cargo", "run"], "cargo"),
    # ---- NpmInstallFilter ----
    (["npm", "install"], "npm_install"),
    (["npm", "ci"], "npm_install"),
    (["pnpm", "install"], "npm_install"),
    (["yarn", "install"], "npm_install"),
    (["playwright", "test"], "playwright"),
    (["playwright", "install"], "playwright"),
    (["npx", "playwright", "test"], "playwright"),
    (["bunx", "playwright", "test"], "playwright"),
    # ---- CypressFilter ----
    (["cypress", "run"], "cypress"),
    (["cypress", "open"], "cypress"),
    (["npx", "cypress", "run"], "cypress"),
    (["bunx", "cypress", "run"], "cypress"),
    (["bun", "install"], "bun"),
    # ---- NodeFilter (eval probes only) ----
    (["node", "-e", "console.log(1)"], "node"),
    (["node", "-p", "1+1"], "node"),
    # ---- DockerFilter ----
    (["docker", "build", "-t", "my-image", "."], "docker"),
    (["docker", "run", "--rm", "alpine"], "docker"),
    (["podman", "build", "."], "docker"),
    # ---- KubectlLogsFilter (precedes KubectlFilter; matches `kubectl logs`) ----
    (["kubectl", "logs", "my-pod"], "kubectl-logs"),
    # ---- HelmFilter (dedicated; precedes KubectlFilter which previously claimed `helm`) ----
    (["helm", "install", "my-release", "chart/"], "helm"),
    # ---- KubectlFilter ----
    (["kubectl", "get", "pods"], "kubectl"),
    # ---- AwsCliFilter (registered before AwsFilter; wins dispatch for `aws`) ----
    (["aws", "s3", "ls"], "aws-cli"),
    (["aws", "ec2", "describe-instances"], "aws-cli"),
    # ---- RuffFilter ----
    (["ruff", "check", "src/"], "ruff"),
    (["ruff", "check", "."], "ruff"),
    # ---- MypyFilter ----
    (["mypy", "src/"], "mypy"),
    (["dmypy", "run", "--", "src/"], "mypy"),
    # ---- ESLintFilter ----
    (["eslint", "src/", "--ext", ".ts"], "eslint"),
    (["eslint", "."], "eslint"),
    # ---- PylintFilter (dedicated, before LinterFilter) ----
    (["pylint", "src/"], "pylint"),
    # ---- OxlintFilter ----
    (["oxlint", "src/"], "oxlint"),
    (["oxc_linter", "src/"], "oxlint"),
    # ---- TurboFilter ----
    (["turbo", "run", "build"], "turbo"),
    (["npx", "turbo", "run", "build"], "turbo"),
    # ---- TscFilter (dedicated; previously fell through to LinterFilter) ----
    (["tsc", "--noEmit"], "tsc"),
    # ---- LinterFilter ----
    (["pyright", "src/"], "linter"),
    # ---- RgFilter (context-line suppressor, first-match for rg/grep) ----
    (["grep", "-r", "pattern", "src/"], "rg"),
    (["rg", "pattern", "src/"], "rg"),
    (["ag", "pattern"], "grep"),
    # ---- GitFilter and dedicated sub-filters ----
    # git status / log / diff / commit / push are claimed by dedicated sub-filters;
    # GitFilter remains the catch-all for every other git subcommand.
    (["git", "status"], "git-status"),
    (["git", "log", "--oneline"], "git-log"),
    (["git", "diff", "HEAD"], "git-diff"),
    (["git", "commit", "-m", "msg"], "git-commit"),
    (["git", "push", "origin", "main"], "git-push"),
    # ---- MakeFilter ----
    (["make", "all"], "make"),
    (["ninja", "-C", "build/"], "make"),
    (["go", "build", "./..."], "go"),
    (["gradle", "build"], "gradle"),
    # ---- GoTestFilter ----
    (["go", "test", "./..."], "go-test"),
    (["go", "test", "-v", "./pkg/..."], "go-test"),
    (["go", "test", "-run", "TestFoo", "./..."], "go-test"),
    # ---- GhFilter ----
    (["gh", "run", "view", "1234"], "gh"),
    (["gh", "pr", "view", "42"], "gh"),
    (["gh", "pr", "list"], "gh"),
    (["gh", "api", "repos/foo/bar"], "gh"),
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
    # uv pip install: 'pip' removed from _TWO_TOKEN_PREFIXES["uv"] triggers so
    # _strip_prefixes leaves ['uv', 'pip', 'install', ...] intact; UvFilter
    # matches on 'uv' stem and finds 'pip' in its pm_subcommands list.
    (["uv", "pip", "install", "requests"], "uv"),
    # ---- LsFilter (precedes EzaFilter; claims ls/eza/ll/dir) ----
    (["ls", "-la"], "ls"),
    (["ls", "-lah"], "ls"),
    (["eza", "--git", "--long"], "ls"),
    (["eza", "--tree", "--level", "2"], "ls"),
    (["ll"], "ls"),
    (["dir"], "ls"),
    # ---- EzaFilter (exa only — ls/eza claimed above by LsFilter) ----
    (["exa", "--long"], "eza"),
    # ---- TreeFilter ----
    (["tree"], "tree"),
    (["tree", "-L", "3"], "tree"),
    # ---- PythonFilter ----
    (["python", "script.py"], "python"),
    (["python3", "-c", "print('hello')"], "python"),
    # ---- AnsibleFilter ----
    (["ansible", "all", "-m", "ping"], "ansible"),
    (["ansible-playbook", "site.yml"], "ansible"),
    (["ansible-playbook", "-i", "inventory.ini", "deploy.yml"], "ansible"),
    (["ansible-pull", "-U", "git@example.com:playbooks.git"], "ansible"),
    # ---- PreCommitFilter ----
    (["pre-commit", "run", "--all-files"], "pre-commit"),
    (["pre-commit", "install"], "pre-commit"),
    (["pre-commit", "autoupdate"], "pre-commit"),
    # ---- MesonFilter ----
    (["meson", "setup", "build"], "meson"),
    (["meson", "compile", "-C", "build"], "meson"),
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

# TailTruncFilter is the last catch-all in FILTERS (always matches); commands
# not claimed by any more-specific filter now route to it.  For ≤500-line
# outputs it passes through verbatim, so the change is invisible to callers.
_TAIL_TRUNC_COMMANDS: list[list[str]] = [
    ["cat", "file.txt"],
    ["ssh", "user@host"],
    ["custom-build-tool", "--all"],
    ["echo", "hello"],
]


@pytest.mark.parametrize("argv", _TAIL_TRUNC_COMMANDS)
def test_unknown_commands_route_to_tail_trunc(argv: list[str]) -> None:
    """Commands with no specific filter now fall through to TailTruncFilter."""
    result = bc.select_filter(argv)
    assert result is not None
    assert isinstance(result, bc.TailTruncFilter)


def test_no_match_output_verbatim() -> None:
    """Short output from an unknown command passes through unchanged.

    TailTruncFilter is now the catch-all fallback (≤500 lines → verbatim
    pass-through), so signal is preserved just as when GenericFilter is used.
    """
    stdout = "special-tool: v1.2.3 installed successfully\nDone."
    stderr = ""
    # Unknown command now routes to TailTruncFilter (the catch-all).
    flt = bc.select_filter(["special-tool"])
    assert isinstance(flt, bc.TailTruncFilter)
    # Short output passes through verbatim.
    result = flt.apply(stdout, stderr, 0, ["special-tool"])
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


def test_git_status_routes_to_git_status() -> None:
    """'git status' → GitStatusVerboseFilter (higher-fidelity, registered before GitFilter)."""
    argv = ["git", "status"]
    f = bc.select_filter(argv)
    assert f is not None
    assert f.name == "git-status"


def test_py_dot_test_dispatches_to_pytest() -> None:
    """'py.test' binary dispatches to PytestFilter.

    Filter.matches() now checks both Path(argv[0]).stem *and* Path(argv[0]).name
    against the binaries set.  Path('py.test').stem == 'py' (misses), but
    Path('py.test').name == 'py.test' which matches PytestFilter.binaries.
    """
    result = bc.select_filter(["py.test", "tests/"])
    assert result is not None, "py.test should dispatch to PytestFilter"
    assert result.name == "pytest"


def test_uv_pip_install_routes_to_uv() -> None:
    """'uv pip install pkg' is routed to UvFilter.

    'pip' was removed from _TWO_TOKEN_PREFIXES["uv"] triggers so _strip_prefixes
    no longer consumes 'pip' as a dispatch keyword.  The argv remains
    ['uv', 'pip', 'install', 'mypackage'] after stripping, and UvFilter.matches()
    finds 'uv' as the stem and 'pip' in its pm_subcommands set.
    """
    result = bc.select_filter(["uv", "pip", "install", "mypackage"])
    assert result is not None, "uv pip install should route to UvFilter"
    assert result.name == "uv"


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


def test_uv_run_go_routes_to_go() -> None:
    """'uv run go build ./...' strips 'uv run', leaving 'go build', → GoFilter."""
    argv = ["uv", "run", "go", "build", "./..."]
    f = bc.select_filter(argv)
    # 'uv run' is a two-token prefix; stripping leaves ['go', 'build', './...']
    # GoFilter (registered before MakeFilter) handles go build.
    assert f is not None
    assert f.name == "go"


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


_CARGO_TEST_STDOUT = """\
running 5 tests
test auth::test_login_ok ... ok
test auth::test_logout ... ok
test auth::test_bad_password ... FAILED
test db::test_connect ... ok
test db::test_query ... ok

failures:

---- auth::test_bad_password stdout ----
thread 'auth::test_bad_password' panicked at 'assertion failed: result.is_ok()'
src/auth.rs:42

failures:
    auth::test_bad_password

test result: FAILED. 1 failed; 4 passed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
"""

_CARGO_CLIPPY_STDERR = """\
   Checking tokio v1.38.0
   Checking serde v1.0.197
   Checking my-project v0.1.0 (/src)
warning: unused variable: `x`
 --> src/main.rs:5:9
  |
5 |     let x = 1;
  |         ^ help: if this is intentional, prefix it with an underscore: `_x`

warning: 1 warning emitted
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
        assert "[compiling" in out

    def test_savings_ratio(self) -> None:
        f = bc.CargoFilter()
        big_stderr = "\n".join(
            [f"   Compiling crate{i} v1.0.{i}" for i in range(100)]
        ) + "\n   Finished dev [unoptimized] target(s) in 30s\n"
        ratio = _savings_ratio(f, stdout="", stderr=big_stderr)
        assert ratio >= 0.20, f"CargoFilter savings {ratio:.0%} < 20%"

    def test_cargo_test_pass_lines_collapsed(self) -> None:
        f = bc.CargoFilter()
        argv = ["cargo", "test"]
        result = f.apply(_CARGO_TEST_STDOUT, "", 1, argv)
        out = result.text
        assert "auth::test_bad_password" in out
        assert "assertion failed" in out
        assert "test result: FAILED" in out
        assert "collapsed 4 passing" in out

    def test_cargo_test_fail_line_preserved(self) -> None:
        f = bc.CargoFilter()
        argv = ["cargo", "test"]
        result = f.apply(_CARGO_TEST_STDOUT, "", 1, argv)
        assert "FAILED" in result.text

    def test_cargo_clippy_checking_lines_suppressed(self) -> None:
        f = bc.CargoFilter()
        argv = ["cargo", "clippy"]
        result = f.apply("", _CARGO_CLIPPY_STDERR, 0, argv)
        out = result.text
        assert "unused variable" in out
        assert "dropped" in out
        assert "Checking" not in out or "dropped" in out

    def test_cargo_clippy_warning_preserved(self) -> None:
        f = bc.CargoFilter()
        argv = ["cargo", "clippy"]
        result = f.apply("", _CARGO_CLIPPY_STDERR, 0, argv)
        assert "unused variable" in result.text
        assert "help: if this is intentional" in result.text

    def test_cargo_run_passthrough(self) -> None:
        f = bc.CargoFilter()
        argv = ["cargo", "run"]
        stdout = "Hello, world!\nProgram finished with code 0\n"
        result = f.apply(stdout, "", 0, argv)
        assert "Hello, world!" in result.text
        assert "Program finished" in result.text

    def test_cargo_build_dispatches_to_build(self) -> None:
        f = bc.CargoFilter()
        big_stderr = "\n".join(
            [f"   Compiling crate{i} v1.0.{i}" for i in range(20)]
        ) + "\n   Finished dev target(s) in 5s\n"
        result = f.apply("", big_stderr, 0, ["cargo", "build"])
        assert "[compiling 20 crates" in result.text
        assert "Finished" not in result.text


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


# --- GoTestFilter ----------------------------------------------------------

# Synthetic `go test -v` output exercising every line shape the filter
# recognises: package result, per-test RUN/PASS/FAIL lifecycle, indented
# Errorf body under a FAIL, download-progress noise.
_GO_TEST_OUTPUT = """\
go: downloading github.com/stretchr/testify v1.8.0
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
--- PASS: TestSub (0.00s)
=== RUN   TestDiv
=== PAUSE TestDiv
=== CONT  TestDiv
    math_test.go:42: divisor must be non-zero
    math_test.go:43: got 0, want 1
--- FAIL: TestDiv (0.00s)
=== RUN   TestMul
--- PASS: TestMul (0.00s)
FAIL
exit status 1
FAIL	example.com/mypkg	0.123s
ok  	example.com/otherpkg	0.045s
?   	example.com/emptypkg	[no test files]
"""


class TestGoTestFilter:
    def test_fail_block_preserved(self) -> None:
        f = bc.GoTestFilter()
        out = _apply(f, stdout=_GO_TEST_OUTPUT)
        assert "--- FAIL: TestDiv" in out
        # The indented body lines under the FAIL must survive verbatim so the
        # agent can see the actual failure message.
        assert "math_test.go:42: divisor must be non-zero" in out
        assert "math_test.go:43: got 0, want 1" in out

    def test_pass_lines_collapsed(self) -> None:
        f = bc.GoTestFilter()
        out = _apply(f, stdout=_GO_TEST_OUTPUT)
        # Passing testcases are summarised to a count, not listed individually.
        assert "--- PASS: TestAdd" not in out
        assert "--- PASS: TestMul" not in out
        # …and a collapse marker is present.
        assert "collapsed 3 PASS testcases" in out

    def test_package_results_kept(self) -> None:
        f = bc.GoTestFilter()
        out = _apply(f, stdout=_GO_TEST_OUTPUT)
        assert "FAIL\texample.com/mypkg" in out
        assert "ok  \texample.com/otherpkg" in out
        assert "?   \texample.com/emptypkg" in out

    def test_run_lines_dropped_outside_fail(self) -> None:
        f = bc.GoTestFilter()
        out = _apply(f, stdout=_GO_TEST_OUTPUT)
        # === RUN for passing testcases dropped (no signal value).
        assert "=== RUN   TestAdd" not in out

    def test_download_lines_dropped(self) -> None:
        f = bc.GoTestFilter()
        out = _apply(f, stdout=_GO_TEST_OUTPUT)
        # The original verbatim line is removed; the summary marker
        # ("dropped 1 'go: downloading' lines") may quote the string by
        # design, so check for the verbatim package@version reference.
        assert "go: downloading github.com/stretchr/testify v1.8.0" not in out
        assert "dropped 1 'go: downloading' lines" in out

    def test_savings_ratio_large_pass_run(self) -> None:
        f = bc.GoTestFilter()
        big_lines = []
        for i in range(200):
            big_lines.append(f"=== RUN   TestCase{i:03d}")
            big_lines.append(f"--- PASS: TestCase{i:03d} (0.00s)")
        big_lines.append("PASS")
        big_lines.append("ok  \texample.com/big\t0.500s")
        big = "\n".join(big_lines) + "\n"
        ratio = _savings_ratio(f, stdout=big)
        assert ratio >= 0.80, f"GoTestFilter savings {ratio:.0%} < 80% on big pass run"


# --- GhFilter --------------------------------------------------------------

_GH_RUN_VIEW_OUTPUT = """\
X main · 1234567 · push
Triggered via push about 2 minutes ago

JOBS
✓ build (ID 9876)
  Set up job
  Run actions/checkout@v4
  Run actions/setup-node@v4
  Install dependencies
  Build
  Complete job
✓ lint (ID 9877)
  Set up job
  Run actions/checkout@v4
  Run ESLint
  Complete job
X test (ID 9878)
  Set up job
  Run actions/checkout@v4
  Run tests
  Error: Test failed at src/foo.test.js:42
  Process completed with exit code 1
  Complete job

ANNOTATIONS
X test
  Test failed at src/foo.test.js:42
"""

_GH_PR_LIST_OUTPUT = """\
Showing 3 of 3 open pull requests in owner/repo

#42  Add feature X     feat/x        about 1 hour ago
#41  Fix bug Y         fix/y         about 2 hours ago
#40  Refactor module Z refactor/z    about 1 day ago
"""


class TestGhFilter:
    def test_run_view_failing_step_preserved(self) -> None:
        f = bc.GhFilter()
        out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"])
        # The X (failing step) line and everything under it must be preserved.
        assert "X test (ID 9878)" in out
        assert "Error: Test failed at src/foo.test.js:42" in out
        assert "Process completed with exit code 1" in out

    def test_run_view_passing_steps_collapsed(self) -> None:
        f = bc.GhFilter()
        out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"])
        # Passing step headers (✓ build, ✓ lint) collapsed to a count.
        assert "✓ build" not in out
        assert "✓ lint" not in out
        assert "collapsed 2 passing step headers" in out

    def test_run_view_action_preamble_dropped(self) -> None:
        f = bc.GhFilter()
        out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"])
        # The "  Run actions/checkout@v4" preamble lines under PASSING steps
        # should be dropped; the same lines under the FAILING step are
        # preserved because that block stays verbatim.
        # Count occurrences in the output: passing-step preambles are gone.
        # 1 occurrence remains (under the failing X test step).
        assert out.count("Run actions/checkout@v4") == 1

    def test_run_view_annotations_kept(self) -> None:
        f = bc.GhFilter()
        out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"])
        assert "ANNOTATIONS" in out
        assert "Test failed at src/foo.test.js:42" in out

    def test_pr_list_passes_through(self) -> None:
        f = bc.GhFilter()
        out = f.compress(_GH_PR_LIST_OUTPUT, "", 0, ["gh", "pr", "list"])
        # Every PR row is load-bearing — pass-through preserves them all.
        assert "#42" in out
        assert "#41" in out
        assert "#40" in out

    def test_run_list_truncates_large_output(self) -> None:
        f = bc.GhFilter()
        # Build a large list with 50 runs (>30 threshold).
        header = "Showing 50 of 50 runs in owner/repo\n"
        rows = [f"status-{i:03d}\t#run-{i:04d}\thttps://github.com/run/{i}" for i in range(50)]
        big_output = header + "\n".join(rows)
        out = f.compress(big_output, "", 0, ["gh", "run", "list"])
        # Should truncate to 30 rows and emit count.
        assert "showing first 30 of 50 runs" in out
        # Check that some early rows are present and some late rows are not.
        assert "run-0000" in out or "run-0001" in out
        assert "run-0049" not in out  # Last row should be elided

    def test_run_view_savings_ratio(self) -> None:
        f = bc.GhFilter()
        # Many passing steps with deep preambles.
        big_lines = []
        for i in range(50):
            big_lines.append(f"✓ step-{i:03d} (ID {i})")
            for action in ("checkout@v4", "setup-node@v4", "cache@v3"):
                big_lines.append(f"  Run actions/{action}")
            big_lines.append("  Build")
            big_lines.append("  Complete job")
        big_lines.append("X test (ID 999)")
        big_lines.append("  Error: kaboom")
        big = "\n".join(big_lines) + "\n"
        result = f.apply(big, "", 1, ["gh", "run", "view", "1"])
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.50, f"GhFilter savings {ratio:.0%} < 50% on big run view"


# ---------------------------------------------------------------------------
# 4b. FzfFilter — fuzzy finder output
# ---------------------------------------------------------------------------


class TestFzfFilter:
    def test_fzf_small_output_passes_through(self) -> None:
        f = bc.FzfFilter()
        # Fzf typically outputs 1-5 lines (selected items).
        output = "file1.py\nfile2.py\nfile3.py"
        out = f.compress(output, "", 0, ["fzf"])
        assert "file1.py" in out
        assert "file2.py" in out
        assert "file3.py" in out

    def test_fzf_large_output_truncates(self) -> None:
        f = bc.FzfFilter()
        # Generate >50 lines of output (e.g., from an upstream pipe).
        lines = [f"candidate-{i:03d}" for i in range(75)]
        output = "\n".join(lines)
        out = f.compress(output, "", 0, ["fzf"])
        # Should truncate and emit elision marker.
        # Keeps first 40 (candidate-000 to candidate-039) + last 10 (candidate-065 to candidate-074).
        assert "candidate-000" in out
        assert "candidate-039" in out
        assert "candidate-064" not in out  # Middle section elided
        assert "candidate-065" in out  # Last 10 kept
        assert "25 more lines elided" in out  # 75 - 40 - 10 = 25


# ---------------------------------------------------------------------------
# 4c. LazyGitFilter — git TUI
# ---------------------------------------------------------------------------


class TestLazyGitFilter:
    def test_lazygit_tui_output_returns_note(self) -> None:
        f = bc.LazyGitFilter()
        # Simulated terminal control output (ANSI escape codes).
        output = "\x1b[2J\x1b[H\x1b[1;32mLazyGit\x1b[0m"
        out = f.compress(output, "", 0, ["lazygit"])
        assert "interactive terminal UI" in out
        assert "not piped" in out

    def test_lazygit_empty_output_returns_note(self) -> None:
        f = bc.LazyGitFilter()
        output = ""
        out = f.compress(output, "", 0, ["lazygit"])
        assert "interactive terminal UI" in out

    def test_lazygit_plain_text_output_passes_through(self) -> None:
        f = bc.LazyGitFilter()
        # Unusual but possible: plain text output (no ANSI codes, non-empty).
        output = "Commit: abc123\nAuthor: Someone\n"
        out = f.compress(output, "", 0, ["lazygit"])
        assert "Commit: abc123" in out
        assert "Author: Someone" in out


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

    def test_unknown_command_routes_to_tail_trunc(self) -> None:
        # TailTruncFilter is the catch-all; detect_from_command now returns it.
        result = bc.detect_from_command("unknown-tool --flag")
        assert result is not None
        filter_, _ = result
        assert isinstance(filter_, bc.TailTruncFilter)

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
        "aws", "gh", "ruff", "mypy", "linter", "grep", "git",
        "make", "go-test", "terraform", "pip", "uv", "python",
        "ansible", "pre-commit",
    }
    missing = expected - names
    assert not missing, f"Missing filters in FILTERS registry: {missing}"


def test_go_test_precedes_make_in_registry() -> None:
    """GoTestFilter must precede MakeFilter so `go test` wins over `go build`."""
    names = [f.name for f in bc.FILTERS]
    assert "go-test" in names and "make" in names
    assert names.index("go-test") < names.index("make"), (
        "GoTestFilter must be registered before MakeFilter; otherwise "
        "MakeFilter.matches() (binaries={'go', ...}) wins for `go test`."
    )


def test_go_build_routes_to_go_not_go_test() -> None:
    """`go build ./...` routes to GoFilter, not GoTestFilter."""
    f = bc.select_filter(["go", "build", "./..."])
    assert f is not None
    assert f.name == "go", (
        "go build is not a test command; GoTestFilter.matches() must return "
        "False; GoFilter (registered after GoTestFilter) handles it."
    )


def test_go_vet_routes_to_go() -> None:
    """`go vet ./...` is handled by GoFilter."""
    f = bc.select_filter(["go", "vet", "./..."])
    assert f is not None
    assert f.name == "go"


# ---------------------------------------------------------------------------
# 7. AnsibleFilter / PreCommitFilter — golden output + registry guards
# ---------------------------------------------------------------------------

# A representative ansible-playbook run with two tasks across three hosts,
# one of which fails on the second task.  Exercises every line shape the
# filter cares about: PLAY/TASK headers, status lines, fatal payload,
# PLAY RECAP block.
_ANSIBLE_OUTPUT = """\
PLAY [Deploy app] *************************************************************

TASK [Gathering Facts] ********************************************************
ok: [web1]
ok: [web2]
ok: [web3]

TASK [Install nginx] **********************************************************
changed: [web1]
changed: [web2]
fatal: [web3]: FAILED! => {"changed": false, "msg": "Package nginx not found", "rc": 100}

TASK [Start nginx] ************************************************************
ok: [web1]
ok: [web2]
skipping: [web3]

PLAY RECAP ********************************************************************
web1                       : ok=3    changed=1    unreachable=0    failed=0    skipped=0
web2                       : ok=3    changed=1    unreachable=0    failed=0    skipped=0
web3                       : ok=1    changed=0    unreachable=0    failed=1    skipped=1
"""


class TestAnsibleFilter:
    def test_play_and_task_headers_preserved(self) -> None:
        f = bc.AnsibleFilter()
        out = _apply(f, _ANSIBLE_OUTPUT)
        assert "PLAY [Deploy app]" in out
        assert "TASK [Gathering Facts]" in out
        assert "TASK [Install nginx]" in out
        assert "TASK [Start nginx]" in out

    def test_status_lines_collapsed_to_count(self) -> None:
        f = bc.AnsibleFilter()
        out = _apply(f, _ANSIBLE_OUTPUT)
        # Individual ``ok: [host]`` rows must be gone — replaced by a count.
        assert "ok: [web1]" not in out
        assert "ok: [web2]" not in out
        # The aggregate marker line carries the counts.
        assert "ok" in out and "token-goat:" in out

    def test_fatal_block_preserved_verbatim(self) -> None:
        f = bc.AnsibleFilter()
        out = _apply(f, _ANSIBLE_OUTPUT)
        # The fatal line and its JSON-ish payload (same line in this fixture)
        # must survive — that's the load-bearing failure signal.
        assert "fatal: [web3]: FAILED!" in out
        assert "Package nginx not found" in out

    def test_play_recap_block_preserved(self) -> None:
        f = bc.AnsibleFilter()
        out = _apply(f, _ANSIBLE_OUTPUT)
        # PLAY RECAP and every per-host row carries the run-summary signal.
        assert "PLAY RECAP" in out
        assert "web1" in out and "ok=3" in out
        assert "web3" in out and "failed=1" in out

    def test_savings_ratio_large_inventory(self) -> None:
        f = bc.AnsibleFilter()
        # 50 hosts × 20 ok-only tasks ≈ 1000 status lines, all collapsible.
        lines = ["PLAY [big] ***"]
        for t in range(20):
            lines.append(f"TASK [task-{t}] ***")
            for h in range(50):
                lines.append(f"ok: [host-{h:02d}]")
        lines.append("")
        lines.append("PLAY RECAP ***")
        for h in range(50):
            lines.append(
                f"host-{h:02d}                       : ok=20   changed=0    "
                f"unreachable=0    failed=0    skipped=0"
            )
        big = "\n".join(lines) + "\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.40, f"AnsibleFilter savings {ratio:.0%} < 40% on big run"

    def test_empty_input_no_crash(self) -> None:
        f = bc.AnsibleFilter()
        out = _apply(f, "", "")
        assert out == "" or out.strip() == ""


# A representative ``pre-commit run --all-files`` output: env-setup info,
# many passing hooks, one failing hook with diff payload, and a final
# trailing-whitespace hook that passed.
_PRECOMMIT_OUTPUT = """\
[INFO] Initializing environment for https://github.com/pre-commit/pre-commit-hooks.
[INFO] Installing environment for https://github.com/pre-commit/pre-commit-hooks.
[INFO] Installing environment for https://github.com/psf/black.
Trim trailing whitespace.................................................Passed
Fix end of files.........................................................Passed
Check yaml...........................................(no files to check)Skipped
Check for added large files..............................................Passed
black....................................................................Failed
- hook id: black
- files were modified by this hook

reformatted src/foo.py

All done! ✨ 🍰 ✨
1 file reformatted.

ruff.....................................................................Passed
mypy.....................................................................Passed
"""


class TestPreCommitFilter:
    def test_failed_hook_preserved(self) -> None:
        f = bc.PreCommitFilter()
        out = _apply(f, _PRECOMMIT_OUTPUT)
        assert "black....................................................................Failed" in out
        # The failure body (hook id, file list, diff) must survive verbatim.
        assert "- hook id: black" in out
        assert "reformatted src/foo.py" in out
        assert "1 file reformatted." in out

    def test_passing_hooks_collapsed(self) -> None:
        f = bc.PreCommitFilter()
        out = _apply(f, _PRECOMMIT_OUTPUT)
        # Individual Passed lines disappear (4 before the failure: Trim, Fix,
        # large files, plus 2 after: ruff, mypy — minus the Skipped yaml).
        assert "Trim trailing whitespace" not in out
        assert "Fix end of files" not in out
        # The collapse marker is present at least once.
        assert "collapsed" in out and "Passed" in out

    def test_info_env_setup_collapsed(self) -> None:
        f = bc.PreCommitFilter()
        out = _apply(f, _PRECOMMIT_OUTPUT)
        # First [INFO] line is kept verbatim; subsequent ones are dropped.
        # The fixture has three [INFO] lines — exactly one survives as a
        # verbatim "[INFO] Initializing environment" line plus the marker.
        assert "[INFO] Initializing environment for" in out
        # The two further [INFO] lines should be gone.
        assert "Installing environment for https://github.com/pre-commit" not in out
        assert "Installing environment for https://github.com/psf/black" not in out
        # The dropped-count marker is present.
        assert "dropped 2 pre-commit [INFO] env-setup lines" in out

    def test_skipped_counted(self) -> None:
        f = bc.PreCommitFilter()
        out = _apply(f, _PRECOMMIT_OUTPUT)
        # Skipped hook is not preserved verbatim but counted in the collapse.
        assert "Check yaml" not in out
        assert "Skipped" in out  # appears in the collapsed marker

    def test_savings_ratio_many_passing_hooks(self) -> None:
        f = bc.PreCommitFilter()
        lines = [
            "[INFO] Initializing environment for repo.",
            "[INFO] Installing environment for repo.",
            "[INFO] Restored package cache.",
        ]
        for i in range(80):
            lines.append(f"hook-{i:03d}" + "." * (60 - len(str(i))) + "Passed")
        big = "\n".join(lines) + "\n"
        ratio = _savings_ratio(f, big)
        assert ratio >= 0.40, f"PreCommitFilter savings {ratio:.0%} < 40%"

    def test_no_match_for_make(self) -> None:
        """``make pre-commit`` should still route to MakeFilter, not us.

        ``pre-commit`` only matches when the binary itself is ``pre-commit``;
        a make target with that name has stem ``make`` and goes to MakeFilter.
        """
        f = bc.PreCommitFilter()
        assert not f.matches(["make", "pre-commit"])


# ---------------------------------------------------------------------------
# 8. Registry-order guards for the new filters
# ---------------------------------------------------------------------------


def test_ansible_and_pre_commit_in_registry() -> None:
    """Both new filters are registered exactly once and reachable by name."""
    names = [f.name for f in bc.FILTERS]
    assert names.count("ansible") == 1
    assert names.count("pre-commit") == 1
    assert bc.filter_by_name("ansible") is not None
    assert bc.filter_by_name("pre-commit") is not None


def test_ansible_dispatches_independently_of_make() -> None:
    """``ansible-playbook deploy.yml`` must route to AnsibleFilter, not MakeFilter.

    Belt-and-braces guard: ``ansible-playbook`` shares no binary stem with
    MakeFilter (``make``, ``gradle``, ``mvn`` etc.), but we encode the
    expectation explicitly so a future rename or accidental binary-set
    expansion in MakeFilter fails loudly here rather than silently
    swallowing ansible output through the wrong compressor.
    """
    f = bc.select_filter(["ansible-playbook", "site.yml"])
    assert f is not None
    assert f.name == "ansible"


def test_pre_commit_precedes_python_catchall_in_registry() -> None:
    """PreCommitFilter must precede PythonFilter in FILTERS.

    PythonFilter is the catch-all for the Python toolchain; if a future
    refactor adds ``pre-commit`` to its binaries set or moves PythonFilter
    earlier, ``pre-commit run`` would silently route to PythonFilter and
    lose the hook-level compression.  This guard documents the contract.
    """
    names = [f.name for f in bc.FILTERS]
    assert "pre-commit" in names and "python" in names
    assert names.index("pre-commit") < names.index("python"), (
        "PreCommitFilter must be registered before PythonFilter (catch-all)."
    )


def test_ansible_precedes_python_catchall_in_registry() -> None:
    """AnsibleFilter must precede PythonFilter in FILTERS.

    Same reasoning as the pre-commit precedence guard: ``ansible*`` binaries
    must never silently fall through to the catch-all PythonFilter.
    """
    names = [f.name for f in bc.FILTERS]
    assert "ansible" in names and "python" in names
    assert names.index("ansible") < names.index("python"), (
        "AnsibleFilter must be registered before PythonFilter (catch-all)."
    )


# ---------------------------------------------------------------------------
# GhFilter _compress_gh_list — targeted tests (iteration 3)
# ---------------------------------------------------------------------------

class TestGhFilterCompressGhList:
    """Tests for the _compress_gh_list() helper and its routing in GhFilter.compress()."""

    # ------------------------------------------------------------------
    # issue list — same row-cap logic as pr/run list
    # ------------------------------------------------------------------

    def test_issue_list_truncates_at_30_rows(self) -> None:
        """gh issue list with >30 data rows is truncated to first 30 + summary."""
        f = bc.GhFilter()
        header = "Showing 50 of 50 open issues in owner/repo\n"
        rows = [f"#{i:04d}\topen\tBug report {i}\t2026-05-{i % 28 + 1:02d}" for i in range(50)]
        big_output = header + "\n".join(rows)

        out = f.compress(big_output, "", 0, ["gh", "issue", "list"])

        # Count summary present
        assert "showing first 30 of 50 issues" in out
        # First row preserved
        assert "#0000" in out
        # 30th row (0-indexed 29) preserved; 31st (index 30) elided
        assert f"#{29:04d}" in out
        assert f"#{30:04d}" not in out

    def test_issue_list_under_threshold_passes_through(self) -> None:
        """gh issue list with ≤30 rows passes through without truncation."""
        f = bc.GhFilter()
        header = "Showing 10 of 10 open issues in owner/repo\n"
        rows = [f"#{i}\topen\tIssue {i}" for i in range(10)]
        output = header + "\n".join(rows)

        out = f.compress(output, "", 0, ["gh", "issue", "list"])

        assert "showing first 30" not in out
        # All rows present
        for i in range(10):
            assert f"#{i}" in out

    def test_pr_list_exactly_30_rows_passes_through(self) -> None:
        """gh pr list with exactly 30 data rows passes through unchanged."""
        f = bc.GhFilter()
        header = "Showing 30 of 30 pull requests\n"
        rows = [f"#{i}\topen\tPR {i}" for i in range(30)]
        output = header + "\n".join(rows)

        out = f.compress(output, "", 0, ["gh", "pr", "list"])

        assert "showing first 30" not in out
        assert "#29" in out

    def test_pr_list_31_rows_triggers_truncation(self) -> None:
        """gh pr list with 31 data rows triggers truncation (over-threshold by 1)."""
        f = bc.GhFilter()
        header = "Showing 31 of 31 pull requests\n"
        rows = [f"#{i}\topen\tPR {i}" for i in range(31)]
        output = header + "\n".join(rows)

        out = f.compress(output, "", 0, ["gh", "pr", "list"])

        assert "showing first 30 of 31 prs" in out
        assert "#30" not in out  # 31st row (0-indexed 30) is elided

    # ------------------------------------------------------------------
    # Non-list subcommands must NOT be row-truncated
    # ------------------------------------------------------------------

    def test_pr_view_not_row_truncated(self) -> None:
        """gh pr view passes through all content without row truncation."""
        f = bc.GhFilter()
        # Build pr view output that looks like a long PR body (not tabular rows).
        header_block = (
            "title:\tAdd great feature\n"
            "state:\tOPEN\n"
            "author:\talice\n"
            "body:\n"
        )
        body_lines = "\n".join([f"  Line {i} of the PR body." for i in range(50)])
        output = header_block + body_lines

        out = f.compress(output, "", 0, ["gh", "pr", "view", "42"])

        # Must not emit a row-count summary
        assert "showing first 30" not in out
        # Body lines must be intact (squeeze_blank_lines may merge blanks but text stays)
        assert "Line 0 of the PR body" in out
        assert "Line 49 of the PR body" in out

    def test_gh_api_not_row_truncated(self) -> None:
        """gh api passes through without row truncation."""
        f = bc.GhFilter()
        # Simulate gh api returning 50 JSON lines (one item per line).
        json_lines = [f'{{"id": {i}, "name": "item{i}"}}' for i in range(50)]
        output = "\n".join(json_lines)

        out = f.compress(output, "", 0, ["gh", "api", "/repos/owner/repo/issues"])

        assert "showing first 30" not in out
        assert '"id": 49' in out  # Last item must be present

    def test_run_list_label_says_runs(self) -> None:
        """_compress_gh_list uses 'runs' (not 'prs' or 'issues') for run list."""
        f = bc.GhFilter()
        header = "Showing 40 runs\n"
        rows = [f"completed\trun-{i}" for i in range(40)]
        output = header + "\n".join(rows)

        out = f.compress(output, "", 0, ["gh", "run", "list"])

        assert "showing first 30 of 40 runs" in out

    def test_issue_list_label_says_issues(self) -> None:
        """_compress_gh_list uses 'issues' (not 'runs' or 'prs') for issue list."""
        f = bc.GhFilter()
        header = "Showing 40 issues\n"
        rows = [f"open\t#{i}\tBug {i}" for i in range(40)]
        output = header + "\n".join(rows)

        out = f.compress(output, "", 0, ["gh", "issue", "list"])

        assert "showing first 30 of 40 issues" in out


# --- NodeFilter (node -e / node -p eval probes) -----------------------------

_NODE_TRACE_WITH_MODULES = """\
/path/to/script.js:1
require('missing-pkg')
^

Error: Cannot find module 'missing-pkg'
Require stack:
- /path/to/script.js
    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1039:15)
    at Function.Module._load (node:internal/modules/cjs/loader:885:27)
    at Module.require (node:internal/modules/cjs/loader:1006:19)
    at require (node:internal/helpers:182:18)
    at Object.<anonymous> (/path/to/node_modules/some-pkg/index.js:5:1)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)
    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1400:10)
    at Module.load (node:internal/modules/cjs/loader:1200:32)
    at Function.Module._load (node:internal/modules/cjs/loader:1016:12)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/cjs/loader:1076:10)
    at node:internal/main/run_main_module:30:49
"""


class TestNodeFilter:
    """Tests for NodeFilter: node -e / node -p eval probe compression."""

    def _f(self) -> bc.NodeFilter:
        return bc.NodeFilter()

    # --- dispatch / matches --------------------------------------------------

    def test_matches_eval_flag(self) -> None:
        """node -e 'code' is claimed by NodeFilter."""
        f = self._f()
        assert f.matches(["node", "-e", "console.log(1)"])

    def test_matches_print_flag(self) -> None:
        """node -p 'expr' is claimed by NodeFilter."""
        f = self._f()
        assert f.matches(["node", "-p", "1+1"])

    def test_does_not_match_script_run(self) -> None:
        """node script.js (no eval flag) should NOT be claimed."""
        f = self._f()
        assert not f.matches(["node", "script.js"])

    def test_does_not_match_npm(self) -> None:
        """npm commands should not be claimed by NodeFilter."""
        f = self._f()
        assert not f.matches(["npm", "install"])

    # --- node_modules frame collapse -----------------------------------------

    def test_node_modules_frames_collapsed(self) -> None:
        """node_modules frames are replaced with a single omission placeholder."""
        f = self._f()
        out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "require('missing-pkg')"])
        assert "node_modules frame(s) omitted" in out
        # The node_modules frame itself must be gone.
        assert "node_modules/some-pkg/index.js" not in out

    def test_error_header_preserved(self) -> None:
        """The Error: line must survive unchanged."""
        f = self._f()
        out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "x"])
        assert "Error: Cannot find module 'missing-pkg'" in out

    def test_internal_frames_collapsed(self) -> None:
        """node:internal frames are collapsed to a placeholder."""
        f = self._f()
        out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "x"])
        assert "Node.js internal frame(s) omitted" in out
        # Raw node:internal lines must not appear verbatim.
        assert "node:internal/modules/cjs/loader" not in out

    def test_savings_ratio(self) -> None:
        """Compression must save >= 20% on a representative node_modules trace."""
        f = self._f()
        result = f.apply(
            _NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "require('missing-pkg')"],
        )
        ratio = result.percent_saved / 100.0
        assert ratio >= 0.20, f"NodeFilter savings {ratio:.0%} < 20%"

    # --- success passthrough -------------------------------------------------

    def test_success_passthrough(self) -> None:
        """Successful eval output is returned unchanged (just token-capped)."""
        f = self._f()
        out = f.compress("42\n", "", 0, ["node", "-p", "6*7"])
        assert "42" in out
        # No compression markers on success.
        assert "omitted" not in out

    # --- empty output --------------------------------------------------------

    def test_empty_output_no_crash(self) -> None:
        """Empty stderr/stdout on failure does not raise."""
        f = self._f()
        out = f.compress("", "", 1, ["node", "-e", "process.exit(1)"])
        assert isinstance(out, str)
