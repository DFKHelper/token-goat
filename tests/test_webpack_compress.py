"""Tests for WebpackFilter: webpack / vite build / esbuild compression.

Covers:
  - TestWebpackFilterMatches — matches() for direct, npx, pnpx, bunx, vite build, esbuild; negatives
  - TestWebpackFilterSelectFilter — select_filter() dispatch
  - TestCompressWebpack — webpack module-line suppression, asset-line preservation, errors kept
  - TestCompressVite — vite progress suppression, asset table and summary kept
  - TestCompressEsbuild — esbuild passthrough (already minimal)
  - Regression: vite dev (not build) must NOT match; webpack with no node_modules noise passes through
"""
from __future__ import annotations

import pytest
from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Shared filter instance
# ---------------------------------------------------------------------------


class TestWebpackFilterMatches:
    """Verify WebpackFilter.matches() for all supported invocation forms."""

    F = bc.WebpackFilter()

    # --- Direct webpack invocations ----------------------------------------

    def test_webpack_direct(self) -> None:
        assert self.F.matches(["webpack"])

    def test_webpack_cli_direct(self) -> None:
        assert self.F.matches(["webpack-cli", "--config", "webpack.prod.js"])

    def test_webpack_exe(self) -> None:
        assert self.F.matches(["webpack.exe", "--mode", "production"])

    def test_webpack_cmd(self) -> None:
        assert self.F.matches(["webpack.cmd"])

    def test_webpack_path_prefix(self) -> None:
        assert self.F.matches(["./node_modules/.bin/webpack", "--mode", "production"])

    # --- esbuild -----------------------------------------------------------

    def test_esbuild_direct(self) -> None:
        assert self.F.matches(["esbuild", "src/index.ts", "--bundle", "--outfile=dist/out.js"])

    def test_esbuild_exe(self) -> None:
        assert self.F.matches(["esbuild.exe", "src/index.ts"])

    # --- vite build (subcommand check) ------------------------------------

    def test_vite_build(self) -> None:
        assert self.F.matches(["vite", "build"])

    def test_vite_build_with_flag(self) -> None:
        assert self.F.matches(["vite", "build", "--mode", "production"])

    def test_vite_dev_not_matched(self) -> None:
        assert not self.F.matches(["vite", "dev"])

    def test_vite_serve_not_matched(self) -> None:
        assert not self.F.matches(["vite", "serve"])

    def test_vite_preview_not_matched(self) -> None:
        assert not self.F.matches(["vite", "preview"])

    def test_vite_bare_not_matched(self) -> None:
        assert not self.F.matches(["vite"])

    # --- npx / pnpx / bunx wrappers ---------------------------------------

    def test_npx_webpack(self) -> None:
        assert self.F.matches(["npx", "webpack"])

    def test_npx_webpack_cli(self) -> None:
        assert self.F.matches(["npx", "webpack-cli", "--mode", "production"])

    def test_npx_esbuild(self) -> None:
        assert self.F.matches(["npx", "esbuild", "src/app.ts"])

    def test_npx_vite_build(self) -> None:
        assert self.F.matches(["npx", "vite", "build"])

    def test_npx_yes_webpack(self) -> None:
        assert self.F.matches(["npx", "--yes", "webpack"])

    def test_pnpx_webpack(self) -> None:
        assert self.F.matches(["pnpx", "webpack"])

    def test_bunx_webpack(self) -> None:
        assert self.F.matches(["bunx", "webpack-cli"])

    def test_npx_vite_dev_not_matched(self) -> None:
        assert not self.F.matches(["npx", "vite", "dev"])

    def test_npx_vite_serve_not_matched(self) -> None:
        assert not self.F.matches(["npx", "vite", "serve"])

    # --- npx flag handling: --package/-p consume next token; all-flags runs off end ---

    def test_npx_package_flag_consumes_next_token(self) -> None:
        # --package <pkg> consumes its value, so the next positional is the real tool.
        # The package name must NOT itself be in the webpack match set, otherwise the
        # test would still pass if pair-consumption were removed (the scan would stop at
        # the package name and match for the wrong reason).
        assert self.F.matches(["npx", "--package", "some-pkg", "webpack", "--mode", "production"])

    def test_npx_p_flag_consumes_next_token(self) -> None:
        # -p is the short form of --package and also consumes the following token.
        # Use a package name outside the webpack match set so the assertion only holds
        # when -p actually consumes it and the scan reaches the real `webpack` tool.
        assert self.F.matches(["npx", "-p", "my-plugin", "webpack"])

    def test_npx_package_flag_vite_build(self) -> None:
        assert self.F.matches(["npx", "--package", "vite", "vite", "build"])

    def test_npx_package_flag_vite_dev_not_matched(self) -> None:
        assert not self.F.matches(["npx", "--package", "vite", "vite", "dev"])

    def test_npx_only_flags_no_tool_not_matched(self) -> None:
        # Every token after npx is a flag, so the scan runs off the end -> no match.
        assert not self.F.matches(["npx", "--yes"])

    def test_npx_package_flag_consumes_last_token_not_matched(self) -> None:
        # --package consumes the final token, leaving no tool name behind -> no match.
        assert not self.F.matches(["npx", "--package", "webpack"])

    # --- Flag-value leak: _positional_args treats a flag's value as positional ---

    def test_vite_flag_value_before_build_not_matched(self) -> None:
        # `--config vite.config.js` leaks `vite.config.js` as the first positional, so
        # `build` is no longer positionals[0]. Documents actual (non-ideal) behavior.
        assert not self.F.matches(["vite", "--config", "vite.config.js", "build"])

    # --- Negatives --------------------------------------------------------

    def test_npm_not_matched(self) -> None:
        assert not self.F.matches(["npm", "run", "build"])

    def test_node_not_matched(self) -> None:
        assert not self.F.matches(["node", "webpack.js"])

    def test_vitest_not_matched(self) -> None:
        assert not self.F.matches(["vitest"])

    def test_jest_not_matched(self) -> None:
        assert not self.F.matches(["jest"])

    def test_empty_not_matched(self) -> None:
        assert not self.F.matches([])


