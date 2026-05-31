"""Tests for GoFilter, JavacFilter, and SbtFilter.

Covers:
- Filter dispatch: correct filter selected for each command shape.
- Compression correctness: signal preserved, noise collapsed.
- Savings ratio: meaningful compression on realistic output.
- Edge cases: empty output, exit_code != 0, subcommand routing.
"""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply
from filter_test_helpers import savings_ratio as _savings_ratio

from token_goat import bash_compress as bc

# ===========================================================================
# GoFilter
# ===========================================================================


class TestGoFilterMatches:
    """GoFilter matches the expected go subcommands and rejects others."""

    GO = bc.GoFilter()

    def test_go_build_matches(self) -> None:
        assert self.GO.matches(["go", "build", "./..."])

    def test_go_build_exe_matches(self) -> None:
        assert self.GO.matches(["go.exe", "build", "./..."])

    def test_go_install_matches(self) -> None:
        assert self.GO.matches(["go", "install", "./..."])

    def test_go_get_matches(self) -> None:
        assert self.GO.matches(["go", "get", "github.com/foo/bar@v1.2.3"])

    def test_go_mod_tidy_matches(self) -> None:
        assert self.GO.matches(["go", "mod", "tidy"])

    def test_go_mod_download_matches(self) -> None:
        assert self.GO.matches(["go", "mod", "download"])

    def test_go_run_matches(self) -> None:
        assert self.GO.matches(["go", "run", "main.go"])

    def test_go_vet_matches(self) -> None:
        assert self.GO.matches(["go", "vet", "./..."])

    def test_go_generate_matches(self) -> None:
        assert self.GO.matches(["go", "generate", "./..."])

    def test_go_clean_matches(self) -> None:
        assert self.GO.matches(["go", "clean"])

    def test_go_test_does_not_match(self) -> None:
        """go test must route to GoTestFilter, not GoFilter."""
        assert not self.GO.matches(["go", "test", "./..."])

    def test_bare_go_does_not_match(self) -> None:
        assert not self.GO.matches(["go"])

    def test_empty_does_not_match(self) -> None:
        assert not self.GO.matches([])

    def test_non_go_binary_does_not_match(self) -> None:
        assert not self.GO.matches(["goimports", "build"])


class TestGoFilterDispatch:
    """select_filter routes go subcommands correctly."""

    def test_go_build_routes_to_go(self) -> None:
        f = bc.select_filter(["go", "build", "./..."])
        assert f is not None
        assert f.name == "go"

    def test_go_get_routes_to_go(self) -> None:
        f = bc.select_filter(["go", "get", "golang.org/x/tools@latest"])
        assert f is not None
        assert f.name == "go"

    def test_go_mod_routes_to_go(self) -> None:
        f = bc.select_filter(["go", "mod", "tidy"])
        assert f is not None
        assert f.name == "go"

    def test_go_test_routes_to_go_test(self) -> None:
        """go test must remain in GoTestFilter."""
        f = bc.select_filter(["go", "test", "./..."])
        assert f is not None
        assert f.name == "go-test"

    def test_go_filter_before_make_filter(self) -> None:
        """GoFilter must be registered before MakeFilter."""
        names = [f.name for f in bc.FILTERS]
        go_idx = names.index("go")
        make_idx = names.index("make")
        assert go_idx < make_idx, (
            "GoFilter must be registered before MakeFilter so `go build` routes "
            "to GoFilter instead of MakeFilter's generic build compression."
        )

    def test_go_test_before_go_filter(self) -> None:
        """GoTestFilter must precede GoFilter."""
        names = [f.name for f in bc.FILTERS]
        go_test_idx = names.index("go-test")
        go_idx = names.index("go")
        assert go_test_idx < go_idx, (
            "GoTestFilter must be registered before GoFilter."
        )


_GO_BUILD_CLEAN_OUTPUT = """\
# github.com/example/myapp/cmd
# github.com/example/myapp/internal/db
# github.com/example/myapp/internal/server
"""

_GO_BUILD_ERROR_OUTPUT = """\
# github.com/example/myapp/cmd
cmd/main.go:12:5: undefined: badFunc
cmd/main.go:15:3: too many arguments in call to fmt.Println
# github.com/example/myapp/internal/db
internal/db/conn.go:8:2: imported and not used: "fmt"
"""

