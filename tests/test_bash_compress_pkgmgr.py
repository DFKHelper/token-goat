"""Tests for CondaFilter, UvFilter (freeze/list extension), PnpmFilter, YarnFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# UvFilter — freeze / list extension
# ---------------------------------------------------------------------------


class TestUvFilterFreezeList:
    """UvFilter compresses uv pip freeze / uv pip list when >50 packages."""

    UV = bc.UvFilter()

    def _freeze_output(self, n: int) -> str:
        return "\n".join(f"package-{i}==1.{i}" for i in range(n))

    def test_freeze_short_passthrough(self) -> None:
        """≤50 packages: output passes through unchanged."""
        out = self._freeze_output(30)
        result = _apply(self.UV, stdout=out, argv=["uv", "pip", "freeze"])
        for i in range(30):
            assert f"package-{i}==1.{i}" in result

    def test_freeze_long_truncated(self) -> None:
        """51 packages: first 20 shown, rest summarised."""
        out = self._freeze_output(51)
        result = _apply(self.UV, stdout=out, argv=["uv", "pip", "freeze"])
        # First 20 packages must appear.
        for i in range(20):
            assert f"package-{i}==" in result
        # Package 21+ must not appear.
        assert "package-20==" not in result
        # Count summary must appear (collapsed N package lines).
        assert "31" in result and "package" in result

    def test_list_long_truncated(self) -> None:
        """uv pip list with 60 packages: first 20 + count."""
        out = self._freeze_output(60)
        result = _apply(self.UV, stdout=out, argv=["uv", "pip", "list"])
        assert "package-0==" in result
        assert "package-19==" in result
        assert "package-20==" not in result
        assert "40" in result and "package" in result

    def test_freeze_error_lines_preserved(self) -> None:
        """Error lines survive even when list is short."""
        out = "some-pkg==1.0\nERROR: Could not find package xyz\n"
        result = _apply(self.UV, stdout=out, argv=["uv", "pip", "freeze"])
        assert "ERROR" in result

    def test_install_not_affected(self) -> None:
        """uv pip install still uses the standard compression path."""
        # Build a realistic uv install output.
        lines = [
            "Resolved 10 packages in 0.5s",
            "   Downloading requests-2.31.0 (100 KB)",
            "   Downloading urllib3-2.0.0 (50 KB)",
            "  + requests==2.31.0",
            "  + urllib3==2.0.0",
            "Installed 10 packages in 0.2s",
        ]
        out = "\n".join(lines)
        result = _apply(self.UV, stdout=out, argv=["uv", "pip", "install", "requests"])
        assert "Resolved 10 packages" in result
        assert "Installed 10 packages" in result
        # Download lines should be compressed.
        assert "dropped" in result.lower() or "Downloading" not in result


class TestUvFilterDownloadedPastTense:
    """UvFilter drops 'Downloaded' (past tense) progress lines from uv output."""

    UV = bc.UvFilter()

    def test_downloaded_past_tense_dropped(self) -> None:
        """'Downloaded X.whl (N KB)' lines are dropped alongside 'Downloading'."""
        lines = [
            "Resolved 5 packages in 123ms",
            "  Downloaded requests 2.31.0 (96 KB)",
            "  Downloaded certifi 2024.2.2 (164 KB)",
            "  Downloaded urllib3 2.0.0 (87 KB)",
            "Installed 5 packages in 0.5s",
        ]
        out = "\n".join(lines)
        result = _apply(self.UV, stdout=out, argv=["uv", "sync"])
        # Downloaded (past tense) lines must be dropped
        assert "Downloaded requests" not in result
        assert "Downloaded certifi" not in result
        # Summary lines must be preserved
        assert "Resolved 5 packages" in result
        assert "Installed 5 packages" in result

    def test_mixed_downloading_downloaded_all_dropped(self) -> None:
        """Both present- and past-tense download lines are dropped in one pass."""
        lines = [
            "Resolved 10 packages in 500ms",
            "   Downloading serde 1.0.197 (50 KB)",
            "   Downloaded tokio 1.36.0 (456 KB)",
            "   Fetching metadata for hyper",
            "   Downloaded hyper 1.2.0 (200 KB)",
            "  + serde==1.0.197",
            "  + tokio==1.36.0",
            "  + hyper==1.2.0",
            "Installed 3 packages in 1.2s",
        ]
        out = "\n".join(lines)
        result = _apply(self.UV, stdout=out, argv=["uv", "add", "hyper"])
        assert "Downloading serde" not in result
        assert "Downloaded tokio" not in result
        assert "Downloaded hyper" not in result
        assert "Fetching metadata" not in result
        # Summary lines preserved
        assert "Resolved 10 packages" in result
        assert "Installed 3 packages" in result

    def test_savings_significant_with_many_downloads(self) -> None:
        """Large uv sync with many downloaded packages achieves >50% byte savings."""
        lines = (
            ["Resolved 30 packages in 2.3s"]
            + [f"  Downloaded package-{i} 1.{i}.0 (100 KB)" for i in range(25)]
            + [f"  + package-{i}==1.{i}.0" for i in range(25)]
            + ["Installed 25 packages in 3.1s"]
        )
        out = "\n".join(lines)
        f = self.UV
        result = f.apply(out, "", 0, ["uv", "sync"])
        assert len(result.text.encode()) < len(out.encode()) * 0.5
        assert "Resolved 30 packages" in result.text
        assert "Installed 25 packages" in result.text


# ---------------------------------------------------------------------------
# CondaFilter
# ---------------------------------------------------------------------------


class TestCondaFilterMatches:
    """CondaFilter.matches() correctly scopes to relevant subcommands."""

    CONDA = bc.CondaFilter()

    def test_matches_conda_install(self) -> None:
        assert self.CONDA.matches(["conda", "install", "numpy"])

    def test_matches_conda_create(self) -> None:
        assert self.CONDA.matches(["conda", "create", "-n", "myenv", "python=3.11"])

    def test_matches_conda_list(self) -> None:
        assert self.CONDA.matches(["conda", "list"])

    def test_matches_conda_env_export(self) -> None:
        assert self.CONDA.matches(["conda", "env", "export"])

    def test_matches_mamba(self) -> None:
        assert self.CONDA.matches(["mamba", "install", "scipy"])

    def test_matches_micromamba(self) -> None:
        assert self.CONDA.matches(["micromamba", "install", "pandas"])

    def test_no_match_pip(self) -> None:
        assert not self.CONDA.matches(["pip", "install", "numpy"])

    def test_no_match_empty(self) -> None:
        assert not self.CONDA.matches([])


class TestCondaFilterInstall:
    """CondaFilter compresses conda install output."""

    CONDA = bc.CondaFilter()

    _INSTALL_OUTPUT = "\n".join([
        "Collecting package metadata (current_repodata.json): done",
        "Solving environment: done",
        "",
        "## Package Plan ##",
        "",
        "  environment location: /opt/conda",
        "",
        "  added / updated specs:",
        "    - numpy",
        "",
        "The following packages will be downloaded:",
        "",
        "    package                    |            build",
        "    ---------------------------|------",
        "    numpy-1.24.0               |   py311h0...",
        "",
        "Downloading and Extracting Packages:",
        "numpy-1.24.0         | 10 MB | ############ | 100%",
        "blas-1.0             | 6 KB  | ############ | 100%",
        "mkl-2023.1           | 171 MB| ############ | 100%",
        "",
        "Preparing transaction: done",
        "Verifying transaction: done",
        "Executing transaction: done",
    ])

    def test_phase_headers_kept(self) -> None:
        result = _apply(self.CONDA, stdout=self._INSTALL_OUTPUT, argv=["conda", "install", "numpy"])
        assert "Collecting package metadata" in result
        assert "Solving environment" in result
        assert "Preparing transaction" in result
        assert "Executing transaction" in result

    def test_download_progress_collapsed(self) -> None:
        result = _apply(self.CONDA, stdout=self._INSTALL_OUTPUT, argv=["conda", "install", "numpy"])
        # Individual progress bar lines should not appear literally.
        # The collapse note must mention downloads.
        assert "collapsed" in result.lower()

    def test_error_lines_preserved(self) -> None:
        out = self._INSTALL_OUTPUT + "\nCondaError: package not found"
        result = _apply(self.CONDA, stdout=out, argv=["conda", "install", "numpy"])
        assert "CondaError" in result

    def test_pkg_install_lines_collapsed(self) -> None:
        lines = [
            "Solving environment: done",
            "Preparing transaction: done",
            "  - numpy 1.24.0 py311 0",
            "  - mkl 2023.1 0",
            "  - blas 1.0 0",
            "Executing transaction: done",
        ]
        out = "\n".join(lines)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "install", "numpy"])
        # Package install lines (  - pkg ver) should be collapsed.
        assert "collapsed 3 package install lines" in result
        assert "  - numpy" not in result


class TestCondaFilterList:
    """CondaFilter compresses conda list output."""

    CONDA = bc.CondaFilter()

    def _make_list_output(self, n: int) -> str:
        header = "# packages in environment at /opt/conda:\n# Name                    Version\n"
        pkgs = "\n".join(f"package-{i:03d}            1.{i}           py311" for i in range(n))
        return header + pkgs

    def test_short_list_passthrough(self) -> None:
        out = self._make_list_output(30)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "list"])
        assert "package-000" in result
        assert "package-029" in result

    def test_long_list_truncated(self) -> None:
        out = self._make_list_output(60)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "list"])
        assert "package-000" in result
        assert "package-019" in result
        assert "package-020" not in result
        assert "40 more packages" in result

    def test_header_comments_preserved(self) -> None:
        out = self._make_list_output(60)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "list"])
        assert "# packages in environment" in result


class TestCondaFilterEnvExport:
    """CondaFilter compresses conda env export YAML."""

    CONDA = bc.CondaFilter()

    def _make_export(self, n_deps: int) -> str:
        lines = [
            "name: myenv",
            "channels:",
            "  - defaults",
            "dependencies:",
        ]
        lines += [f"  - package-{i}=1.{i}=py311" for i in range(n_deps)]
        lines += ["prefix: /opt/conda/envs/myenv"]
        return "\n".join(lines)

    def test_short_export_passthrough(self) -> None:
        out = self._make_export(30)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "env", "export"])
        assert "package-0" in result
        assert "package-29" in result

    def test_long_export_truncated(self) -> None:
        out = self._make_export(60)
        result = _apply(self.CONDA, stdout=out, argv=["conda", "env", "export"])
        assert "  - package-0" in result
        assert "  - package-19" in result
        assert "  - package-20" not in result
        assert "40 more dependencies" in result


# ---------------------------------------------------------------------------
# PnpmFilter
# ---------------------------------------------------------------------------


class TestPnpmFilterMatches:
    """PnpmFilter.matches() only fires on pnpm."""

    PNPM = bc.PnpmFilter()

    def test_matches_pnpm_install(self) -> None:
        assert self.PNPM.matches(["pnpm", "install"])

    def test_matches_pnpm_add(self) -> None:
        assert self.PNPM.matches(["pnpm", "add", "express"])

    def test_matches_pnpm_run(self) -> None:
        assert self.PNPM.matches(["pnpm", "run", "build"])

    def test_no_match_npm(self) -> None:
        assert not self.PNPM.matches(["npm", "install"])

    def test_no_match_yarn(self) -> None:
        assert not self.PNPM.matches(["yarn"])

    def test_no_match_empty(self) -> None:
        assert not self.PNPM.matches([])


class TestPnpmFilterInstall:
    """PnpmFilter compresses pnpm install output."""

    PNPM = bc.PnpmFilter()

    _INSTALL_OUTPUT = "\n".join([
        "Packages: +42",
        "++++++++++++++++++++++++++++++++",
        "Progress: resolved 42, reused 38, downloaded 4, added 42, done",
        "",
        "dependencies:",
        "+ express 4.18.2",
        "",
        "Done in 3.5s",
    ])

    def test_packages_summary_kept(self) -> None:
        result = _apply(self.PNPM, stdout=self._INSTALL_OUTPUT, argv=["pnpm", "install"])
        assert "Packages:" in result

    def test_already_up_to_date_kept(self) -> None:
        out = "Already up to date\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "install"])
        assert "Already up to date" in result

    def test_progress_lines_collapsed(self) -> None:
        lines = [
            "Packages: +10",
            "Progress: resolved 10, reused 0, downloaded 10, added 10, done",
            "Resolving: 5/10",
            "Resolving: 10/10",
            "Downloading: 3/10",
            "Downloading: 10/10",
            "Done in 2s",
        ]
        out = "\n".join(lines)
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "install"])
        # Progress lines should be collapsed into a note.
        assert "collapsed" in result.lower() or "Resolving: 5/10" not in result

    def test_error_lines_preserved(self) -> None:
        out = "Packages: +5\n\nERR! ENOENT missing package.json\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "install"])
        assert "ERR!" in result or "ENOENT" in result

    def test_lockfile_notice_kept(self) -> None:
        out = "Packages: +5\nLockfile is up to date, resolution step is skipped\nDone in 1s\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "install"])
        assert "Lockfile" in result


class TestPnpmFilterRun:
    """PnpmFilter labels pnpm run output."""

    PNPM = bc.PnpmFilter()

    def test_run_label_prepended(self) -> None:
        out = "vite v4.5.0\nServer running at http://localhost:5173\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "run", "dev"])
        assert "pnpm run dev:" in result

    def test_run_rest_kept(self) -> None:
        out = "first line\nsecond line\nthird line\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "run", "build"])
        assert "second line" in result
        assert "third line" in result


class TestPnpmFilterExec:
    """PnpmFilter passes exec/dlx output through unchanged."""

    PNPM = bc.PnpmFilter()

    def test_exec_output_passed_through(self) -> None:
        out = "src/index.ts:10:1 error  Parsing error: Unexpected token\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "exec", "eslint", "src/"])
        assert "Parsing error" in result

    def test_dlx_output_passed_through(self) -> None:
        out = "create-react-app my-app\nSuccess! Created my-app\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "dlx", "create-react-app", "my-app"])
        assert "Success! Created my-app" in result

    def test_exec_no_pnpm_install_note(self) -> None:
        out = "lint passed\n"
        result = _apply(self.PNPM, stdout=out, argv=["pnpm", "exec", "biome", "check"])
        assert "collapsed" not in result.lower()


class TestPnpmFilterMatchesExe:
    """PnpmFilter.matches() handles .exe suffixes via Path.stem."""

    PNPM = bc.PnpmFilter()

    def test_matches_pnpm_exe(self) -> None:
        assert self.PNPM.matches(["pnpm.exe", "install"])


# ---------------------------------------------------------------------------
# YarnFilter
# ---------------------------------------------------------------------------


class TestYarnFilterMatches:
    """YarnFilter.matches() only fires on yarn."""

    YARN = bc.YarnFilter()

    def test_matches_yarn_install(self) -> None:
        assert self.YARN.matches(["yarn", "install"])

    def test_matches_yarn_bare(self) -> None:
        assert self.YARN.matches(["yarn"])

    def test_matches_yarn_add(self) -> None:
        assert self.YARN.matches(["yarn", "add", "lodash"])

    def test_no_match_pnpm(self) -> None:
        assert not self.YARN.matches(["pnpm", "install"])

    def test_no_match_npm(self) -> None:
        assert not self.YARN.matches(["npm", "install"])

    def test_no_match_empty(self) -> None:
        assert not self.YARN.matches([])


class TestYarnFilterClassic:
    """YarnFilter compresses yarn classic (v1) install output."""

    YARN = bc.YarnFilter()

    _CLASSIC_OUTPUT = "\n".join([
        "yarn install v1.22.19",
        "[1/4] Resolving packages...",
        "[2/4] Fetching packages...",
        "  Fetching lodash@4.17.21",
        "  Fetching express@4.18.2",
        "  Fetching mime@1.6.0",
        "[3/4] Linking dependencies...",
        "[4/4] Building fresh packages...",
        "Done in 12.34s.",
    ])

    def test_banner_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._CLASSIC_OUTPUT, argv=["yarn", "install"])
        assert "yarn install v1.22.19" in result

    def test_phase_headers_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._CLASSIC_OUTPUT, argv=["yarn", "install"])
        assert "[1/4] Resolving packages" in result
        assert "[3/4] Linking dependencies" in result

    def test_fetch_phase_marker_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._CLASSIC_OUTPUT, argv=["yarn", "install"])
        assert "[2/4] Fetching packages" in result

    def test_individual_fetch_lines_collapsed(self) -> None:
        result = _apply(self.YARN, stdout=self._CLASSIC_OUTPUT, argv=["yarn", "install"])
        # Individual fetch lines inside [2/4] phase should not appear.
        assert "Fetching lodash@4.17.21" not in result
        # A collapse note should mention them.
        assert "collapsed" in result.lower()

    def test_done_line_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._CLASSIC_OUTPUT, argv=["yarn", "install"])
        assert "Done in 12.34s" in result

    def test_warning_deduplication(self) -> None:
        out = "\n".join([
            "yarn install v1.22.19",
            "warning lodash@4.17.21: This package is deprecated",
            "warning lodash@4.17.21: This package is deprecated",
            "warning lodash@4.17.21: This package is deprecated",
            "Done in 1s.",
        ])
        result = _apply(self.YARN, stdout=out, argv=["yarn", "install"])
        # First warning kept; duplicates removed.
        assert "warning lodash" in result
        count = result.count("warning lodash")
        assert count == 1
        assert "deduplicated" in result.lower()

    def test_error_preserved(self) -> None:
        out = self._CLASSIC_OUTPUT + "\nerror Command failed with exit code 1."
        result = _apply(self.YARN, stdout=out, argv=["yarn", "install"])
        assert "error Command failed" in result


class TestYarnFilterBerry:
    """YarnFilter compresses yarn berry (v2+) install output."""

    YARN = bc.YarnFilter()

    _BERRY_OUTPUT = "\n".join([
        "➤ YN0000: · Yarn 3.6.3",
        "➤ YN0000: ┌ Resolution step",
        "➤ YN0032: │ lodash@npm:4.17.21 can be deduped...",
        "➤ YN0000: └ Completed in 0.42s",
        "➤ YN0000: ┌ Fetch step",
        "➤ YN0013: │ lodash@npm:4.17.21 can't be found in the cache and will be fetched from the remote registry 100KB",
        "➤ YN0013: │ express@npm:4.18.2 fetched 200KB 2/5",
        "➤ YN0013: │ mime@npm:1.6.0 fetched 10KB 5/5",
        "➤ YN0000: └ Completed in 2.1s",
        "➤ YN0000: ┌ Link step",
        "➤ YN0000: └ Completed",
        "➤ YN0000: · Done in 3.5s",
    ])

    def test_done_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._BERRY_OUTPUT, argv=["yarn", "install"])
        assert "Done in 3.5s" in result

    def test_resolution_header_kept(self) -> None:
        result = _apply(self.YARN, stdout=self._BERRY_OUTPUT, argv=["yarn", "install"])
        assert "Resolution step" in result

    def test_fetch_progress_collapsed(self) -> None:
        result = _apply(self.YARN, stdout=self._BERRY_OUTPUT, argv=["yarn", "install"])
        # Lines with byte counts (YN0013 with sizes) should be collapsed.
        assert "collapsed" in result.lower()

    def test_yn0001_error_kept(self) -> None:
        out = self._BERRY_OUTPUT + "\n➤ YN0001: · Error: something went wrong"
        result = _apply(self.YARN, stdout=out, argv=["yarn", "install"])
        assert "YN0001" in result


# ---------------------------------------------------------------------------
# Dispatch: new filters reached via select_filter
# ---------------------------------------------------------------------------


class TestDispatch:
    """New filters are reachable from the FILTERS registry."""

    def test_pnpm_install_dispatches_to_npm_install_filter(self) -> None:
        f = bc.select_filter(["pnpm", "install"])
        assert f is not None
        assert f.name == "npm_install"

    def test_pnpm_run_dispatches_to_pnpm_filter(self) -> None:
        # "run" must NOT strip via _TWO_TOKEN_PREFIXES — PnpmFilter must handle it.
        f = bc.select_filter(["pnpm", "run", "dev"])
        assert f is not None
        assert f.name == "pnpm"

    def test_pnpm_exec_wrapped_tool_dispatches_to_tool_filter(self) -> None:
        f = bc.select_filter(["pnpm", "exec", "eslint", "src/"])
        assert f is not None
        assert f.name == "eslint"

    def test_yarn_install_dispatches_to_npm_install_filter(self) -> None:
        f = bc.select_filter(["yarn", "install"])
        assert f is not None
        assert f.name == "npm_install"

    def test_yarn_run_dispatches_to_yarn_filter(self) -> None:
        # "run" must NOT strip via _TWO_TOKEN_PREFIXES — YarnFilter must handle it.
        f = bc.select_filter(["yarn", "run", "build"])
        assert f is not None
        assert f.name == "yarn"

    def test_conda_dispatches_to_conda_filter(self) -> None:
        f = bc.select_filter(["conda", "install", "numpy"])
        assert f is not None
        assert f.name == "conda"

    def test_mamba_dispatches_to_conda_filter(self) -> None:
        f = bc.select_filter(["mamba", "install", "scipy"])
        assert f is not None
        assert f.name == "conda"

    def test_uv_pip_freeze_dispatches_to_dep_list_filter(self) -> None:
        # DepListFilter precedes UvFilter in FILTERS and claims ``uv pip freeze``
        # because "freeze" is in DepListFilter.subcommands.
        f = bc.select_filter(["uv", "pip", "freeze"])
        assert f is not None
        assert f.name == "dep-list"

    def test_uv_pip_list_dispatches_to_dep_list_filter(self) -> None:
        # DepListFilter precedes UvFilter in FILTERS and claims ``uv pip list``
        # because "list" is in DepListFilter.subcommands.
        f = bc.select_filter(["uv", "pip", "list"])
        assert f is not None
        assert f.name == "dep-list"

    def test_npm_still_dispatches_to_npm_filter(self) -> None:
        f = bc.select_filter(["npm", "install"])
        assert f is not None
        assert f.name == "npm_install"