# ---------------------------------------------------------------------------
# _invokes_vite_build predicate (direct unit coverage)
# ---------------------------------------------------------------------------


class TestInvokesViteBuild:
    """Direct unit coverage for the `_invokes_vite_build` subcommand predicate.

    The helper inspects the tokens *after* the ``vite`` binary and returns True
    only when the first positional argument is ``build``. Flag values that are
    not attached with ``=`` leak into the positional list (see ``_positional_args``),
    which the leak cases below pin as the actual behavior.
    """

    @pytest.mark.parametrize(
        ("args_after_vite", "expected"),
        [
            ([], False),  # bare `vite`: no subcommand
            (["build"], True),  # `vite build`
            (["dev"], False),  # `vite dev`
            (["serve"], False),  # `vite serve`
            (["preview"], False),  # `vite preview`
            (["optimize"], False),  # unrelated subcommand
            (["build", "--mode", "production"], True),  # trailing flags ignored
            (["--force", "build"], True),  # boolean flag (no value) skipped, build is positionals[0]
            (["--mode", "production", "build"], False),  # `production` leaks as positionals[0]
            (["--config", "vite.config.js", "build"], False),  # flag value leaks as positionals[0]
        ],
    )
    def test_invokes_vite_build(self, args_after_vite: list[str], expected: bool) -> None:
        assert bc._invokes_vite_build(args_after_vite) is expected


# ---------------------------------------------------------------------------
# select_filter dispatch
# ---------------------------------------------------------------------------


