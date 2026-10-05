import { describe, it, expect } from 'vitest'
import {
  adaptHeredoc,
  adaptInlinePython,
  adaptPowerShellCommand,
} from '../src/powershell_compat.js'
import { run } from '../src/bash_runner.js'
import { canRunPowerShell } from '../src/shell.js'

describe('PowerShell Heredoc and Inline Script Adaptation', () => {
  describe('adaptHeredoc', () => {
    it('adapts standard python - <<\'EOF\' heredocs into base64 stdin piping', () => {
      const input = `python - <<'EOF'\ns = """hello\nworld"""\nprint(s)\nEOF`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(')
      expect(adapted).toContain('| python -')
      expect(adapted).not.toContain('<<')
    })

    it('adapts python <<EOF without dash by appending dash for stdin consumption', () => {
      const input = `python <<EOF\nprint("no dash")\nEOF`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('| python -')
    })

    it('adapts python3 and node heredocs', () => {
      const py3 = `python3 <<'PY'\nprint(42)\nPY`
      expect(adaptHeredoc(py3)).toContain('| python3 -')

      const nodeCmd = `node - <<'EOF'\nconsole.log("hi");\nEOF`
      expect(adaptHeredoc(nodeCmd)).toContain('| node -')
    })

    it('adapts cat redirection heredocs to Set-Content', () => {
      const input = `cat <<'EOF' > output.txt\nline 1\nline 2\nEOF`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('Set-Content -Path output.txt')
    })

    it('preserves surrounding chained statements around heredoc', () => {
      const input = `Write-Output "start"; python - <<'EOF'\nprint("middle")\nEOF; Write-Output "end"`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('Write-Output "start";')
      expect(adapted).toContain('| python -; Write-Output "end"')
    })

    it('leaves commands without heredocs unchanged', () => {
      const plain = 'git status -s'
      expect(adaptHeredoc(plain)).toBe(plain)
    })
  })

  describe('adaptInlinePython', () => {
    it('adapts python -c with double quotes inside single quotes to base64 stdin piping', () => {
      const input = `python -c 's = "unterminated \\"string\\" literal"; print(s)'`
      const adapted = adaptInlinePython(input)
      expect(adapted).toContain('[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(')
      expect(adapted).toContain('| python -')
      expect(adapted).not.toContain('-c')
    })

    it('preserves interpreter flags and arguments after script', () => {
      const input = `python3 -u -c 'import sys; print(sys.argv)' arg1 arg2`
      const adapted = adaptInlinePython(input)
      expect(adapted).toContain('| python3 -u - arg1 arg2')
    })

    it('handles chained statements with python -c', () => {
      const input = `Write-Output "part1"; python -c "print('part2')"; Write-Output "part3"`
      const adapted = adaptInlinePython(input)
      expect(adapted).toContain('Write-Output "part1";')
      expect(adapted).toContain('| python -; Write-Output "part3"')
    })

    // HAND-DERIVED: `mypy -c PROGRAM_TEXT` and `scrapy` end in "py" but are not Python; after `-m pytest` or a script path, `-c` is pytest's config flag or the script's own argument (python --help: "-m mod : run library module as a script (terminates option list)").
    it('leaves a -c that does not belong to a python interpreter alone', () => {
      for (const input of [
        `mypy -c "x: int = 'a'"`,
        `scrapy -c 'import os'`,
        `python -m pytest -c "setup.cfg"`,
        `python -mpytest -c "setup.cfg"`,
        `python script.py -c "arg"`,
        `git log; python3 tool.py -c 'x'`,
      ]) {
        expect(adaptInlinePython(input)).toBe(input)
        expect(adaptPowerShellCommand(input)).toBe(input)
      }
    })

    // HAND-DERIVED: python --help lists -X opt and -W arg as options with a separate value; `py -3` is the Windows launcher's version switch.
    it('still adapts an interpreter path and options that take a value', () => {
      expect(adaptInlinePython(`python -X utf8 -W ignore -c "print(1)"`)).toContain('| python -X utf8 -W ignore -')
      expect(adaptInlinePython(`py -3 -c "print(1)"`)).toContain('| py -3 -')
      expect(adaptInlinePython(`C:/Python312/python.exe -c "print(1)"`)).toContain('| C:/Python312/python.exe -')
    })

    it('does not adapt python -c if it already receives pipeline input', () => {
      const input = `echo "data" | python -c "import sys; print(sys.stdin.read())"`
      // Stdin already used by upstream pipe; do not replace
      expect(adaptInlinePython(input)).toBe(input)
    })
  })

  describe('adaptPowerShellCommand', () => {
    it('runs both heredoc and inline python adaptors', () => {
      const heredoc = `python - <<'EOF'\nprint("heredoc")\nEOF`
      expect(adaptPowerShellCommand(heredoc)).toContain('[System.Text.Encoding]::UTF8.GetString')

      const inline = `python -c 'print("inline")'`
      expect(adaptPowerShellCommand(inline)).toContain('[System.Text.Encoding]::UTF8.GetString')
    })
  })

  describe('PowerShell Execution Integration', () => {
    it.runIf(canRunPowerShell())('executes inline Python with nested quotes without syntax errors', async () => {
      let stdout = ''
      const cmd = `python -c 's = "unterminated \\"string\\" literal"; print(s)'`
      const exitCode = await run(cmd, {
        filterName: 'powershell',
        shellType: 'pwsh',
        writeStdout: (s) => {
          stdout += s
        },
        writeStderr: () => {},
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('unterminated "string" literal')
    })

    it.runIf(canRunPowerShell())('executes bash heredoc under PowerShell without ParserError', async () => {
      let stdout = ''
      const heredoc = `python - <<'EOF'\ns = """multi-line\nheredoc\nwith "quotes" and 'single'"""\nprint(s)\nEOF`
      const exitCode = await run(heredoc, {
        filterName: 'powershell',
        shellType: 'pwsh',
        writeStdout: (s) => {
          stdout += s
        },
        writeStderr: () => {},
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('multi-line')
      expect(stdout).toContain('heredoc')
      expect(stdout).toContain('with "quotes" and \'single\'')
    })

    it.runIf(canRunPowerShell())('supports raw stdin piping via opts.stdin', async () => {
      let stdout = ''
      const exitCode = await run('python -', {
        filterName: 'powershell',
        shellType: 'pwsh',
        stdin: 'import sys; sys.stdout.write("piped-input-success\\n")',
        writeStdout: (s) => {
          stdout += s
        },
        writeStderr: () => {},
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('piped-input-success')
    })

    it.runIf(canRunPowerShell())('propagates non-zero exit code from failing inline python', async () => {
      const exitCode = await run('python -c "import sys; sys.exit(42)"', {
        filterName: 'powershell',
        shellType: 'pwsh',
        writeStdout: () => {},
        writeStderr: () => {},
      })

      expect(exitCode).not.toBe(0)
    })
  })
})
