@rem FORMAT-DERIVED: Windows Commands reference, goto and batch labels https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/goto
@echo off
format a: /s
if not errorlevel 1 goto end
echo An error occurred during formatting.
:start
call helper.bat
call "C:\tools\deploy.cmd"
:: call legacy.bat is only mentioned in this comment
rem call old_deploy.cmd is only mentioned in this comment
goto :eof
:end
echo End of batch program.
