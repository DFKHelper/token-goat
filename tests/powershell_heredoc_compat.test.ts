import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  adaptHeredoc,
  adaptInlinePython,
  adaptPowerShellCommand,
} from '../src/powershell_compat.js'
import { run, spawnTarget } from '../src/bash_runner.js'
import { canRunPowerShell, resolvePowerShell } from '../src/shell.js'

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

    // HAND-DERIVED: bash's `cat >> f` appends, which is PowerShell's Add-Content, and `cat <<EOF | cmd` only feeds cmd, so the body pipes straight into it.
    it('maps an appending cat to Add-Content and drops a cat that only pipes', () => {
      expect(adaptHeredoc(`cat >> 'log.txt' <<'EOF'\nsecond\nEOF`)).toMatch(/\| Add-Content -Path 'log\.txt'$/)
      expect(adaptHeredoc(`cat <<'EOF' >> log.txt\nsecond\nEOF`)).toMatch(/\| Add-Content -Path log\.txt$/)
      expect(adaptHeredoc(`cat <<'EOF' | python -\nprint(1)\nEOF`)).toMatch(/\)\) \| python -$/)
    })

    // HAND-DERIVED: forms with no PowerShell mapping here (a cat option, a redirect plus a pipe, an assignment) are left whole for PowerShell to report, never half rewritten.
    it('leaves a heredoc form it does not recognize as written', () => {
      for (const input of [`cat -n <<'EOF'\nx\nEOF`, `cat <<'EOF' > out.txt | Out-Null\nx\nEOF`, `$x = cat <<'EOF'\nx\nEOF`]) {
        expect(adaptPowerShellCommand(input)).toBe(input)
      }
    })

    // HAND-DERIVED: PowerShell reads everything inside a here-string, a quoted string or a comment as data, so a `<<EOF` there is text the command writes or prints, not a heredoc.
    it('leaves <<EOF inside a here-string, a string or a comment alone', () => {
      for (const input of [
        `$s = @'\n#!/bin/sh\ncat <<EOF\nhello\nEOF\n'@\nSet-Content -Path gen.sh -Value $s`,
        `$s = @"\ncat <<EOF\nhello\nEOF\n"@`,
        `$t = 'cat <<EOF\nline\nEOF'\nWrite-Output $t`,
        `$t = "cat <<EOF\nline\nEOF"`,
        `<# cat <<EOF\nline\nEOF #>\nWrite-Output done`,
      ]) {
        expect(adaptPowerShellCommand(input)).toBe(input)
      }
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

    // HAND-DERIVED: a double-quoted PowerShell string is expandable ($name, $(...), backtick escapes, doubled quotes), so it must reach python as PowerShell evaluates it: the string is piped as written, never decoded with bash rules into base64.
    it('pipes a double-quoted script as the PowerShell string it is', () => {
      expect(adaptInlinePython(`$name = 'w'; python -c "print('hi $name')" one`)).toBe(`$name = 'w'; "print('hi $name')" | python - one`)
      expect(adaptInlinePython('python -c "print(`"q`")"')).toBe('"print(`"q`")" | python -')
      expect(adaptInlinePython(`python -c "print('$("x" + 'y')')"; Write-Output z`)).toBe(`"print('$("x" + 'y')')" | python -; Write-Output z`)
    })

    // HAND-DERIVED: inside a PowerShell single-quoted string a doubled quote stands for one quote and nothing else is special.
    it('decodes a doubled quote in a single-quoted script', () => {
      const adapted = adaptInlinePython(`python -c 'print(''a\\b'')' 'x;y'; Write-Output z`)
      const b64 = /FromBase64String\('([^']*)'\)/.exec(adapted)?.[1] ?? ''
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(`print('a\\b')`)
      expect(adapted).toMatch(/\| python - 'x;y'; Write-Output z$/)
    })

    it('leaves a python -c inside a string or comment alone', () => {
      for (const input of [`Write-Output 'x; python -c "print(1)"'`, `Write-Output a # ; python -c 'print(1)'`, `$s = @'\npython -c 'print(1)'\n'@`]) {
        expect(adaptPowerShellCommand(input)).toBe(input)
      }
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

  describe('wrapper matches a direct PowerShell run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pscompat-')).replace(/\\/g, '/')
    const env = { ...process.env, TG_COMPAT_PROBE: 'expanded' }
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

    const lines = (out: string): string[] => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const direct = (cmd: string) => spawnSync(resolvePowerShell(), ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env })
    const wrapped = (cmd: string) => {
      const t = spawnTarget(cmd, undefined, 'pwsh')
      return spawnSync(t.file, t.args, { encoding: 'utf8', env: { ...env, ...t.cmdEnv } })
    }

    // Provenance: HAND-DERIVED expected lines, from PowerShell's quoting rules (a double-quoted string expands $name, $env:X and $(...), reads a backtick escape and a doubled quote, and keeps backslashes; a single-quoted one keeps everything but a doubled quote) and what Python prints for the resulting script. The direct `pwsh -Command` run of each line is captured live alongside the wrapper, and the two must agree.
    it.runIf(canRunPowerShell()).each([
      [`python -c "print('$env:TG_COMPAT_PROBE')"`, ['expanded'], 0],
      [`$name = 'world'; python -c "print('hello $name')"`, ['hello world'], 0],
      [String.raw`python -c "print('a\\nb')"`, [String.raw`a\nb`], 0],
      ['python -c "print(`"hi`")"', ['hi'], 0],
      ['python -c "print(""a""+""b"")"', ['ab'], 0],
      [`python -c "print('$(1+2)')"`, ['3'], 0],
      [`python -c "print('$("x" + 'y')')"`, ['xy'], 0],
      [`python -c 'print(''it''''s'')'`, ['its'], 0],
      [`python -c "import sys; print(sys.argv[1:])" one 'two;three'; Write-Output after`, [`['one', 'two;three']`, 'after'], 0],
      [`$t = 'cat <<EOF\nline\nEOF'\nWrite-Output $t`, ['cat <<EOF', 'line', 'EOF'], 0],
      [`python -c "print('x')"; Get-Item ./tg-no-such-item-xyz`, ['x'], 1],
    ])('%s', (cmd, expected, code) => {
      const d = direct(cmd)
      const w = wrapped(cmd)
      expect(lines(d.stdout)).toEqual(expected)
      expect(d.status).toBe(code)
      expect(lines(w.stdout)).toEqual(lines(d.stdout))
      expect(w.status).toBe(d.status)
    })

    // Provenance: HAND-DERIVED, as above: a here-string is literal text, so the script it holds reaches the file byte for byte; the direct run's file is the reference for the wrapper's.
    it.runIf(canRunPowerShell())('writes a here-string holding a heredoc to the file unchanged', () => {
      const script = (f: string) => `$s = @'\n#!/bin/sh\ncat <<EOF\nhello from heredoc\nEOF\n'@\nSet-Content -Path '${f}' -Value $s\nGet-Content '${f}'`
      const d = direct(script(`${dir}/direct.sh`))
      const w = wrapped(script(`${dir}/wrapped.sh`))
      expect(lines(d.stdout)).toEqual(['#!/bin/sh', 'cat <<EOF', 'hello from heredoc', 'EOF'])
      expect(w.status).toBe(d.status)
      expect(lines(w.stdout)).toEqual(lines(d.stdout))
      expect(fs.readFileSync(`${dir}/wrapped.sh`).equals(fs.readFileSync(`${dir}/direct.sh`))).toBe(true)
    })

    // Provenance: HAND-DERIVED from bash semantics: `cat >> f <<EOF` appends the body to f, and `cat <<EOF | cmd` feeds the body to cmd. Direct pwsh cannot parse `<<` at all, so these compare with what bash would do.
    it.runIf(canRunPowerShell())('runs an appending and a piped cat heredoc the way bash would', () => {
      const appendTo = `${dir}/app.txt`
      const a = wrapped(`Set-Content -Path '${appendTo}' -Value first\ncat >> '${appendTo}' <<'EOF'\nappended\nEOF\nGet-Content '${appendTo}'`)
      expect(a.stderr).toBe('')
      expect(lines(a.stdout)).toEqual(['first', 'appended'])
      expect(a.status).toBe(0)
      const p = wrapped(`cat <<'EOF' | python -\nprint('from heredoc')\nEOF`)
      expect(lines(p.stdout)).toEqual(['from heredoc'])
      expect(p.status).toBe(0)
      const m = wrapped(`cat <<'EOF' | Measure-Object -Line | Select-Object -ExpandProperty Lines\none\ntwo\nEOF`)
      expect(lines(m.stdout)).toEqual(['2'])
      expect(m.status).toBe(0)
    })

    // Provenance: HAND-DERIVED: a heredoc append that fails is Add-Content's non-terminating error as the last statement, so the exit must be the one direct pwsh gives that same Add-Content (1), never 0.
    it.runIf(canRunPowerShell())('exits like direct pwsh when the appending heredoc is the failing last statement', () => {
      const missing = `${dir}/no-such-dir/f.txt`
      const d = direct(`'x' | Add-Content -Path '${missing}'`)
      const w = wrapped(`cat >> '${missing}' <<'EOF'\nx\nEOF`)
      expect(d.status).toBe(1)
      expect(w.status).toBe(d.status)
      expect(w.stderr).toContain('Add-Content')
    })

    it.runIf(canRunPowerShell())('expands a double-quoted script through the shipping run path', async () => {
      let stdout = ''
      const exitCode = await run(`$name = 'world'; python -c "print('hello $name $env:TG_COMPAT_PROBE')"`, {
        filterName: 'powershell',
        shellType: 'pwsh',
        env,
        writeStdout: (s) => {
          stdout += s
        },
        writeStderr: () => {},
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('hello world expanded')
    })
  })
})