class TestWebpackFilterSelectFilter:
    def test_select_webpack(self) -> None:
        assert isinstance(bc.select_filter(["webpack", "--mode", "production"]), bc.WebpackFilter)

    def test_select_webpack_cli(self) -> None:
        assert isinstance(bc.select_filter(["webpack-cli"]), bc.WebpackFilter)

    def test_select_esbuild(self) -> None:
        assert isinstance(bc.select_filter(["esbuild", "src/index.ts"]), bc.WebpackFilter)

    def test_select_vite_build(self) -> None:
        assert isinstance(bc.select_filter(["vite", "build"]), bc.WebpackFilter)

    def test_select_vite_build_filter_name_is_webpack(self) -> None:
        # `vite build` must dispatch to the filter registered under name "webpack".
        f = bc.select_filter(["vite", "build"])
        assert f is not None
        assert f.name == "webpack"

    def test_vite_dev_not_webpack_filter(self) -> None:
        result = bc.select_filter(["vite", "dev"])
        assert not isinstance(result, bc.WebpackFilter)

    def test_npx_webpack_routes_to_webpack_filter(self) -> None:
        # npx webpack must resolve to WebpackFilter, NOT NodePackageFilter
        result = bc.select_filter(["npx", "webpack"])
        assert isinstance(result, bc.WebpackFilter)


# ---------------------------------------------------------------------------
# Webpack build output compression
# ---------------------------------------------------------------------------

_WEBPACK_SMALL = """\
asset main.bundle.js 1.23 MiB [emitted] (name: main) [big]
asset index.html 1.23 KiB [emitted]
webpack 5.89.0 compiled successfully in 3421 ms
"""

_WEBPACK_LARGE = """\
asset main.bundle.js 1.23 MiB [emitted] (name: main) [big]
asset chunk.1a2b3c.js 456 KiB [emitted]
asset index.html 1.23 KiB [emitted]
runtime modules 3.77 KiB 10 modules
modules by path ./node_modules/ 1.23 MiB
  modules by path ./node_modules/react/ 45 KiB
    ./node_modules/react/index.js 190 bytes [built] [code generated]
    ./node_modules/react/cjs/react.development.js 45.4 KiB [built] [code generated]
  + 12 modules
  modules by path ./node_modules/lodash-es/ 234 KiB
    ./node_modules/lodash-es/chunk.js 12 KiB [built] [code generated]
    + 100 modules
modules by path ./src/ 45 KiB
  ./src/index.js 1.23 KiB [built] [code generated]
  ./src/App.js 5.67 KiB [built] [code generated]
  + 5 modules
webpack 5.89.0 compiled successfully in 12345 ms
"""

_WEBPACK_WITH_ERROR = """\
asset main.bundle.js 10 KiB [emitted]
runtime modules 3.77 KiB 5 modules
modules by path ./node_modules/ 456 KiB
  ./node_modules/react/index.js 190 bytes [built] [code generated]
  + 10 modules
ERROR in ./src/missing.js
Module not found: Error: Can't resolve './missing'
webpack 5.89.0 compiled with 1 error in 1234 ms
"""

_WEBPACK_WITH_WARNING = """\
asset main.bundle.js 1.5 MiB [emitted] [big]
runtime modules 2 KiB 4 modules
modules by path ./node_modules/ 900 KiB
  + 200 modules
WARNING in asset size limit: The following asset(s) exceed the recommended size limit (244 KiB).
webpack 5.89.0 compiled with 1 warning in 5678 ms
"""