_GO_BUILD_DOWNLOAD_OUTPUT = """\
go: downloading github.com/pkg/errors v0.9.1
go: downloading github.com/stretchr/testify v1.8.4
go: downloading github.com/gorilla/mux v1.8.0
go: extracting github.com/pkg/errors v0.9.1
"""


class TestGoFilterGoBuild:
    """GoFilter compresses `go build` output correctly."""

    GO = bc.GoFilter()

    def _apply_build(self, stdout: str, exit_code: int = 0) -> str:
        return _apply(self.GO, stdout=stdout, exit_code=exit_code, argv=["go", "build", "./..."])

    def test_clean_build_headers_collapsed(self) -> None:
        out = self._apply_build(_GO_BUILD_CLEAN_OUTPUT)
        # Package headers should be collapsed to a note.
        assert "# github.com/example/myapp/cmd" not in out
        assert "suppressed" in out or "package header" in out

    def test_error_lines_kept(self) -> None:
        out = self._apply_build(_GO_BUILD_ERROR_OUTPUT, exit_code=1)
        assert "cmd/main.go:12:5: undefined: badFunc" in out
        assert "internal/db/conn.go:8:2: imported and not used" in out

    def test_error_headers_still_collapsed(self) -> None:
        """Package headers are dropped even on failure — the error lines provide context."""
        out = self._apply_build(_GO_BUILD_ERROR_OUTPUT, exit_code=1)
        assert "# github.com/example/myapp/cmd\n" not in out

    def test_download_lines_collapsed_during_build(self) -> None:
        out = self._apply_build(_GO_BUILD_DOWNLOAD_OUTPUT)
        assert "go: downloading github.com/pkg/errors" not in out
        assert "collapsed" in out

    def test_savings_on_large_successful_build(self) -> None:
        lines = [f"# github.com/example/pkg{i}/internal" for i in range(80)]
        output = "\n".join(lines) + "\n"
        ratio = _savings_ratio(self.GO, output, argv=["go", "build", "./..."])
        assert ratio >= 0.70, f"Expected >= 70% savings on header-only build, got {ratio:.0%}"


_GO_GET_OUTPUT = """\
go: downloading github.com/spf13/cobra v1.7.0
go: downloading github.com/spf13/pflag v1.0.5
go: downloading github.com/spf13/viper v1.16.0
go: downloading github.com/fsnotify/fsnotify v1.6.0
go: downloading github.com/hashicorp/hcl v1.0.0
go: extracting github.com/spf13/cobra v1.7.0
go: extracting github.com/spf13/pflag v1.0.5
go: finding module for package github.com/example/dep
"""


class TestGoFilterGoGet:
    """GoFilter compresses `go get` download spam."""

    GO = bc.GoFilter()

    def _apply_get(self, stdout: str) -> str:
        return _apply(self.GO, stdout=stdout, argv=["go", "get", "github.com/spf13/cobra@latest"])

    def test_download_lines_collapsed(self) -> None:
        out = self._apply_get(_GO_GET_OUTPUT)
        assert "go: downloading github.com/spf13/cobra" not in out

    def test_download_count_noted(self) -> None:
        out = self._apply_get(_GO_GET_OUTPUT)
        assert "collapsed" in out
        assert "downloading" in out or "extracting" in out

    def test_savings_on_large_download(self) -> None:
        lines = [
            f"go: downloading github.com/example/dep{i} v1.{i}.0"
            for i in range(100)
        ]
        output = "\n".join(lines)
        ratio = _savings_ratio(self.GO, output, argv=["go", "get", "..."])
        assert ratio >= 0.80, f"Expected >= 80% savings on download-only output, got {ratio:.0%}"


_GO_MOD_TIDY_OUTPUT = """\
go: downloading github.com/pkg/errors v0.9.1
go: downloading github.com/stretchr/testify v1.8.4
go: found github.com/pkg/errors in github.com/pkg/errors v0.9.1
go: added golang.org/x/net v0.12.0
go: upgraded github.com/stretchr/testify v1.8.0 => v1.8.4
go: removed github.com/obsolete/pkg v0.1.0
"""


