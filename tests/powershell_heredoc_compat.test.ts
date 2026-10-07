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

// The texts a rewrite carries as base64, decoded.
function decodedBodies(adapted: string): string[] {
  return [...adapted.matchAll(/(?:FromBase64String|b64decode)\('([^']*)'\)/g)].map((m) => Buffer.from(m[1] as string, 'base64').toString('utf8'))
}

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

    // HAND-DERIVED: bash writes a heredoc's lines each ended by a newline, so `cat > f` leaves "line 1\nline 2\n" in f; PowerShell's own argument parsing still reads the path word.
    it('adapts cat redirection heredocs to a UTF-8 file write of the bytes bash writes', () => {
      const input = `cat <<'EOF' > output.txt\nline 1\nline 2\nEOF`
      const adapted = adaptHeredoc(input)
      expect(adapted).toMatch(/^\[System\.IO\.File\]::WriteAllText\(\$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\(\(Write-Output output\.txt\)\), /)
      expect(adapted).toMatch(/, \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)$/)
      expect(adapted).not.toContain('Set-Content')
      expect(decodedBodies(adapted)).toEqual(['line 1\nline 2\n'])
    })

    it('preserves surrounding chained statements around heredoc', () => {
      const input = `Write-Output "start"; python - <<'EOF'\nprint("middle")\nEOF; Write-Output "end"`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('Write-Output "start";')
      expect(adapted).toContain('| python -X utf8 -; Write-Output "end"')
    })

    it('leaves commands without heredocs unchanged', () => {
      const plain = 'git status -s'
      expect(adaptHeredoc(plain)).toBe(plain)
    })

    // HAND-DERIVED: bash's `cat >> f` appends, which is PowerShell's Add-Content, and `cat <<EOF | cmd` only feeds cmd, so the body pipes straight into it.
    it('maps an appending cat to a file append and drops a cat that only pipes', () => {
      expect(adaptHeredoc(`cat >> 'log.txt' <<'EOF'\nsecond\nEOF`)).toMatch(/^\[System\.IO\.File\]::AppendAllText\(.*\(Write-Output 'log\.txt'\)\)/)
      expect(adaptHeredoc(`cat <<'EOF' >> log.txt\nsecond\nEOF`)).toMatch(/^\[System\.IO\.File\]::AppendAllText\(.*\(Write-Output log\.txt\)\)/)
      expect(decodedBodies(adaptHeredoc(`cat <<'EOF' >> log.txt\nsecond\nEOF`))).toEqual(['second\n'])
      expect(adaptHeredoc(`cat <<'EOF' | python -\nprint(1)\nEOF`)).toMatch(/\)\) \| python -X utf8 -$/)
    })

    // HAND-DERIVED: Windows PowerShell 5.1 pipes text into a native command in $OutputEncoding, ASCII by default, so "héllo ✓" arrives as "h?llo ?"; ASCII text is the same bytes in either encoding.
    it('pipes a non-ASCII body under a UTF-8 $OutputEncoding scoped to that one pipeline', () => {
      const adapted = adaptHeredoc(`node - <<'EOF'\nconsole.log('héllo ✓')\nEOF`)
      expect(adapted).toMatch(/^& \{ \[CmdletBinding\(\)\] param\(\$TgEap\) \$ErrorActionPreference = \$TgEap; \$OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\); \[System\.Text\.Encoding\]::UTF8\.GetString\(.*\) \| node -; if \(-not \$\?\) \{ \$PSCmdlet\.WriteError\(.*\) \} \} \$ErrorActionPreference -ErrorAction Ignore$/)
      expect(decodedBodies(adapted)).toEqual(['console.log(\'héllo ✓\')'])
      expect(adaptHeredoc(`node - <<'EOF'\nconsole.log('hello')\nEOF`)).not.toContain('$OutputEncoding')
      // Statements after the piped command on the heredoc's line stay outside the scope, so an assignment there still reaches the caller.
      expect(adaptHeredoc(`cat <<'EOF' | node - ; $after = 1\nconsole.log('é')\nEOF`)).toMatch(/\| node -; if .* -ErrorAction Ignore ; \$after = 1$/)
    })

    // HAND-DERIVED: python --help: "-X utf8: enable UTF-8 mode", the command-line form of PYTHONUTF8=1; the py launcher reads its version switch only as its first argument.
    it('runs a Python heredoc target in UTF-8 mode, after the launcher version switch', () => {
      expect(adaptHeredoc(`python3 <<'PY'\nprint(42)\nPY`)).toMatch(/\| python3 -X utf8 -$/)
      expect(adaptHeredoc(`py -3 - <<'PY'\nprint(42)\nPY`)).toMatch(/\| py -3 -X utf8 -$/)
      expect(adaptHeredoc(`python -X utf8 - <<'PY'\nprint(42)\nPY`)).toMatch(/\| python -X utf8 -$/)
      expect(adaptHeredoc(`node - <<'EOF'\nconsole.log(1)\nEOF`)).toMatch(/\| node -$/)
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
    // HAND-DERIVED: the script is a -c argument PowerShell 5.1 would split at its double quotes, so it travels as base64 that Python decodes and runs, still under -c.
    it('adapts python -c with double quotes inside single quotes to a base64 -c bootstrap', () => {
      const input = `python -c 's = "unterminated \\"string\\" literal"; print(s)'`
      const adapted = adaptInlinePython(input)
      expect(adapted).toMatch(/^python -X utf8 -c "exec\(__import__\('base64'\)\.b64decode\('[A-Za-z0-9+/=]+'\)\.decode\(\)\)"$/)
      expect(decodedBodies(adapted)).toEqual([`s = "unterminated \\"string\\" literal"; print(s)`])
      expect(adapted).not.toContain('|')
    })

    // HAND-DERIVED: bash `python -c SCRIPT a b` gives sys.argv ['-c', 'a', 'b'] and leaves stdin to the script, so the arguments stay after the -c string and nothing is piped in.
    it('preserves interpreter flags and arguments after script', () => {
      const input = `python3 -u -c 'import sys; print(sys.argv)' arg1 arg2`
      const adapted = adaptInlinePython(input)
      expect(adapted).toMatch(/^python3 -u -X utf8 -c "exec\(.*\)" arg1 arg2$/)
    })

    it('handles chained statements with python -c', () => {
      const input = `Write-Output "part1"; python -c "print('part2')"; Write-Output "part3"`
      const adapted = adaptInlinePython(input)
      expect(adapted).toContain('Write-Output "part1"; python -X utf8 -c (')
      expect(adapted).toMatch(/\.decode\(\)\)'\); Write-Output "part3"$/)
    })

    // HAND-DERIVED: Windows' CreateProcess takes at most 32,767 characters, and base64 is 4/3 the size of the script, so a script that would not fit is left as written.
    it('leaves a script too long for a base64 command line as written', () => {
      const input = `python -c 'print(1)  # ${'x'.repeat(22_000)}'`
      expect(adaptInlinePython(input)).toBe(input)
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
      expect(adaptInlinePython(`python -X utf8 -W ignore -c "print(1)"`)).toMatch(/^python -X utf8 -W ignore -c \('exec/)
      expect(adaptInlinePython(`py -3 -c "print(1)"`)).toMatch(/^py -3 -X utf8 -c \('exec/)
      expect(adaptInlinePython(`C:/Python312/python.exe -c "print(1)"`)).toMatch(/^C:\/Python312\/python\.exe -X utf8 -c \('exec/)
    })

    // HAND-DERIVED: a double-quoted PowerShell string is expandable ($name, $(...), backtick escapes, doubled quotes), so it must reach python as PowerShell evaluates it: the string is encoded at run time as written, never decoded with bash rules into base64.
    it('encodes a double-quoted script at run time from the PowerShell string it is', () => {
      const bootstrap = (expandable: string) => `('exec(__import__(''base64'').b64decode(''' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(${expandable})) + ''').decode())')`
      expect(adaptInlinePython(`$name = 'w'; python -c "print('hi $name')" one`)).toBe(`$name = 'w'; python -X utf8 -c ${bootstrap(`"print('hi $name')"`)} one`)
      expect(adaptInlinePython('python -c "print(`"q`")"')).toBe(`python -X utf8 -c ${bootstrap('"print(`"q`")"')}`)
      expect(adaptInlinePython(`python -c "print('$("x" + 'y')')"; Write-Output z`)).toBe(`python -X utf8 -c ${bootstrap(`"print('$("x" + 'y')')"`)}; Write-Output z`)
    })

    // HAND-DERIVED: inside a PowerShell single-quoted string a doubled quote stands for one quote and nothing else is special.
    it('decodes a doubled quote in a single-quoted script', () => {
      const adapted = adaptInlinePython(`python -c 'print(''a\\b'')' 'x;y'; Write-Output z`)
      expect(decodedBodies(adapted)).toEqual([`print('a\\b')`])
      expect(adapted).toMatch(/\.decode\(\)\)" 'x;y'; Write-Output z$/)
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
      expect(adaptPowerShellCommand(inline)).toContain(`-c "exec(__import__('base64').b64decode(`)
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

    // Provenance: HAND-DERIVED: bash's `cat >> missing-dir/f <<EOF` fails to open the file and, as the last command, exits 1; the wrapper must exit 1 too and say which write failed, never 0.
    it.runIf(canRunPowerShell())('exits 1 when the appending heredoc is the failing last statement', () => {
      const missing = `${dir}/no-such-dir/f.txt`
      const w = wrapped(`cat >> '${missing}' <<'EOF'\nx\nEOF`)
      expect(w.status).toBe(1)
      expect(w.stderr).toContain('AppendAllText')
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

  // Provenance: HAND-DERIVED: every expected byte string is what bash does with the original command: a heredoc body is the UTF-8 text between the markers with LF line ends plus the closing newline, `cat > f` writes exactly that, `python -c 'S' a b` runs S with argv ['-c', 'a', 'b'] and the caller's stdin, and a non-ASCII string reaches Python unchanged. Each shell runs the shipping wrapper (spawnTarget) on the rewrite, so Windows PowerShell 5.1 (ANSI file writes, ASCII $OutputEncoding) and PowerShell 7 are held to the same bytes.
  const TEXT = 'h\u00e9llo \u2713'
  const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex')
  const hasPython = spawnSync('python', ['--version']).status === 0
  const windowsPs = path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const pwsh = resolvePowerShell({ PATH: process.env['PATH'] })
  const realShells: Array<[string, string, string | null]> = [
    ['Windows PowerShell 5.1', windowsPs, process.platform !== 'win32' ? 'not Windows' : fs.existsSync(windowsPs) ? null : `${windowsPs} not found`],
    ['PowerShell 7', pwsh, /^pwsh/i.test(path.basename(pwsh)) && fs.existsSync(pwsh) ? null : 'no pwsh on PATH'],
  ]
  for (const [label, shellPath, skipReason] of realShells) {
    describe.skipIf(skipReason !== null)(`${label} runs the rewrite the way bash runs the original${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-psreal-'))
      afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env['PYTHONUTF8']
      delete env['PYTHONIOENCODING']
      const runIn = (cmd: string, input = '') => {
        const t = spawnTarget(cmd, undefined, 'pwsh')
        const r = spawnSync(shellPath, t.args, { cwd: dir, env: { ...env, ...t.cmdEnv }, input })
        return { status: r.status, stdout: r.stdout.toString('utf8'), stdoutHex: r.stdout.toString('hex'), stderr: r.stderr.toString('utf8') }
      }
      const pythonSkip = hasPython ? '' : ' (skipped: no python on PATH)'

      it('writes a cat > heredoc as its UTF-8 bytes, relative to the PowerShell location', () => {
        fs.mkdirSync(path.join(dir, 'sub'))
        const r = runIn(`Set-Location sub; cat > 'out.txt' <<'EOF'\n${TEXT}\nline 2\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.status).toBe(0)
        expect(fs.readFileSync(path.join(dir, 'sub', 'out.txt')).toString('hex')).toBe(hex(`${TEXT}\nline 2\n`))
      })

      it('appends a cat >> heredoc to a bare path as its UTF-8 bytes', () => {
        fs.writeFileSync(path.join(dir, 'app.txt'), 'first\n')
        const r = runIn(`cat >> app.txt <<'EOF'\n${TEXT}\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.status).toBe(0)
        expect(fs.readFileSync(path.join(dir, 'app.txt')).toString('hex')).toBe(hex(`first\n${TEXT}\n`))
      })

      it('exits 1 when a cat > heredoc cannot write its file', () => {
        expect(runIn(`cat > 'no-such-dir/f.txt' <<'EOF'\n${TEXT}\nEOF`).status).toBe(1)
      })

      it.skipIf(!hasPython)(`feeds a non-ASCII heredoc to python as UTF-8${pythonSkip}`, () => {
        const r = runIn(`python - <<'EOF'\nimport sys; sys.stdout.buffer.write('${TEXT}'.encode('utf-8') + b'\\n')\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.stdoutHex).toBe(hex(`${TEXT}\n`))
        expect(r.status).toBe(0)
      })

      it.skipIf(!hasPython)(`prints non-ASCII from a piped cat heredoc${pythonSkip}`, () => {
        const r = runIn(`cat <<'EOF' | python -\nprint('${TEXT}')\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.stdout).toMatch(new RegExp(`^${TEXT}\\r?\\n$`))
        expect(r.status).toBe(0)
      })

      it.skipIf(!hasPython)(`gives python -c its own argv and the caller's stdin${pythonSkip}`, () => {
        const r = runIn(`python -c 'import sys; print(sys.argv[0], sys.argv[1:], repr(sys.stdin.read()))' one 'two three'`, 'from stdin')
        expect(r.stderr).toBe('')
        expect(r.stdout.trim()).toBe(`-c ['one', 'two three'] 'from stdin'`)
        expect(r.status).toBe(0)
      })

      it.skipIf(!hasPython)(`passes a non-ASCII value expanded into a double-quoted script${pythonSkip}`, () => {
        const r = runIn(`$w = '${TEXT}'; python -c "import sys; sys.stdout.buffer.write('$w'.encode('utf-8') + b'\\n')"`)
        expect(r.stderr).toBe('')
        expect(r.stdoutHex).toBe(hex(`${TEXT}\n`))
        expect(r.status).toBe(0)
      })

      it.skipIf(!hasPython)(`keeps a failing non-ASCII pipe's $? and leaves $OutputEncoding as it was${pythonSkip}`, () => {
        const before = spawnSync(shellPath, ['-NoProfile', '-NonInteractive', '-Command', '$OutputEncoding.WebName'], { encoding: 'utf8' }).stdout.trim()
        const r = runIn(`cat <<'EOF' | python -\nimport sys; print('${TEXT}'); sys.exit(3)\nEOF\nWrite-Output "q=$? oe=$($OutputEncoding.WebName)"`)
        expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual([TEXT, `q=False oe=${before}`])
        expect(r.status).toBe(0)
        expect(runIn(`cat <<'EOF' | python -\nimport sys; sys.exit(3)  # ${TEXT}\nEOF`).status).toBe(1)
      })
    })
  }
})
