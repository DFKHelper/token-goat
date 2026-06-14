"""Tests for PipFilter — ``pip install`` / ``pip3 install`` output compression."""

from __future__ import annotations

from token_goat.bash_compress import PipFilter, select_filter
from token_goat.bash_detect import detect

# ---------------------------------------------------------------------------
# Helpers / shared fixtures
# ---------------------------------------------------------------------------

_FILTER = PipFilter()


def _compress(stdout: str = "", stderr: str = "", exit_code: int = 0, argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["pip", "install", "flask"]
    return _FILTER.compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# Representative pip output samples
# ---------------------------------------------------------------------------

FLASK_INSTALL_STDOUT = """\
Collecting flask
  Downloading Flask-3.0.3-py3-none-any.whl.metadata (3.6 kB)
Collecting Werkzeug>=3.0.0 (from flask)
  Downloading Werkzeug-3.0.3-py3-none-any.whl.metadata (4.1 kB)
Collecting Jinja2>=3.1.2 (from flask)
  Downloading Jinja2-3.1.4-py3-none-any.whl.metadata (2.6 kB)
Collecting itsdangerous>=2.1.2 (from flask)
  Downloading itsdangerous-2.2.0-py3-none-any.whl.metadata (1.9 kB)
Downloading Flask-3.0.3-py3-none-any.whl (101 kB)
Downloading Werkzeug-3.0.3-py3-none-any.whl (227 kB)
Downloading Jinja2-3.1.4-py3-none-any.whl (133 kB)
Downloading itsdangerous-2.2.0-py3-none-any.whl (16 kB)
Installing collected packages: Werkzeug, Jinja2, itsdangerous, flask
Successfully installed Jinja2-3.1.4 Werkzeug-3.0.3 flask-3.0.3 itsdangerous-2.2.0
"""

BUILD_FROM_SOURCE_STDOUT = """\
Collecting mypackage
  Downloading mypackage-0.1.0.tar.gz (4.5 kB)
  Installing build dependencies ... done
  Getting requirements to build wheel ... done
  Preparing metadata (pyproject.toml) ... done
Building wheels for collected packages: mypackage
  Building wheel for mypackage (pyproject.toml) ... done
  Created wheel for mypackage: filename=mypackage-0.1.0-py3-none-any.whl size=1234 location=/tmp/pip-wheel-xxx
  Stored in directory: /tmp/pip-ephem-wheel-cache-xxx/wheels
Successfully built mypackage
Installing collected packages: mypackage
Successfully installed mypackage-0.1.0
"""

REQUIREMENTS_FILE_STDOUT = """\
Collecting flask (from -r requirements.txt (line 1))
  Downloading Flask-3.0.3-py3-none-any.whl.metadata (3.6 kB)
Collecting requests (from -r requirements.txt (line 2))
  Downloading requests-2.32.3-py3-none-any.whl.metadata (4.6 kB)
Collecting numpy (from -r requirements.txt (line 3))
  Downloading numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl.metadata (60 kB)
Collecting pandas (from -r requirements.txt (line 4))
  Downloading pandas-2.2.2-cp312-cp312-manylinux_2_17_x86_64.whl.metadata (89 kB)
Collecting scipy (from -r requirements.txt (line 5))
  Downloading scipy-1.13.1-cp312-cp312-manylinux_2_17_x86_64.whl.metadata (60 kB)
Collecting matplotlib (from -r requirements.txt (line 6))
  Downloading matplotlib-3.9.0-cp312-cp312-manylinux_2_17_x86_64.whl.metadata (11 kB)
Downloading Flask-3.0.3-py3-none-any.whl (101 kB)
Downloading requests-2.32.3-py3-none-any.whl (64 kB)
Downloading numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl (18.0 MB)
Downloading pandas-2.2.2-cp312-cp312-manylinux_2_17_x86_64.whl (12.7 MB)
Downloading scipy-1.13.1-cp312-cp312-manylinux_2_17_x86_64.whl (37.3 MB)
Downloading matplotlib-3.9.0-cp312-cp312-manylinux_2_17_x86_64.whl (37.8 MB)
Installing collected packages: flask, requests, numpy, pandas, scipy, matplotlib
Successfully installed flask-3.0.3 matplotlib-3.9.0 numpy-1.26.4 pandas-2.2.2 requests-2.32.3 scipy-1.13.1
"""

CACHED_INSTALL_STDOUT = """\
Collecting flask
  Using cached Flask-3.0.3-py3-none-any.whl.metadata (3.6 kB)
Collecting Werkzeug>=3.0.0 (from flask)
  Using cached Werkzeug-3.0.3-py3-none-any.whl.metadata (4.1 kB)
Using cached Flask-3.0.3-py3-none-any.whl (101 kB)
Using cached Werkzeug-3.0.3-py3-none-any.whl (227 kB)
Installing collected packages: Werkzeug, flask
Successfully installed Werkzeug-3.0.3 flask-3.0.3
"""

ALREADY_SATISFIED_STDOUT = """\
Requirement already satisfied: flask in /usr/lib/python3/dist-packages (3.0.3)
Requirement already satisfied: Werkzeug>=3.0.0 in /usr/lib/python3/dist-packages (3.0.3)
"""

PROGRESS_BAR_STDOUT = """\
Collecting numpy
  Downloading numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl.metadata (60 kB)
Downloading numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl (18.0 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 18.0/18.0 MB 5.2 MB/s eta 0:00:00
Installing collected packages: numpy
Successfully installed numpy-1.26.4
"""

ERROR_NOT_FOUND_STDERR = """\
ERROR: Could not find a version that satisfies the requirement nosuchpackage (from versions: none)
ERROR: No matching distribution found for nosuchpackage
"""

WARNING_DEPRECATED_STDERR = """\
WARNING: Skipping flask as it is not installed.
"""

VERBOSE_STDOUT = """\
DEBUG pip._internal.cli.base_command: pip version: 24.0
DEBUG pip._internal.cli.base_command: sys.version: 3.12.3
VERBOSE pip._internal.network.session: Fetching https://pypi.org/simple/flask/
Collecting flask
  Downloading Flask-3.0.3-py3-none-any.whl.metadata (3.6 kB)
Downloading Flask-3.0.3-py3-none-any.whl (101 kB)
Installing collected packages: flask
Successfully installed flask-3.0.3
"""

MANY_COLLECTING_STDOUT = """\
Collecting pkg1
Collecting pkg2
Collecting pkg3
Collecting pkg4
Collecting pkg5
Collecting pkg6
Collecting pkg7
Installing collected packages: pkg1, pkg2, pkg3, pkg4, pkg5, pkg6, pkg7
Successfully installed pkg1-1.0 pkg2-1.0 pkg3-1.0 pkg4-1.0 pkg5-1.0 pkg6-1.0 pkg7-1.0
"""

EDITABLE_INSTALL_STDOUT = """\
Obtaining file:///home/user/myproject
  Installing build dependencies ... done
  Checking if build backend supports build_editable ... done
  Getting requirements to build editable ... done
  Preparing editable metadata (pyproject.toml) ... done
Building wheels for collected packages: myproject
  Building editable for myproject (pyproject.toml) ... done
  Created wheel for myproject: filename=myproject-0.1.0-0.editable-py3-none-any.whl size=2876 location=/tmp/pip-wheel-xxx
  Stored in directory: /tmp/pip-ephem-wheel-cache-xxx/wheels
Successfully built myproject
Installing collected packages: myproject
Successfully installed myproject-0.1.0
"""


# ---------------------------------------------------------------------------
# TestPipFilterMatches — binary + subcommand detection
# ---------------------------------------------------------------------------


class TestPipFilterMatches:
    """PipFilter.matches() fires for pip/pip3/pipx install and most subcommands."""

    def test_pip_install(self) -> None:
        assert _FILTER.matches(["pip", "install", "flask"]) is True

    def test_pip3_install(self) -> None:
        assert _FILTER.matches(["pip3", "install", "-r", "requirements.txt"]) is True

    def test_pip_install_no_package(self) -> None:
        # bare `pip install` with no package is still a valid command form
        assert _FILTER.matches(["pip", "install"]) is True

    def test_pip_install_many_flags(self) -> None:
        assert _FILTER.matches(["pip", "install", "--upgrade", "--force-reinstall", "flask"]) is True

    def test_pip_exe_windows(self) -> None:
        assert _FILTER.matches(["pip.exe", "install", "flask"]) is True

    def test_pip3_exe_windows(self) -> None:
        assert _FILTER.matches(["pip3.exe", "install", "flask"]) is True

    def test_pip_full_path_unix(self) -> None:
        assert _FILTER.matches(["/usr/bin/pip", "install", "flask"]) is True

    def test_pip3_full_path_unix(self) -> None:
        assert _FILTER.matches(["/usr/local/bin/pip3", "install", "flask"]) is True

    def test_pip_full_path_windows(self) -> None:
        assert _FILTER.matches([r"C:\Python312\Scripts\pip.exe", "install", "flask"]) is True

    def test_pipx_install(self) -> None:
        assert _FILTER.matches(["pipx", "install", "black"]) is True

    def test_pip3_versioned_stem(self) -> None:
        # pip3.12 → stem is "pip3" (Path strips ".12")
        assert _FILTER.matches(["pip3.12", "install", "flask"]) is True

    def test_pip_requirements_file(self) -> None:
        assert _FILTER.matches(["pip", "install", "-r", "requirements.txt"]) is True

    # --- false positives ---

    def test_not_piper(self) -> None:
        assert _FILTER.matches(["piper", "install", "something"]) is False

    def test_not_pipenv(self) -> None:
        # pipenv has its own filter; should not match PipFilter
        assert _FILTER.matches(["pipenv", "install"]) is False

    def test_not_python(self) -> None:
        # direct call to matches() without prefix stripping — python is not pip
        assert _FILTER.matches(["python", "setup.py", "install"]) is False

    def test_not_npm(self) -> None:
        assert _FILTER.matches(["npm", "install"]) is False

    def test_not_gem(self) -> None:
        assert _FILTER.matches(["gem", "install", "rails"]) is False

    def test_empty_argv(self) -> None:
        assert _FILTER.matches([]) is False


# ---------------------------------------------------------------------------
# bash_detect + select_filter integration
# ---------------------------------------------------------------------------


class TestBashDetectIntegration:
    """bash_detect and select_filter route pip commands to the right filter."""

    def test_detect_pip_returns_truthy(self) -> None:
        # bash_detect maps pip to dep-list (fast-path gate); truthy is correct
        result = detect(["pip", "install"])
        assert result is not None

    def test_detect_pip3_returns_truthy(self) -> None:
        result = detect(["pip3", "install"])
        assert result is not None

    def test_detect_pipx_returns_truthy(self) -> None:
        result = detect(["pipx", "install"])
        assert result is not None

    def test_select_filter_pip_install(self) -> None:
        f = select_filter(["pip", "install", "flask"])
        assert isinstance(f, PipFilter)

    def test_select_filter_pip3_install(self) -> None:
        f = select_filter(["pip3", "install", "flask"])
        assert isinstance(f, PipFilter)

    def test_select_filter_python_m_pip_install(self) -> None:
        # python -m pip install → prefix-stripped to pip install → PipFilter
        f = select_filter(["python", "-m", "pip", "install", "flask"])
        assert isinstance(f, PipFilter)

    def test_select_filter_pip_list_not_pip_filter(self) -> None:
        # pip list is handled by DepListFilter, not PipFilter
        from token_goat.bash_compress import DepListFilter
        f = select_filter(["pip", "list"])
        assert isinstance(f, DepListFilter)

    def test_select_filter_pip_freeze_not_pip_filter(self) -> None:
        from token_goat.bash_compress import DepListFilter
        f = select_filter(["pip", "freeze"])
        assert isinstance(f, DepListFilter)


# ---------------------------------------------------------------------------
# TestCompressPipInstall — main compression behaviour
# ---------------------------------------------------------------------------


class TestCompressPipInstall:
    """Core compression model: drop noise, keep summary and errors."""

    def test_empty_output_passthrough(self) -> None:
        result = _compress("", "", 0)
        assert result.strip() == ""

    def test_downloading_lines_dropped(self) -> None:
        result = _compress(FLASK_INSTALL_STDOUT, "", 0)
        lines = result.splitlines()
        assert not any(
            ln.lstrip().startswith("Downloading ") for ln in lines
        ), "Downloading lines should be dropped"

    def test_using_cached_dropped(self) -> None:
        result = _compress(CACHED_INSTALL_STDOUT, "", 0, ["pip", "install", "flask"])
        assert "Using cached" not in result

    def test_installing_collected_dropped(self) -> None:
        result = _compress(FLASK_INSTALL_STDOUT, "", 0)
        assert "Installing collected packages" not in result

    def test_successfully_installed_kept(self) -> None:
        result = _compress(FLASK_INSTALL_STDOUT, "", 0)
        assert "Successfully installed" in result

    def test_requirement_already_satisfied_kept(self) -> None:
        result = _compress(ALREADY_SATISFIED_STDOUT, "", 0)
        assert "Requirement already satisfied" in result

    def test_build_wheel_noise_dropped(self) -> None:
        result = _compress(BUILD_FROM_SOURCE_STDOUT, "", 0)
        assert "Building wheel for" not in result
        assert "Created wheel for" not in result
        assert "Stored in directory" not in result
        assert "Installing build dependencies" not in result
        assert "Preparing metadata" not in result
        assert "Getting requirements" not in result

    def test_build_wheels_for_collected_dropped(self) -> None:
        # "Building wheels for collected packages:" must also be dropped
        result = _compress(BUILD_FROM_SOURCE_STDOUT, "", 0)
        assert "Building wheels for collected packages" not in result

    def test_installing_collected_from_build_dropped(self) -> None:
        result = _compress(BUILD_FROM_SOURCE_STDOUT, "", 0)
        assert "Installing collected packages" not in result

    def test_build_success_line_kept(self) -> None:
        # "Successfully built X" is useful context, must survive
        result = _compress(BUILD_FROM_SOURCE_STDOUT, "", 0)
        assert "Successfully built mypackage" in result

    def test_progress_bar_unicode_dropped(self) -> None:
        result = _compress(PROGRESS_BAR_STDOUT, "", 0)
        assert "━" not in result, "Unicode progress bar chars should be dropped"

    def test_editable_obtaining_dropped(self) -> None:
        result = _compress(EDITABLE_INSTALL_STDOUT, "", 0)
        assert "Obtaining file://" not in result

    def test_error_on_stderr_kept(self) -> None:
        result = _compress("", ERROR_NOT_FOUND_STDERR, 1, ["pip", "install", "nosuchpackage"])
        assert "ERROR" in result
        assert "nosuchpackage" in result

    def test_warning_kept(self) -> None:
        result = _compress("", WARNING_DEPRECATED_STDERR, 0, ["pip", "uninstall", "flask"])
        assert "WARNING" in result

    def test_pip3_same_compression(self) -> None:
        result = _compress(FLASK_INSTALL_STDOUT, "", 0, ["pip3", "install", "flask"])
        assert "Successfully installed" in result
        assert "Downloading" not in result
        assert "Installing collected packages" not in result

    def test_requirements_file_many_packages(self) -> None:
        result = _compress(REQUIREMENTS_FILE_STDOUT, "", 0, ["pip", "install", "-r", "requirements.txt"])
        assert "Successfully installed" in result
        assert "Downloading" not in result
        assert "Installing collected packages" not in result

    def test_more_than_five_collecting_capped(self) -> None:
        result = _compress(MANY_COLLECTING_STDOUT, "", 0)
        lines = result.splitlines()
        collecting_count = sum(1 for ln in lines if ln.startswith("Collecting "))
        # Exactly 5 Collecting lines kept in output (implementation caps at 5)
        assert collecting_count == 5

    def test_more_than_five_collecting_note_appended(self) -> None:
        result = _compress(MANY_COLLECTING_STDOUT, "", 0)
        assert "more 'Collecting'" in result

    def test_compression_marker_appended_when_savings(self) -> None:
        result = _compress(FLASK_INSTALL_STDOUT, "", 0)
        assert "token-goat" in result

    def test_nonzero_exit_preserves_stderr(self) -> None:
        result = _compress("", ERROR_NOT_FOUND_STDERR, 1, ["pip", "install", "nosuchpackage"])
        assert "Could not find a version" in result


# ---------------------------------------------------------------------------
# TestVerboseMode — verbose flag handling
# ---------------------------------------------------------------------------


class TestVerboseMode:
    """Verbose-mode: DEBUG/VERBOSE/TRACE log lines get dropped with -v / --verbose."""

    def test_verbose_flag_drops_debug_lines(self) -> None:
        result = _compress(VERBOSE_STDOUT, "", 0, ["pip", "install", "-v", "flask"])
        assert "DEBUG pip._internal" not in result

    def test_verbose_flag_keeps_success(self) -> None:
        result = _compress(VERBOSE_STDOUT, "", 0, ["pip", "install", "-v", "flask"])
        assert "Successfully installed flask" in result

    def test_no_verbose_flag_keeps_debug_if_present(self) -> None:
        # Without -v, DEBUG lines from stdout pass through (unusual but valid)
        result = _compress(VERBOSE_STDOUT, "", 0, ["pip", "install", "flask"])
        assert "Successfully installed flask" in result
        # DEBUG lines must NOT be dropped when -v is absent
        assert "DEBUG pip._internal" in result

    def test_verbose_long_flag(self) -> None:
        result = _compress(VERBOSE_STDOUT, "", 0, ["pip", "install", "--verbose", "flask"])
        assert "DEBUG pip._internal" not in result

    def test_triple_v_flag(self) -> None:
        result = _compress(VERBOSE_STDOUT, "", 0, ["pip", "install", "-vvv", "flask"])
        assert "DEBUG pip._internal" not in result


# ---------------------------------------------------------------------------
# TestPipFilterRegressions — edge cases and boundary conditions
# ---------------------------------------------------------------------------


class TestPipFilterRegressions:
    """Regression guards: previously broken edge cases."""

    def test_empty_argv_does_not_raise(self) -> None:
        # compress() is called after matches() but guard anyway
        result = _FILTER.compress("", "", 0, [])
        assert isinstance(result, str)

    def test_mixed_stdout_stderr_error_preserved(self) -> None:
        # When both stdout and stderr are present and exit code is non-zero,
        # error context from stderr must survive.
        stdout = "Collecting flask\n"
        stderr = "ERROR: pip's dependency resolver does not currently take into account all the packages that are installed."
        result = _FILTER.compress(stdout, stderr, 1, ["pip", "install", "flask"])
        assert "ERROR" in result

    def test_installing_collected_case_sensitive(self) -> None:
        # The exact pip casing: "Installing collected packages: ..."
        line = "Installing collected packages: flask, werkzeug\n"
        result = _compress(line, "", 0)
        assert "Installing collected packages" not in result

    def test_indented_downloading_dropped(self) -> None:
        # pip < 22 emits "  Downloading X" (2-space indent)
        stdout = "Collecting flask\n  Downloading Flask-3.0.3-py3-none-any.whl.metadata (3.6 kB)\nSuccessfully installed flask-3.0.3\n"
        result = _compress(stdout, "", 0)
        assert "Downloading" not in result
        assert "Successfully installed flask" in result

    def test_indented_using_cached_dropped(self) -> None:
        stdout = "Collecting flask\n  Using cached Flask-3.0.3-py3-none-any.whl (101 kB)\nSuccessfully installed flask-3.0.3\n"
        result = _compress(stdout, "", 0)
        assert "Using cached" not in result
        assert "Successfully installed flask" in result

    def test_pipx_install_compresses(self) -> None:
        # pipx wraps pip output; same noise must be dropped
        stdout = (
            "Collecting black\n"
            "  Downloading black-24.4.2-cp312-cp312-manylinux_x86_64.whl (7.8 MB)\n"
            "Installing collected packages: black\n"
            "Successfully installed black-24.4.2\n"
        )
        result = _FILTER.compress(stdout, "", 0, ["pipx", "install", "black"])
        assert "Downloading" not in result
        assert "Installing collected packages" not in result
        assert "Successfully installed black" in result

    def test_no_output_lines_no_crash(self) -> None:
        result = _compress("\n\n\n", "", 0)
        assert isinstance(result, str)

    def test_error_line_in_stdout_kept(self) -> None:
        # Some pip versions write error lines to stdout
        stdout = "ERROR: Cannot uninstall 'flask'. It is a distutils installed project\n"
        result = _compress(stdout, "", 1, ["pip", "uninstall", "flask"])
        assert "ERROR" in result