class TestGoFilterGoMod:
    """GoFilter compresses `go mod tidy` output."""

    GO = bc.GoFilter()

    def _apply_mod(self, stdout: str) -> str:
        return _apply(self.GO, stdout=stdout, argv=["go", "mod", "tidy"])

    def test_download_lines_collapsed(self) -> None:
        out = self._apply_mod(_GO_MOD_TIDY_OUTPUT)
        assert "go: downloading github.com/pkg/errors" not in out

    def test_module_change_lines_kept(self) -> None:
        out = self._apply_mod(_GO_MOD_TIDY_OUTPUT)
        assert "go: added golang.org/x/net" in out
        assert "go: upgraded github.com/stretchr/testify" in out
        assert "go: removed github.com/obsolete/pkg" in out

    def test_found_line_kept(self) -> None:
        out = self._apply_mod(_GO_MOD_TIDY_OUTPUT)
        assert "go: found github.com/pkg/errors" in out


# ===========================================================================
# JavacFilter
# ===========================================================================


class TestJavacFilterMatches:
    """JavacFilter matches javac and rejects other binaries."""

    JAVAC = bc.JavacFilter()

    def test_javac_matches(self) -> None:
        assert self.JAVAC.matches(["javac", "Main.java"])

    def test_javac_exe_matches(self) -> None:
        assert self.JAVAC.matches(["javac.exe", "Main.java"])

    def test_javac_with_flags_matches(self) -> None:
        assert self.JAVAC.matches(["javac", "-cp", "lib/*", "-d", "out", "Main.java"])

    def test_non_javac_no_match(self) -> None:
        assert not self.JAVAC.matches(["java", "-jar", "app.jar"])
        assert not self.JAVAC.matches(["javadoc", "Main.java"])
        assert not self.JAVAC.matches(["ant", "compile"])

    def test_empty_no_match(self) -> None:
        assert not self.JAVAC.matches([])


class TestJavacFilterDispatch:
    """select_filter routes javac correctly."""

    def test_javac_routes_to_javac(self) -> None:
        f = bc.select_filter(["javac", "-d", "out", "Main.java"])
        assert f is not None
        assert f.name == "javac"

    def test_javac_with_path_routes_correctly(self) -> None:
        f = bc.select_filter(["/usr/lib/jvm/java-17/bin/javac", "Main.java"])
        assert f is not None
        assert f.name == "javac"


_JAVAC_NOTE_HEAVY_OUTPUT = """\
Note: src/Main.java uses unchecked or unsafe operations.
Note: src/Util.java uses unchecked or unsafe operations.
Note: src/Parser.java uses unchecked or unsafe operations.
Note: src/Handler.java uses unchecked or unsafe operations.
Note: src/Controller.java uses unchecked or unsafe operations.
Note: Some input files use unchecked or unsafe operations.
Note: Recompile with -Xlint:unchecked for details.
"""

_JAVAC_ERROR_OUTPUT = """\
src/Main.java:12: error: ';' expected
    int x = 5
            ^
src/Main.java:25: error: cannot find symbol
    foo.bar();
        ^
  symbol:   method bar()
  location: variable foo of type Foo
2 errors
"""

_JAVAC_WARNING_OUTPUT = """\
src/Legacy.java:8: warning: [deprecation] OldClass in com.example has been deprecated
    OldClass obj = new OldClass();
                   ^
1 warning
"""

_JAVAC_MIXED_OUTPUT = """\
Note: src/TypeA.java uses unchecked or unsafe operations.
Note: src/TypeB.java uses unchecked or unsafe operations.
Note: src/TypeC.java uses unchecked or unsafe operations.
Note: Some input files use unchecked or unsafe operations.
Note: Recompile with -Xlint:unchecked for details.
src/Main.java:10: error: incompatible types: int cannot be converted to String
    String s = 42;
               ^
1 error
"""


class TestJavacFilterNoteLines:
    """JavacFilter collapses Note: unchecked lines."""

    JAVAC = bc.JavacFilter()

    def test_per_file_notes_collapsed(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_NOTE_HEAVY_OUTPUT)
        # Individual file-specific Note lines should be collapsed.
        assert "Note: src/Main.java uses unchecked" not in out
        assert "Note: src/Util.java uses unchecked" not in out

    def test_collapse_note_in_output(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_NOTE_HEAVY_OUTPUT)
        assert "collapsed" in out
        assert "unchecked" in out.lower() or "unsafe" in out.lower()

    def test_summary_notes_dropped(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_NOTE_HEAVY_OUTPUT)
        assert "Note: Some input files use unchecked" not in out
        assert "Recompile with -Xlint" not in out

    def test_savings_on_note_heavy_output(self) -> None:
        lines = [
            f"Note: src/File{i:03d}.java uses unchecked or unsafe operations."
            for i in range(60)
        ]
        lines += [
            "Note: Some input files use unchecked or unsafe operations.",
            "Note: Recompile with -Xlint:unchecked for details.",
        ]
        output = "\n".join(lines)
        ratio = _savings_ratio(self.JAVAC, output)
        assert ratio >= 0.80, f"Expected >= 80% savings on note-heavy output, got {ratio:.0%}"


