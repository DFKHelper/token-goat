"""Tests for NpmInstallFilter — npm/yarn/pnpm install output compression."""

from __future__ import annotations

from token_goat.bash_compress import NpmInstallFilter, select_filter
from token_goat.bash_detect import detect

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FILTER = NpmInstallFilter()


def _npm(stdout: str = "", stderr: str = "", argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["npm", "install"]
    return _FILTER.compress(stdout, stderr, 0, argv)


def _yarn(stdout: str = "", stderr: str = "", argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["yarn", "install"]
    return _FILTER.compress(stdout, stderr, 0, argv)


def _pnpm(stdout: str = "", stderr: str = "", argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["pnpm", "install"]
    return _FILTER.compress(stdout, stderr, 0, argv)


# ---------------------------------------------------------------------------
# Sample output fixtures
# ---------------------------------------------------------------------------

NPM_INSTALL_STDOUT = """\
added 247 packages, and audited 248 packages in 3s

45 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
"""

NPM_INSTALL_WITH_DEPRECATED = """\
npm warn deprecated har-validator@5.1.5: this library is no longer supported
npm warn deprecated request@2.88.2: request has been deprecated
npm warn deprecated uuid@3.4.0: Please upgrade to version 7
npm warn deprecated core-js@2.6.12: core-js@2 is no longer maintained
npm warn deprecated lodash@4.0.0: Use lodash 4.17.x

added 120 packages, and audited 121 packages in 5s

found 0 vulnerabilities
"""

NPM_INSTALL_VULNERABILITIES = """\
added 50 packages, and audited 51 packages in 2s

3 vulnerabilities (1 moderate, 2 high)

To address issues that do not require attention, run:
  npm audit fix

Run `npm audit` for details.
"""

NPM_CI_STDOUT = """\
npm warn deprecated har-validator@5.1.5: this library is no longer supported

added 247 packages in 3s
"""

NPM_LOCKFILE_NOTICE = """\
npm notice created a lockfile as package-lock.json. You should commit this file.

added 10 packages, and audited 11 packages in 1s

found 0 vulnerabilities
"""

NPM_EBADPLATFORM_WARN = """\
npm warn EBADPLATFORM fsevents@2.3.2: OS Platform "linux" is not supported

added 100 packages, and audited 101 packages in 2s

found 0 vulnerabilities
"""

YARN_CLASSIC_STDOUT = """\
yarn install v1.22.19
[1/4] Resolving packages...
[2/4] Fetching packages...
[3/4] Linking dependencies...
[4/4] Building fresh packages...
info Direct dependencies
info All dependencies
warning "react-scripts > eslint-loader@2.2.1" has incorrect peer dependency "webpack@^4.0.0".
warning "some-pkg > dep" has unmet peer dependency "react@^17.0.0".
success Saved lockfile.
success Saved 1 new dependency.
Done in 12.34s.
"""

YARN_WITH_ERROR = """\
yarn install v1.22.19
[1/4] Resolving packages...
error An unexpected error occurred: "https://registry.npmjs.org/no-such-pkg: Not found".
info If you think this is a bug, please open a bug report with the information provided in "/home/user/.yarn-error.log".
info Visit https://yarnpkg.com/en/docs/cli/install for documentation about this command.
"""

PNPM_INSTALL_STDOUT = """\
Packages: +247
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 247, reused 220, downloaded 27, added 247, done
"""

PNPM_INSTALL_WITH_ERROR = """\
Packages: +10
++++++++++
 ERR_PNPM_NO_MATCHING_VERSION  No matching version found for no-such-pkg@999.0.0
"""


# ---------------------------------------------------------------------------
# TestNpmInstallFilterMatches — 12+ cases
# ---------------------------------------------------------------------------


class TestNpmInstallFilterMatches:
    """NpmInstallFilter.matches() dispatches on binary + install subcommand."""

    # --- npm ---

    def test_npm_install(self) -> None:
        assert _FILTER.matches(["npm", "install"]) is True

    def test_npm_i_alias(self) -> None:
        assert _FILTER.matches(["npm", "i"]) is True

    def test_npm_ci(self) -> None:
        assert _FILTER.matches(["npm", "ci"]) is True

    def test_npm_install_package(self) -> None:
        assert _FILTER.matches(["npm", "install", "express"]) is True

    def test_npm_install_with_flag(self) -> None:
        assert _FILTER.matches(["npm", "install", "--save-dev", "webpack"]) is True

    def test_npm_cmd_install(self) -> None:
        assert _FILTER.matches(["npm.cmd", "install"]) is True

    def test_npm_exe_install(self) -> None:
        assert _FILTER.matches(["npm.exe", "install"]) is True

    def test_npm_full_path(self) -> None:
        assert _FILTER.matches([r"C:\Program Files\nodejs\npm.cmd", "install"]) is True

    # --- yarn ---

    def test_yarn_install_explicit(self) -> None:
        assert _FILTER.matches(["yarn", "install"]) is True

    def test_yarn_bare(self) -> None:
        # bare `yarn` runs install
        assert _FILTER.matches(["yarn"]) is True

    def test_yarn_add(self) -> None:
        assert _FILTER.matches(["yarn", "add", "lodash"]) is True

    def test_yarn_cmd(self) -> None:
        assert _FILTER.matches(["yarn.cmd", "install"]) is True

    # --- pnpm ---

    def test_pnpm_install(self) -> None:
        assert _FILTER.matches(["pnpm", "install"]) is True

    def test_pnpm_i_alias(self) -> None:
        assert _FILTER.matches(["pnpm", "i"]) is True

    def test_pnpm_add(self) -> None:
        assert _FILTER.matches(["pnpm", "add", "react"]) is True

    # --- false positives ---

    def test_not_npx(self) -> None:
        assert _FILTER.matches(["npx", "create-react-app", "my-app"]) is False

    def test_not_npm_run(self) -> None:
        assert _FILTER.matches(["npm", "run", "build"]) is False

    def test_not_npm_test(self) -> None:
        assert _FILTER.matches(["npm", "test"]) is False

    def test_not_npm_audit(self) -> None:
        assert _FILTER.matches(["npm", "audit"]) is False

    def test_not_npm_ls(self) -> None:
        assert _FILTER.matches(["npm", "ls"]) is False

    def test_not_npm_info(self) -> None:
        assert _FILTER.matches(["npm", "info", "react"]) is False

    def test_not_yarn_run(self) -> None:
        assert _FILTER.matches(["yarn", "run", "test"]) is False

    def test_not_yarn_info(self) -> None:
        assert _FILTER.matches(["yarn", "info", "lodash"]) is False

    def test_not_pnpm_run(self) -> None:
        assert _FILTER.matches(["pnpm", "run", "build"]) is False

    def test_not_pnpm_exec(self) -> None:
        assert _FILTER.matches(["pnpm", "exec", "jest"]) is False

    def test_empty_argv(self) -> None:
        assert _FILTER.matches([]) is False

    def test_not_node(self) -> None:
        assert _FILTER.matches(["node", "install.js"]) is False


# ---------------------------------------------------------------------------
# TestCompressNpmInstall — 12+ cases
# ---------------------------------------------------------------------------


class TestCompressNpmInstall:
    """NpmInstallFilter.compress() for npm install output."""

    def test_clean_install_suppresses_zero_vuln(self) -> None:
        result = _npm(NPM_INSTALL_STDOUT)
        assert "found 0 vulnerabilities" not in result

    def test_clean_install_keeps_added_summary(self) -> None:
        result = _npm(NPM_INSTALL_STDOUT)
        assert "added 247 packages" in result

    def test_clean_install_suppresses_funding(self) -> None:
        result = _npm(NPM_INSTALL_STDOUT)
        assert "looking for funding" not in result
        assert "npm fund" not in result

    def test_deprecated_cap_keeps_first_three(self) -> None:
        result = _npm(NPM_INSTALL_WITH_DEPRECATED)
        assert "har-validator" in result
        assert "request@2.88.2" in result
        assert "uuid@3.4.0" in result

    def test_deprecated_cap_suppresses_after_three(self) -> None:
        result = _npm(NPM_INSTALL_WITH_DEPRECATED)
        # 4th and 5th deprecated warnings must be gone
        assert "core-js@2.6.12" not in result
        assert "lodash@4.0.0" not in result

    def test_deprecated_cap_adds_note(self) -> None:
        result = _npm(NPM_INSTALL_WITH_DEPRECATED)
        assert "token-goat" in result
        assert "deprecated" in result

    def test_nonzero_vulnerabilities_kept(self) -> None:
        result = _npm(NPM_INSTALL_VULNERABILITIES)
        assert "3 vulnerabilities" in result

    def test_npm_ci_argv(self) -> None:
        result = _npm(NPM_CI_STDOUT, argv=["npm", "ci"])
        assert "added 247 packages" in result

    def test_lockfile_notice_kept(self) -> None:
        result = _npm(NPM_LOCKFILE_NOTICE)
        assert "lockfile" in result.lower()

    def test_generic_notice_suppressed(self) -> None:
        out = "npm notice created a lockfile as package-lock.json. You should commit this file.\nnpm notice ENOGIT npm noticed you're in a git repo\n\nadded 1 package\n"
        result = _npm(out)
        # lockfile notice (has "lock") stays; generic notice goes
        assert "lockfile" in result.lower()
        assert "ENOGIT" not in result

    def test_ebadplatform_warn_kept(self) -> None:
        result = _npm(NPM_EBADPLATFORM_WARN)
        assert "EBADPLATFORM" in result

    def test_zero_vuln_from_stderr(self) -> None:
        result = _npm(stderr="found 0 vulnerabilities\n")
        assert "found 0 vulnerabilities" not in result

    def test_error_line_always_kept(self) -> None:
        out = "npm ERR! code ENOENT\nnpm ERR! syscall open\nadded 1 package\n"
        result = _npm(out)
        assert "npm ERR!" in result

    def test_exactly_three_deprecated_no_note(self) -> None:
        # Exactly 3 deprecated warnings — all kept, no suppression note
        out = (
            "npm warn deprecated a@1.0.0: deprecated\n"
            "npm warn deprecated b@2.0.0: deprecated\n"
            "npm warn deprecated c@3.0.0: deprecated\n"
            "added 50 packages\n"
        )
        result = _npm(out)
        assert "a@1.0.0" in result
        assert "b@2.0.0" in result
        assert "c@3.0.0" in result
        assert "token-goat" not in result


# ---------------------------------------------------------------------------
# TestCompressYarnInstall — 8+ cases
# ---------------------------------------------------------------------------


class TestCompressYarnInstall:
    """NpmInstallFilter.compress() for yarn install output."""

    def test_phase_headers_suppressed(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "[1/4]" not in result
        assert "[2/4]" not in result
        assert "[4/4]" not in result

    def test_info_lines_suppressed(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "info Direct dependencies" not in result
        assert "info All dependencies" not in result

    def test_peer_dep_warnings_suppressed(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "has incorrect peer dependency" not in result
        assert "has unmet peer dependency" not in result

    def test_success_lines_suppressed(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "success Saved lockfile" not in result
        assert "success Saved 1 new dependency" not in result

    def test_done_line_kept(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "Done in" in result

    def test_banner_kept(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "yarn install v" in result

    def test_error_always_kept(self) -> None:
        result = _yarn(YARN_WITH_ERROR)
        assert "error An unexpected error occurred" in result

    def test_noise_note_emitted(self) -> None:
        result = _yarn(YARN_CLASSIC_STDOUT)
        assert "token-goat" in result
        assert "suppressed" in result

    def test_bare_yarn_argv(self) -> None:
        # bare `yarn` matches and compresses correctly
        result = _FILTER.compress(YARN_CLASSIC_STDOUT, "", 0, ["yarn"])
        assert "[1/4]" not in result
        assert "Done in" in result


# ---------------------------------------------------------------------------
# TestCompressPnpmInstall — 6+ cases
# ---------------------------------------------------------------------------


class TestCompressPnpmInstall:
    """NpmInstallFilter.compress() for pnpm install output."""

    def test_plus_bar_suppressed(self) -> None:
        result = _pnpm(PNPM_INSTALL_STDOUT)
        assert "++++++" not in result

    def test_packages_summary_kept(self) -> None:
        result = _pnpm(PNPM_INSTALL_STDOUT)
        assert "Packages: +247" in result

    def test_progress_done_kept(self) -> None:
        result = _pnpm(PNPM_INSTALL_STDOUT)
        assert "done" in result.lower()

    def test_pnpm_error_kept(self) -> None:
        result = _pnpm(PNPM_INSTALL_WITH_ERROR)
        assert "ERR_PNPM_NO_MATCHING_VERSION" in result

    def test_progress_note_emitted(self) -> None:
        result = _pnpm(PNPM_INSTALL_STDOUT)
        assert "token-goat" in result
        assert "suppressed" in result

    def test_pnpm_add_argv(self) -> None:
        result = _FILTER.compress(PNPM_INSTALL_STDOUT, "", 0, ["pnpm", "add", "react"])
        assert "++++++" not in result
        assert "done" in result.lower()


# ---------------------------------------------------------------------------
# TestNpmInstallRegressions — edge cases
# ---------------------------------------------------------------------------


class TestNpmInstallRegressions:
    """Edge-case regression guards."""

    def test_deprecated_cap_boundary_fourth_suppressed(self) -> None:
        # Exactly 4 deprecated warnings — first 3 kept, 4th suppressed
        out = (
            "npm warn deprecated a@1.0.0: message\n"
            "npm warn deprecated b@1.0.0: message\n"
            "npm warn deprecated c@1.0.0: message\n"
            "npm warn deprecated d@1.0.0: message\n"
            "added 10 packages\n"
        )
        result = _npm(out)
        assert "a@1.0.0" in result
        assert "b@1.0.0" in result
        assert "c@1.0.0" in result
        assert "d@1.0.0" not in result
        assert "token-goat" in result

    def test_error_passthrough_overrides_suppress_rules(self) -> None:
        # "found 0 vulnerabilities" would normally be suppressed, but a line
        # containing "error" nearby must survive
        out = "npm error fetch failed\nfound 0 vulnerabilities\n"
        result = _npm(out)
        assert "npm error fetch failed" in result
        assert "found 0 vulnerabilities" not in result  # zero still suppressed

    def test_nonzero_vulnerabilities_not_suppressed(self) -> None:
        out = "added 50 packages\nfound 5 vulnerabilities (3 moderate, 2 high)\n"
        result = _npm(out)
        assert "found 5 vulnerabilities" in result

    def test_yarn_non_peer_dep_warning_kept(self) -> None:
        # A yarn warning that is NOT a peer dep warning must be preserved
        out = 'yarn install v1.22.19\nwarning package.json: No license field\nDone in 1s.\n'
        result = _yarn(out)
        assert "No license field" in result

    def test_detect_returns_npm_install_for_npm(self) -> None:
        assert detect(["npm", "install"]) == "npm_install"

    def test_detect_returns_npm_install_for_yarn(self) -> None:
        assert detect(["yarn", "install"]) == "yarn"

    def test_detect_returns_npm_install_for_pnpm(self) -> None:
        assert detect(["pnpm", "install"]) == "pnpm"

    def test_select_filter_routes_npm_install(self) -> None:
        f = select_filter(["npm", "install"])
        assert f is not None
        assert isinstance(f, NpmInstallFilter)

    def test_select_filter_routes_pnpm_install(self) -> None:
        f = select_filter(["pnpm", "install"])
        assert f is not None
        assert isinstance(f, NpmInstallFilter)

    def test_select_filter_routes_yarn_install(self) -> None:
        f = select_filter(["yarn", "install"])
        assert f is not None
        assert isinstance(f, NpmInstallFilter)

    def test_select_filter_npm_run_does_not_route_here(self) -> None:
        # npm run should NOT be handled by NpmInstallFilter
        f = select_filter(["npm", "run", "build"])
        assert f is None or not isinstance(f, NpmInstallFilter)

    def test_pnpm_progress_intermediate_suppressed(self) -> None:
        # Progress line without "done" is suppressed
        out = "Packages: +10\n++++++++++\nProgress: resolved 10, reused 5, downloaded 5\n"
        result = _pnpm(out)
        assert "Progress: resolved 10" not in result

    def test_pnpm_progress_done_kept(self) -> None:
        out = "Packages: +10\n++++++++++\nProgress: resolved 10, reused 5, downloaded 5, added 10, done\n"
        result = _pnpm(out)
        assert "done" in result.lower()
        assert "++++++++++++++" not in result  # bar must be suppressed