class TestCompressWebpack:
    F = bc.WebpackFilter()

    def test_node_modules_lines_suppressed(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "./node_modules/react/index.js" not in out
        assert "./node_modules/lodash-es/chunk.js" not in out

    def test_plus_modules_lines_suppressed(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "+ 12 modules" not in out
        assert "+ 100 modules" not in out
        assert "+ 5 modules" not in out

    def test_runtime_modules_line_suppressed(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "runtime modules 3.77 KiB" not in out

    def test_asset_lines_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "asset main.bundle.js" in out
        assert "1.23 MiB" in out

    def test_summary_line_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "webpack 5.89.0 compiled successfully" in out

    def test_src_module_section_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "modules by path ./src/" in out

    def test_compression_note_added(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert "token-goat" in out
        assert "node_modules" in out.lower() or "dropped" in out

    def test_lines_removed_count(self) -> None:
        # Large output must be shorter than input
        out = _compress(self.F, stdout=_WEBPACK_LARGE, argv=["webpack"])
        assert len(out.split("\n")) < len(_WEBPACK_LARGE.split("\n"))

    def test_error_lines_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_WITH_ERROR, argv=["webpack"])
        assert "ERROR in ./src/missing.js" in out
        assert "Module not found" in out

    def test_error_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_WITH_ERROR, argv=["webpack"])
        assert "compiled with 1 error" in out

    def test_warning_lines_kept(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_WITH_WARNING, argv=["webpack"])
        assert "WARNING in asset size limit" in out

    def test_small_output_passthrough(self) -> None:
        out = _compress(self.F, stdout=_WEBPACK_SMALL, argv=["webpack"])
        assert "main.bundle.js" in out
        assert "compiled successfully" in out

    def test_empty_input(self) -> None:
        out = _compress(self.F, stdout="", stderr="", argv=["webpack"])
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# Vite build output compression
# ---------------------------------------------------------------------------

_VITE_COMPACT = """\
vite v5.2.0 building for production...
✓ 234 modules transformed.
dist/index.html                   0.46 kB │ gzip:  0.30 kB
dist/assets/index-DiwrgTda.css    1.39 kB │ gzip:  0.72 kB
dist/assets/index-DVoHNO1Y.js   143.36 kB │ gzip: 46.04 kB
✓ built in 1.23s
"""

_VITE_WITH_PROGRESS = """\
vite v5.2.0 building for production...
transforming (1) node_modules/.vite/deps/react.js
transforming (50) src/components/Button.tsx
transforming (100) src/components/Modal.tsx
transforming (150) node_modules/react-dom/index.js
transforming (200) src/pages/Home.tsx
transforming (234) ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 75% [175/234] src/utils/format.ts
rendering chunks (3)...
computing gzip size (3)...
✓ 234 modules transformed.
dist/index.html                   0.46 kB │ gzip:  0.30 kB
dist/assets/index-DVoHNO1Y.js   143.36 kB │ gzip: 46.04 kB
✓ built in 2.34s
"""

_VITE_ERROR = """\
vite v5.2.0 building for production...
transforming (10) src/index.ts
✗ Build failed in 0.23s
src/missing.ts (1:8): Cannot find module './missing'
"""


class TestCompressVite:
    F = bc.WebpackFilter()

    def test_transforming_lines_dropped(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "transforming (1)" not in out
        assert "transforming (234)" not in out

    def test_rendering_chunks_dropped(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "rendering chunks" not in out

    def test_computing_gzip_dropped(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "computing gzip size" not in out

    def test_header_kept(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "vite v5.2.0 building for production" in out

    def test_modules_transformed_kept(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "✓ 234 modules transformed" in out

    def test_asset_table_kept(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "dist/assets/index-DVoHNO1Y.js" in out

    def test_built_in_summary_kept(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "built in 2.34s" in out

    def test_note_appended_when_progress_dropped(self) -> None:
        out = _compress(self.F, stdout=_VITE_WITH_PROGRESS, argv=["vite", "build"])
        assert "token-goat" in out
        assert "progress" in out or "transform" in out or "dropped" in out

    def test_compact_output_unchanged(self) -> None:
        out = _compress(self.F, stdout=_VITE_COMPACT, argv=["vite", "build"])
        assert "vite v5.2.0" in out
        assert "234 modules transformed" in out
        assert "built in 1.23s" in out

    def test_error_output_preserved(self) -> None:
        out = _compress(self.F, stdout=_VITE_ERROR, argv=["vite", "build"])
        assert "Build failed" in out or "Cannot find module" in out


# ---------------------------------------------------------------------------
# esbuild passthrough
# ---------------------------------------------------------------------------

_ESBUILD_OUT = """\
  dist/bundle.js    12.3kb

⚡ Done in 150ms
"""


class TestCompressEsbuild:
    F = bc.WebpackFilter()

    def test_esbuild_passthrough(self) -> None:
        out = _compress(self.F, stdout=_ESBUILD_OUT, argv=["esbuild", "src/index.ts"])
        assert "dist/bundle.js" in out
        assert "Done in 150ms" in out

    def test_esbuild_empty(self) -> None:
        out = _compress(self.F, stdout="", stderr="", argv=["esbuild"])
        assert out == "" or out.strip() == ""


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestWebpackRegressions:
    F = bc.WebpackFilter()

    def test_webpack_output_without_node_modules_noise_unchanged(self) -> None:
        """When there are no node_modules module lines, output is not mutated."""
        clean = "asset main.js 5 KiB [emitted]\nwebpack 5.89.0 compiled successfully in 100 ms\n"
        out = _compress(self.F, stdout=clean, argv=["webpack"])
        assert "main.js" in out
        assert "compiled successfully" in out

    def test_vite_dev_does_not_match_filter(self) -> None:
        """vite dev / vite serve must not route to WebpackFilter."""
        assert not bc.WebpackFilter().matches(["vite", "serve"])
        assert not bc.WebpackFilter().matches(["vite"])

    def test_npx_vite_dev_does_not_match(self) -> None:
        """npx vite dev must not route to WebpackFilter."""
        assert not bc.WebpackFilter().matches(["npx", "vite", "dev"])

    def test_error_exit_code_still_compresses(self) -> None:
        """Even on failure, webpack module noise must be removed."""
        out = _compress(
            self.F,
            stdout=_WEBPACK_WITH_ERROR,
            exit_code=1,
            argv=["webpack"],
        )
        assert "./node_modules/react/index.js" not in out
        assert "ERROR in ./src/missing.js" in out

    @pytest.mark.parametrize("name", ["webpack", "webpack-cli", "vite", "esbuild"])
    def test_name_in_binaries(self, name: str) -> None:
        assert name in bc.WebpackFilter.binaries

    def test_webpack_filter_in_registry(self) -> None:
        """WebpackFilter must appear in the FILTERS list."""
        assert any(isinstance(f, bc.WebpackFilter) for f in bc.FILTERS)

    def test_webpack_filter_precedes_node_package_filter(self) -> None:
        """WebpackFilter must come before NodePackageFilter in FILTERS."""
        webpack_idx = next(i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.WebpackFilter))
        npm_idx = next(i for i, f in enumerate(bc.FILTERS) if isinstance(f, bc.NodePackageFilter))
        assert webpack_idx < npm_idx

    def test_node_modules_error_line_kept(self) -> None:
        """Regression: node_modules lines containing [1 error] must not be suppressed.

        _WEBPACK_MODULE_LINE_RE matches ``  ./node_modules/...`` lines, but lines
        that also contain error annotations must pass through so the developer
        can identify which package failed.
        """
        output = (
            "modules by path ./node_modules/ 1.23 KiB\n"
            "  ./node_modules/broken-dep/index.js 512 bytes [built] [1 error]\n"
            "  ./node_modules/ok-dep/index.js 128 bytes [built]\n"
            "asset main.js 5 KiB [emitted]\n"
            "webpack 5.89.0 compiled with 1 error in 1234 ms\n"
        )
        out = _compress(self.F, stdout=output, argv=["webpack"])
        # The error-annotated node_modules line must survive
        assert "./node_modules/broken-dep/index.js" in out
        assert "[1 error]" in out
        # Non-error node_modules line must still be suppressed
        assert "./node_modules/ok-dep/index.js" not in out