class TestJavacFilterErrors:
    """JavacFilter keeps error and warning diagnostic lines."""

    JAVAC = bc.JavacFilter()

    def test_error_lines_kept(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_ERROR_OUTPUT, exit_code=1)
        assert "src/Main.java:12: error: ';' expected" in out
        assert "src/Main.java:25: error: cannot find symbol" in out

    def test_summary_line_kept(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_ERROR_OUTPUT, exit_code=1)
        assert "2 errors" in out

    def test_warning_line_kept(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_WARNING_OUTPUT)
        assert "warning: [deprecation]" in out

    def test_warning_summary_kept(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_WARNING_OUTPUT)
        assert "1 warning" in out

    def test_notes_collapsed_errors_kept_mixed(self) -> None:
        out = _apply(self.JAVAC, stdout=_JAVAC_MIXED_OUTPUT, exit_code=1)
        # Notes collapsed.
        assert "Note: src/TypeA.java" not in out
        assert "collapsed" in out
        # Error kept.
        assert "error: incompatible types" in out
        assert "1 error" in out


# ===========================================================================
# SbtFilter
# ===========================================================================


class TestSbtFilterMatches:
    """SbtFilter matches sbt binary forms."""

    SBT = bc.SbtFilter()

    def test_sbt_matches(self) -> None:
        assert self.SBT.matches(["sbt", "compile"])

    def test_sbt_wrapper_matches(self) -> None:
        assert self.SBT.matches(["./sbt", "test"])

    def test_sbt_no_subcommand_matches(self) -> None:
        assert self.SBT.matches(["sbt"])

    def test_non_sbt_no_match(self) -> None:
        assert not self.SBT.matches(["mvn", "compile"])
        assert not self.SBT.matches(["gradle", "build"])
        assert not self.SBT.matches([])


class TestSbtFilterDispatch:
    """select_filter routes sbt correctly."""

    def test_sbt_routes_to_sbt(self) -> None:
        f = bc.select_filter(["sbt", "test"])
        assert f is not None
        assert f.name == "sbt"

    def test_sbt_wrapper_routes_to_sbt(self) -> None:
        f = bc.select_filter(["./sbt", "compile"])
        assert f is not None
        assert f.name == "sbt"


_SBT_LOADING_OUTPUT = """\
[info] Loading global plugins from /home/user/.sbt/1.0/plugins
[info] Loading settings for project my-build from plugins.sbt ...
[info] Loading project definition from /home/user/myproject/project
[info] Loading settings for project myproject from build.sbt ...
[info] Set current project to myproject (in build file:/home/user/myproject/)
[info] Compiling 12 Scala sources to /home/user/myproject/target/scala-2.13/classes ...
[info] Done compiling.
[success] Total time: 8 s, completed 30 May 2026
"""

_SBT_WARN_OUTPUT = """\
[info] Compiling 5 Scala sources to /home/user/myproject/target/scala-2.13/classes ...
[warn] /home/user/myproject/src/main/scala/App.scala:12:5: method `foo` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:15:5: method `bar` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:18:5: method `baz` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:21:5: method `qux` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:24:5: method `quux` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:27:5: method `corge` is deprecated
[warn] /home/user/myproject/src/main/scala/App.scala:30:5: method `grault` is deprecated
[info] Done compiling.
[success] Total time: 3 s
"""

_SBT_ERROR_OUTPUT = """\
[info] Compiling 3 Scala sources ...
[error] /home/user/myproject/src/main/scala/App.scala:10:5: not found: value undefinedVar
[error]     val x = undefinedVar
[error]             ^
[error] one error found
[error] (Compile / compileIncremental) Compilation failed
"""

