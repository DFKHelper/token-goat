"""Tests for MSBuildFilter, NuGetFilter, and PowerShellFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# MSBuildFilter
# ---------------------------------------------------------------------------

_MSBUILD = bc.MSBuildFilter()

_MSBUILD_TYPICAL = """\
Build started 05/30/2026 10:00:00.
Project "C:\\src\\MyApp.sln" (targets) on node 1.
Project "C:\\src\\MyApp\\MyApp.csproj" (targets) on node 2.
  GenerateResource:
  Csc:
  Link:
Copying file from "obj\\Debug\\MyApp.dll" to "bin\\Debug\\MyApp.dll"
Copying file from "obj\\Debug\\MyApp.pdb" to "bin\\Debug\\MyApp.pdb"
Creating directory "bin\\Debug\\net8.0"
Done building project "MyApp.csproj".
Build succeeded.
    0 Warning(s)
    0 Error(s)
Time Elapsed 00:00:05.12
"""


class TestMSBuildFilterMatches:
    def test_msbuild_bare(self) -> None:
        assert _MSBUILD.matches(["msbuild"])

    def test_msbuild_exe(self) -> None:
        assert _MSBUILD.matches(["MSBuild.exe"])
        assert _MSBUILD.matches(["msbuild.exe"])

    def test_msbuild_with_args(self) -> None:
        assert _MSBUILD.matches(["msbuild", "/p:Configuration=Release", "MyApp.sln"])

    def test_non_msbuild_no_match(self) -> None:
        assert not _MSBUILD.matches(["dotnet"])
        assert not _MSBUILD.matches(["cmake"])
        assert not _MSBUILD.matches([])

    def test_dispatch_routes_to_msbuild(self) -> None:
        f = bc.select_filter(["msbuild", "MyApp.sln"])
        assert f is not None
        assert f.name == "msbuild"

    def test_dispatch_routes_msbuild_exe(self) -> None:
        f = bc.select_filter(["MSBuild.exe", "/t:Build"])
        assert f is not None
        assert f.name == "msbuild"


class TestMSBuildFilterBuildSucceeded:
    def test_build_succeeded_preserved(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "Build succeeded." in result

    def test_error_count_line_preserved(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "0 Error(s)" in result

    def test_warning_count_line_preserved(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "0 Warning(s)" in result


class TestMSBuildFilterCopyLines:
    def test_copy_lines_collapsed_to_note(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "collapsed 2 file-copy lines" in result

    def test_copy_lines_not_in_output(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "Copying file from" not in result

    def test_no_copy_no_note(self) -> None:
        out = "Build started.\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n"
        result = _apply(_MSBUILD, out)
        assert "file-copy" not in result


class TestMSBuildFilterMkdirLines:
    def test_mkdir_lines_collapsed(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "collapsed 1 directory-creation lines" in result

    def test_mkdir_text_not_in_output(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "Creating directory" not in result


class TestMSBuildFilterTaskLines:
    def test_task_lines_collapsed(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        assert "collapsed 3 task-name lines" in result

    def test_task_lines_not_in_output(self) -> None:
        result = _apply(_MSBUILD, _MSBUILD_TYPICAL)
        # None of "  GenerateResource:", "  Csc:", "  Link:" should appear raw
        assert "  GenerateResource:" not in result
        assert "  Csc:" not in result


class TestMSBuildFilterBuildStartedHeaders:
    def test_first_build_started_kept(self) -> None:
        out = "\n".join([
            'Build started 05/30/2026 10:00:00.',
            'Project "App.sln" (targets) on node 1.',
            'Project "App.sln" (targets) on node 2.',
            "Build succeeded.",
            "    0 Warning(s)",
            "    0 Error(s)",
        ])
        result = _apply(_MSBUILD, out)
        assert "Build started" in result

    def test_repeated_headers_collapsed(self) -> None:
        out = "\n".join([
            'Build started 05/30/2026 10:00:00.',
            'Build started 05/30/2026 10:00:01.',
            "Build succeeded.",
            "    0 Warning(s)",
            "    0 Error(s)",
        ])
        result = _apply(_MSBUILD, out)
        assert "collapsed 1 repeated build-started headers" in result


class TestMSBuildFilterErrorLines:
    def test_error_line_kept_verbatim(self) -> None:
        out = (
            "Build started.\n"
            "src\\MyApp\\Program.cs(10,5): error CS0001: Type or namespace not found\n"
            "Build FAILED.\n"
            "    1 Error(s)\n"
        )
        result = _apply(_MSBUILD, out, exit_code=1)
        assert "CS0001" in result
        assert "Program.cs(10,5)" in result

    def test_copy_lines_kept_on_failure(self) -> None:
        """On failure, copy lines near an error are still compressed (counts),
        but the error itself is preserved."""
        out = (
            "Copying file from 'a.dll' to 'bin\\a.dll'\n"
            "src\\Foo.cs(1,1): error CS0001: Bad\n"
            "    1 Error(s)\n"
        )
        result = _apply(_MSBUILD, out, exit_code=1)
        assert "CS0001" in result


class TestMSBuildFilterWarnings:
    def test_warning_kept_first_occurrence(self) -> None:
        out = (
            "Build started.\n"
            "src\\MyApp\\A.cs(5,3): warning CS0168: Variable declared but never used\n"
            "Build succeeded.\n"
            "    1 Warning(s)\n"
            "    0 Error(s)\n"
        )
        result = _apply(_MSBUILD, out)
        assert "CS0168" in result

    def test_duplicate_warning_code_deduped(self) -> None:
        out = (
            "Build started.\n"
            "src\\A.cs(5,3): warning CS0168: Variable 'x' declared but never used\n"
            "src\\B.cs(7,3): warning CS0168: Variable 'y' declared but never used\n"
            "Build succeeded.\n"
            "    2 Warning(s)\n"
            "    0 Error(s)\n"
        )
        result = _apply(_MSBUILD, out)
        assert "deduplicated 1 repeated warnings" in result


class TestMSBuildFilterNoiseLines:
    def test_done_building_dropped_on_success(self) -> None:
        out = (
            "Build started.\n"
            'Done building project "MyApp.csproj".\n'
            "Build succeeded.\n"
            "    0 Warning(s)\n"
            "    0 Error(s)\n"
        )
        result = _apply(_MSBUILD, out, exit_code=0)
        assert "Done building" not in result
        assert "dropped" in result


# ---------------------------------------------------------------------------
# NuGetFilter
# ---------------------------------------------------------------------------

_NUGET = bc.NuGetFilter()

_NUGET_RESTORE_OUTPUT = """\
Restoring packages for C:\\src\\MyApp\\MyApp.csproj...
Installing Newtonsoft.Json 13.0.3
Installing Microsoft.Extensions.Logging 8.0.0
Installing Serilog 3.1.1
OK https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg
OK https://api.nuget.org/v3-flatcontainer/serilog/3.1.1/serilog.3.1.1.nupkg
Package Newtonsoft.Json 13.0.0 is already installed
Successfully installed 'Newtonsoft.Json 13.0.3'
Successfully installed 'Serilog 3.1.1'
"""


class TestNuGetFilterMatches:
    def test_nuget_bare(self) -> None:
        assert _NUGET.matches(["nuget"])

    def test_nuget_exe(self) -> None:
        assert _NUGET.matches(["nuget.exe"])
        assert _NUGET.matches(["NuGet.exe"])

    def test_nuget_with_subcommand(self) -> None:
        assert _NUGET.matches(["nuget", "restore"])
        assert _NUGET.matches(["nuget", "install", "Newtonsoft.Json"])

    def test_non_nuget_no_match(self) -> None:
        assert not _NUGET.matches(["dotnet"])
        assert not _NUGET.matches(["pip"])
        assert not _NUGET.matches([])

    def test_dispatch_routes_to_nuget(self) -> None:
        f = bc.select_filter(["nuget", "restore"])
        assert f is not None
        assert f.name == "nuget"


class TestNuGetFilterInstallingLines:
    def test_installing_lines_collapsed(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "collapsed 3 package-install lines" in result

    def test_raw_installing_lines_absent(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "Installing Newtonsoft.Json 13.0.3" not in result
        assert "Installing Serilog" not in result


class TestNuGetFilterRestoringLines:
    def test_single_restoring_line_kept(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "Restoring packages" in result

    def test_multiple_restoring_lines_collapsed(self) -> None:
        out = (
            "Restoring packages for C:\\src\\A\\A.csproj...\n"
            "Restoring packages for C:\\src\\B\\B.csproj...\n"
            "Restoring packages for C:\\src\\C\\C.csproj...\n"
        )
        result = _apply(_NUGET, out)
        assert "3 projects" in result

    def test_raw_restoring_paths_absent_when_multiple(self) -> None:
        out = (
            "Restoring packages for C:\\src\\A\\A.csproj...\n"
            "Restoring packages for C:\\src\\B\\B.csproj...\n"
        )
        result = _apply(_NUGET, out)
        assert "A.csproj" not in result
        assert "B.csproj" not in result


class TestNuGetFilterDownloadLines:
    def test_ok_https_lines_collapsed(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "collapsed 2 package-download lines" in result

    def test_raw_urls_absent(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "api.nuget.org" not in result


class TestNuGetFilterAlreadyInstalled:
    def test_already_installed_collapsed(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "collapsed 1 already-installed lines" in result


class TestNuGetFilterSuccessfullyInstalled:
    def test_successfully_installed_collapsed(self) -> None:
        result = _apply(_NUGET, _NUGET_RESTORE_OUTPUT)
        assert "collapsed 2 successfully-installed lines" in result


class TestNuGetFilterErrors:
    def test_error_line_kept(self) -> None:
        out = (
            "Restoring packages for C:\\src\\MyApp.csproj...\n"
            "Installing Serilog 3.1.1\n"
            "error: Unable to find package 'Serilog' with version '99.0'\n"
        )
        result = _apply(_NUGET, out, exit_code=1)
        assert "error: Unable to find package" in result


# ---------------------------------------------------------------------------
# PowerShellFilter
# ---------------------------------------------------------------------------

_PWSH = bc.PowerShellFilter()

_PWSH_VERBOSE_OUTPUT = """\
VERBOSE: Loading module 'Pester' version 5.6.0
VERBOSE: Performing the operation "Install-Module" on target "Pester"
VERBOSE: Binding parameter 'Name' to 'Pester'
DEBUG: ParameterSet selected 'NameParameterSet'
DEBUG: Getting module 'Pester'
WARNING: The module 'PSReadLine' is already loaded with version 2.2.6
WARNING: The module 'PSReadLine' is already loaded with version 2.2.6
Install-Module: Installing Pester 5.6.0...
Processing record 1 of 3
Processing record 2 of 3
Processing record 3 of 3
Tests passed: 42
"""


class TestPowerShellFilterMatches:
    def test_pwsh(self) -> None:
        assert _PWSH.matches(["pwsh"])

    def test_powershell(self) -> None:
        assert _PWSH.matches(["powershell"])

    def test_powershell_exe(self) -> None:
        assert _PWSH.matches(["powershell.exe"])
        assert _PWSH.matches(["PowerShell.exe"])

    def test_pwsh_with_args(self) -> None:
        assert _PWSH.matches(["pwsh", "-File", "deploy.ps1"])

    def test_non_pwsh_no_match(self) -> None:
        assert not _PWSH.matches(["bash"])
        assert not _PWSH.matches(["cmd"])
        assert not _PWSH.matches([])

    def test_dispatch_routes_to_powershell(self) -> None:
        f = bc.select_filter(["pwsh", "-File", "script.ps1"])
        assert f is not None
        assert f.name == "powershell"

    def test_dispatch_powershell_exe(self) -> None:
        f = bc.select_filter(["powershell.exe", "-Command", "Get-Process"])
        assert f is not None
        assert f.name == "powershell"


class TestPowerShellFilterVerboseLines:
    def test_verbose_lines_collapsed(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "collapsed 3 VERBOSE lines" in result

    def test_verbose_lines_absent(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "VERBOSE: Loading module" not in result
        assert "VERBOSE: Performing" not in result


class TestPowerShellFilterDebugLines:
    def test_debug_lines_collapsed(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "collapsed 2 DEBUG lines" in result

    def test_debug_lines_absent(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "DEBUG: ParameterSet" not in result


class TestPowerShellFilterWarningLines:
    def test_unique_warning_kept(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "WARNING: The module 'PSReadLine'" in result

    def test_duplicate_warning_deduped(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "deduplicated 1 repeated warnings" in result

    def test_unique_warnings_both_kept(self) -> None:
        out = (
            "WARNING: Module A is outdated\n"
            "WARNING: Module B needs update\n"
        )
        result = _apply(_PWSH, out)
        assert "Module A is outdated" in result
        assert "Module B needs update" in result


class TestPowerShellFilterInstallModuleLines:
    def test_install_module_collapsed(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "collapsed 1 Install-Module progress lines" in result

    def test_install_module_line_absent(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "Install-Module: Installing Pester" not in result


class TestPowerShellFilterProgressRecords:
    def test_progress_records_collapsed(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "collapsed 3 progress-record lines" in result

    def test_progress_lines_absent(self) -> None:
        result = _apply(_PWSH, _PWSH_VERBOSE_OUTPUT)
        assert "Processing record 1 of 3" not in result
        assert "Processing record 3 of 3" not in result


class TestPowerShellFilterTerminatingError:
    def test_terminating_error_block_kept(self) -> None:
        out = (
            "VERBOSE: Trying something\n"
            "At C:\\scripts\\deploy.ps1:42 char:5\n"
            "+ Connect-AzAccount -TenantId $tenantId\n"
            "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n"
            "CategoryInfo          : AuthenticationError\n"
            "FullyQualifiedErrorId : AuthenticationException\n"
        )
        result = _apply(_PWSH, out, exit_code=1)
        assert "At C:\\scripts\\deploy.ps1:42 char:5" in result
        assert "CategoryInfo" in result
        assert "FullyQualifiedErrorId" in result

    def test_error_signal_line_kept(self) -> None:
        out = (
            "VERBOSE: Setting up...\n"
            "VERBOSE: Connecting...\n"
            "Error: Connection refused to server 'prod-db'\n"
        )
        result = _apply(_PWSH, out, exit_code=1)
        assert "Connection refused" in result


class TestPowerShellFilterCleanOutput:
    def test_regular_output_lines_preserved(self) -> None:
        out = (
            "VERBOSE: Loading...\n"
            "Tests passed: 42\n"
            "All done.\n"
        )
        result = _apply(_PWSH, out)
        assert "Tests passed: 42" in result
        assert "All done." in result

    def test_no_noise_no_note(self) -> None:
        out = "Tests passed: 10\nAll done.\n"
        result = _apply(_PWSH, out)
        assert "collapsed" not in result
        assert "deduplicated" not in result