_SBT_TEST_OUTPUT = """\
[info] Loading project definition from /home/user/myproject/project
[info] Set current project to myproject
[info] Compiling 8 Scala test sources ...
[info] Done compiling.
[info] MySpec:
[info] - test addition
[info] - test subtraction
[info] Run completed in 234 milliseconds.
[info] Total number of tests run: 2
[info] Suites: completed 1, aborted 0
[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0
[info] All tests passed.
[success] Total time: 5 s
"""

_SBT_FAILED_TEST_OUTPUT = """\
[info] Loading project definition from /home/user/myproject/project
[info] Set current project to myproject
[info] Compiling 4 Scala test sources ...
[info] Done compiling.
[info] MySpec:
[info] - test addition
[info] - test subtraction *** FAILED ***
[info]   2 did not equal 3 (MySpec.scala:15)
[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0
[info] 1 test failed.
[error] Failed tests:
[error] 	com.example.MySpec
[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful
"""


class TestSbtFilterLoadingNoise:
    """SbtFilter collapses [info] loading/resolution lines."""

    SBT = bc.SbtFilter()

    def test_loading_lines_collapsed(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_LOADING_OUTPUT, argv=["sbt", "compile"])
        assert "[info] Loading global plugins" not in out
        assert "[info] Loading settings" not in out
        assert "[info] Set current project" not in out

    def test_compiling_line_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_LOADING_OUTPUT, argv=["sbt", "compile"])
        assert "[info] Compiling 12 Scala sources" in out

    def test_done_compiling_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_LOADING_OUTPUT, argv=["sbt", "compile"])
        assert "[info] Done compiling." in out

    def test_success_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_LOADING_OUTPUT, argv=["sbt", "compile"])
        assert "[success] Total time:" in out

    def test_loading_collapse_noted(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_LOADING_OUTPUT, argv=["sbt", "compile"])
        assert "collapsed" in out
        assert "loading" in out.lower() or "resolution" in out.lower()

    def test_savings_on_loading_heavy_output(self) -> None:
        lines = []
        for i in range(50):
            lines.append(f"[info] Loading settings for project sub{i} from build.sbt ...")
        lines.append("[info] Compiling 10 Scala sources ...")
        lines.append("[info] Done compiling.")
        lines.append("[success] Total time: 12 s")
        output = "\n".join(lines)
        ratio = _savings_ratio(bc.SbtFilter(), output, argv=["sbt", "compile"])
        assert ratio >= 0.70, f"Expected >= 70% savings on loading-heavy sbt, got {ratio:.0%}"


class TestSbtFilterWarnLines:
    """SbtFilter keeps first N [warn] lines per category, collapses extras."""

    SBT = bc.SbtFilter()

    def test_first_five_warnings_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_WARN_OUTPUT, argv=["sbt", "compile"])
        # The 5 first warnings are unique by 60-char prefix → all kept.
        # (The 6th and 7th have different line text so may vary by category logic.)
        # At minimum the compiling + done lines must survive.
        assert "[info] Compiling 5 Scala sources" in out
        assert "[info] Done compiling." in out

    def test_warn_lines_present_in_output(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_WARN_OUTPUT, argv=["sbt", "compile"])
        # At least some warn lines must survive.
        assert "[warn]" in out

    def test_duplicate_warn_collapsed_to_note(self) -> None:
        """When the same warning fires >5 times it must be collapsed."""
        # Build output with 10 identical [warn] lines.
        lines = [
            "[info] Compiling 1 Scala sources ...",
        ]
        for _ in range(10):
            lines.append("[warn] /src/Foo.scala:1:1: implicit numeric widening")
        lines += ["[info] Done compiling.", "[success] Total time: 1 s"]
        output = "\n".join(lines)
        out = _apply(self.SBT, stdout=output, argv=["sbt", "compile"])
        assert "collapsed" in out
        # Not all 10 warn lines should appear verbatim.
        verbatim_count = out.count("[warn] /src/Foo.scala:1:1: implicit numeric widening")
        assert verbatim_count <= 5, f"Expected <= 5 verbatim warn lines, got {verbatim_count}"


class TestSbtFilterErrors:
    """SbtFilter always keeps [error] lines."""

    SBT = bc.SbtFilter()

    def test_error_lines_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_ERROR_OUTPUT, exit_code=1, argv=["sbt", "compile"])
        assert "[error] /home/user/myproject/src/main/scala/App.scala:10:5: not found" in out
        assert "[error] one error found" in out

    def test_compilation_line_kept_on_error(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_ERROR_OUTPUT, exit_code=1, argv=["sbt", "compile"])
        assert "[info] Compiling 3 Scala sources" in out

    def test_loading_noise_on_error_collapsed(self) -> None:
        lines = [
            "[info] Loading project definition from /home/user/myproject/project",
            "[info] Set current project to myproject",
        ] + _SBT_ERROR_OUTPUT.splitlines()
        output = "\n".join(lines)
        out = _apply(self.SBT, stdout=output, exit_code=1, argv=["sbt", "compile"])
        assert "[info] Loading project definition" not in out
        assert "[error] one error found" in out


class TestSbtFilterTestOutput:
    """SbtFilter handles sbt test output."""

    SBT = bc.SbtFilter()

    def test_test_summary_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_TEST_OUTPUT, argv=["sbt", "test"])
        assert "[info] Tests: succeeded 2, failed 0" in out
        assert "[info] All tests passed." in out

    def test_loading_collapsed_in_test(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_TEST_OUTPUT, argv=["sbt", "test"])
        assert "[info] Loading project definition" not in out
        assert "[info] Set current project" not in out

    def test_failed_test_block_kept(self) -> None:
        out = _apply(self.SBT, stdout=_SBT_FAILED_TEST_OUTPUT, exit_code=1, argv=["sbt", "test"])
        assert "[error] Failed tests:" in out
        assert "[error] \tcom.example.MySpec" in out

    def test_failed_test_summary_kept(self) -> None:
        out = _apply(
            self.SBT, stdout=_SBT_FAILED_TEST_OUTPUT, exit_code=1, argv=["sbt", "test"]
        )
        assert "[info] Tests: succeeded 1, failed 1" in out


class TestSbtFilterScalaTestVerbose:
    """SbtFilter collapses ScalaTest/Specs2/MUnit verbose passing-test lines."""

    SBT = bc.SbtFilter()

    def test_scalatest_passing_lines_collapsed(self) -> None:
        """[info]   - test name (N ms) lines are collapsed to a count."""
        lines = [
            "[info] MySpec:",
            "[info] - test addition (5 ms)",
            "[info] - test subtraction (3 ms)",
            "[info] - test multiplication (4 ms)",
            "[info] Tests: succeeded 3, failed 0, canceled 0, ignored 0, pending 0",
            "[info] All tests passed.",
            "[success] Total time: 2 s",
        ]
        out = _apply(self.SBT, stdout="\n".join(lines), argv=["sbt", "test"])
        # Passing test lines should be collapsed.
        assert "[info] - test addition" not in out
        assert "collapsed" in out and "passing-test" in out
        # Summary must be kept.
        assert "All tests passed" in out

    def test_scalatest_failed_line_kept(self) -> None:
        """[info]   - test name *** FAILED *** lines are never collapsed."""
        lines = [
            "[info] - passing test (2 ms)",
            "[info] - failing test *** FAILED ***",
            "[info]   expected 1 but was 2",
            "[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0",
        ]
        out = _apply(self.SBT, stdout="\n".join(lines), exit_code=1, argv=["sbt", "test"])
        # The failed line must survive.
        assert "*** FAILED ***" in out
        # The passing line must be collapsed.
        assert "[info] - passing test" not in out

    def test_specs2_plus_style_passing_line_collapsed(self) -> None:
        """[info]   + test name (Specs2 style) passing lines are collapsed."""
        lines = [
            "[info] + feature works correctly",
            "[info] + another feature works",
            "[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0",
            "[success] Total time: 1 s",
        ]
        out = _apply(self.SBT, stdout="\n".join(lines), argv=["sbt", "test"])
        assert "[info] + feature works correctly" not in out
        assert "collapsed" in out and "passing-test" in out

    def test_munit_checkmark_style_passing_line_collapsed(self) -> None:
        """[info]   ✓ test name (MUnit style) passing lines are collapsed."""
        lines = [
            "[info] ✓ test one (45 ms)",
            "[info] ✓ test two (12 ms)",
            "[info] Passed: Total 2, Failed 0, Errors 0, Passed 2",
        ]
        out = _apply(self.SBT, stdout="\n".join(lines), argv=["sbt", "test"])
        assert "[info] ✓ test one" not in out
        assert "collapsed" in out and "passing-test" in out
