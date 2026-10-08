import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  adaptHeredoc,
  adaptInlinePython,
  adaptPowerShellCommand,
  base64Bytes,
  MAX_ENCODED_CHARS,
} from '../src/powershell_compat.js'
import { run, spawnTarget } from '../src/bash_runner.js'
import { canRunPowerShell, resolvePowerShell } from '../src/shell.js'
import { parseWithPowerShell, powershellForParsing } from './helpers/powershell_parse.js'

// The texts a rewrite carries as base64 or as the `-c` loader's hex argument, decoded.
function decodedBodies(adapted: string): string[] {
  return [...adapted.matchAll(/FromBase64String\('([^']*)'\)|'\s+x([0-9a-f]*)(?=\s|$)/g)].map((m) => m[1] !== undefined ? Buffer.from(m[1], 'base64').toString('utf8') : Buffer.from(m[2] as string, 'hex').toString('utf8'))
}

const parseShell = powershellForParsing()

// A rewrite with the `-c` loader's program text replaced by LOADER, so a test can state the rest exactly.
const withoutLoader = (adapted: string): string => adapted.replace(/'\(lambda s:.*?\.decode\(''utf-8''\)\)'/g, 'LOADER')

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

    // HAND-DERIVED: bash writes a heredoc's lines each ended by a newline, so `cat > f` leaves "line 1\nline 2\n" in f; a bare path word holds nothing bash would expand, so it is the same text in PowerShell single quotes.
    it('adapts cat redirection heredocs to a UTF-8 file write of the bytes bash writes', () => {
      const input = `cat <<'EOF' > output.txt\nline 1\nline 2\nEOF`
      const adapted = adaptHeredoc(input)
      expect(adapted).toMatch(/^\[System\.IO\.File\]::WriteAllText\(\$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\('output\.txt'\), /)
      expect(adapted).toMatch(/, \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)$/)
      expect(adapted).not.toContain('Set-Content')
      expect(decodedBodies(adapted)).toEqual(['line 1\nline 2\n'])
    })

    it('preserves surrounding chained statements around heredoc', () => {
      const input = `Write-Output "start"; python - <<'EOF'\nprint("middle")\nEOF\nWrite-Output "end"`
      const adapted = adaptHeredoc(input)
      expect(adapted).toContain('Write-Output "start";')
      expect(adapted).toContain('| python -; $TgQ = $? }')
      expect(adapted).toMatch(/ -ErrorAction Ignore\nWrite-Output "end"$/)
    })

    it('leaves commands without heredocs unchanged', () => {
      const plain = 'git status -s'
      expect(adaptHeredoc(plain)).toBe(plain)
    })

    // HAND-DERIVED: bash's `cat >> f` appends, which is PowerShell's Add-Content, and `cat <<EOF | cmd` only feeds cmd, so the body pipes straight into it.
    it('maps an appending cat to a file append and drops a cat that only pipes', () => {
      expect(adaptHeredoc(`cat >> 'log.txt' <<'EOF'\nsecond\nEOF`)).toMatch(/^\[System\.IO\.File\]::AppendAllText\(.*FromPSPath\('log\.txt'\), /)
      expect(adaptHeredoc(`cat <<'EOF' >> log.txt\nsecond\nEOF`)).toMatch(/^\[System\.IO\.File\]::AppendAllText\(.*FromPSPath\('log\.txt'\), /)
      expect(decodedBodies(adaptHeredoc(`cat <<'EOF' >> log.txt\nsecond\nEOF`))).toEqual(['second\n'])
      expect(adaptHeredoc(`cat <<'EOF' | python -\nprint(1)\nEOF`)).toMatch(/\)\) \| python -; \$TgQ = /)
    })

    // HAND-DERIVED: each redirect word is a file name with shell characters in it, written for this test; bash reads a bare word holding none of ( ) { } $ backtick or a quote as literal text, so only those words may be rewritten, and the rewrite of a file write runs no command at all (PowerShell's own parser, parse-only, lists the commands; nothing is executed).
    it.skipIf(parseShell === null)('names a redirect file with shell characters as one PowerShell string, or leaves the command as written', () => {
      const rewritten = ['a,b.txt', 'a.txt', 'dir/sub.txt', "'a,(Write-Output).txt'", "'a $(x) b.txt'", '"plain name.txt"', '"C:\\temp\\x.txt"', "'C:\\temp\\x.txt'"]
      const unchanged = ['C:\\temp\\x.txt', 'dir\\sub.txt','$(Write-Output)', 'a,(Write-Output)', 'x)+(Write-Output', '{Write-Output}', '@(Write-Output)', '-x.txt', 'a`$(Write-Output)', '#x', 'a*.txt', "it's.txt", "'it''s.txt'", '\u2018a\u2019', "'a\u2019;(Write-Output);\u2018b'", '"a\u201d;(Write-Output);\u201cb"', '"a`";(Write-Output);`"b"', '"a\\$(Write-Output)"', "'a';(Write-Output);'b'"]
      const commands = [...rewritten, ...unchanged].flatMap((word) => [`cat > ${word} <<'EOF'\nx\nEOF`, `cat <<'EOF' >> ${word}\nx\nEOF`])
      const adapted = commands.map((c) => adaptHeredoc(c))
      expect(adapted.filter((a, i) => a === commands[i])).toEqual(commands.slice(rewritten.length * 2))
      const parsed = parseWithPowerShell(parseShell as string, adapted.slice(0, rewritten.length * 2))
      expect(parsed.map((p) => [p.command, p.statements, p.errors, p.commands])).toEqual(parsed.map((p) => [p.command, 1, 0, []]))
      expect(adaptHeredoc(`cat > a,b.txt <<'EOF'\nx\nEOF`)).toContain("FromPSPath('a,b.txt'), ")
      // A double-quoted word stays the expandable PowerShell string it was written as, the way a double-quoted python -c script does, so a substitution in it runs as the one command written there.
      expect(parseWithPowerShell(parseShell as string, [adaptHeredoc(`cat > "$(Write-Output out).txt" <<'EOF'\nx\nEOF`)])[0]?.commands).toEqual(['Write-Output'])
    })

    // HAND-DERIVED: bash runs each pipeline stage in a subshell, so what a heredoc pipe sets never outlives it, whatever the body holds; Windows PowerShell 5.1 pipes text into a native command in $OutputEncoding, ASCII by default, so every pipe runs in a scope with a UTF-8 one.
    it('pipes every body, ASCII or not, in the same scope', () => {
      const ascii = adaptHeredoc(`node - <<'EOF'\nconsole.log('hello')\nEOF`)
      const wide = adaptHeredoc(`node - <<'EOF'\nconsole.log('héllo ✓')\nEOF`)
      expect(decodedBodies(wide)).toEqual(['console.log(\'héllo ✓\')\n', 'console.log(\'héllo ✓\')'])
      const shape = (s: string) => s.replace(/FromBase64String\('[^']*'\)/g, 'B64')
      expect(shape(ascii)).toBe(shape(wide))
      expect(ascii).toMatch(/^& \{ .*\$OutputEncoding = .* \| node -; .*\} \$ErrorActionPreference -ErrorAction Ignore$/)
      // Statements after the piped command on the heredoc's line stay outside the scope, so an assignment there still reaches the caller.
      expect(adaptHeredoc(`cat <<'EOF' | node - ; $after = 1\nconsole.log('e')\nEOF`)).toMatch(/\$TgQ = \$\? \}; if .* -ErrorAction Ignore ; \$after = 1$/)
    })

    // HAND-DERIVED from bash(1), Here Documents: with `<<-` leading tabs are stripped from the body lines and the delimiter line; without it the delimiter must start its line; a body with no lines is empty; an unquoted delimiter has the body expanded ($, backtick, backslash), so such a body is left for PowerShell to refuse rather than delivered unexpanded.
    it('reads a heredoc body the way bash does', () => {
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<-'EOF'\n\tone\n\t\ttwo\n  three\n\tEOF`))).toEqual(['one\ntwo\n  three\n'])
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<'EOF'\n\tEOF\n  EOF\nlast\nEOF`))).toEqual(['\tEOF\n  EOF\nlast\n'])
      expect(adaptHeredoc(`cat > f.txt <<'EOF'\n  EOF`)).toBe(`cat > f.txt <<'EOF'\n  EOF`)
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<'EOF'\nEOF`))).toEqual([''])
      expect(adaptHeredoc(`cat <<'EOF' | python -\nEOF`)).toMatch(/^& \{ .*@\(\) \| python /)
      for (const body of ['cost: $5', 'run `date`', 'C:\\temp']) {
        const input = `cat > f.txt <<EOF\n${body}\nEOF`
        expect(adaptHeredoc(input)).toBe(input)
        expect(decodedBodies(adaptHeredoc(`cat > f.txt <<'EOF'\n${body}\nEOF`))).toEqual([`${body}\n`])
      }
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<EOF\nplain text\nEOF`))).toEqual(['plain text\n'])
    })

    // HAND-DERIVED from bash(1), Here Documents: the body ends at a line that is exactly the delimiter (leading tabs removed only with `<<-`); `EOF; echo x`, `EOF ` and ` EOF` are body lines, so with no exact terminator bash reads to the end of input and the command is not ours to rewrite.
    it('ends a heredoc only at a line equal to the delimiter', () => {
      for (const line of ['EOF; echo x', 'EOF ', ' EOF', 'EOF\r', 'EOFX']) {
        const input = `cat > f.txt <<'EOF'\nbody\n${line}`
        expect(adaptHeredoc(input)).toBe(input)
        const piped = `cat <<'EOF' | python -\nprint(1)\n${line}`
        expect(adaptHeredoc(piped)).toBe(piped)
      }
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<'EOF'\nEOF ; echo x\nEOF`))).toEqual(['EOF ; echo x\n'])
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<-'EOF'\n\t\tbody\n\t\tEOF`))).toEqual(['body\n'])
      expect(decodedBodies(adaptHeredoc(`cat > f.txt <<'EOF'\nbody\nEOF`))).toEqual(['body\n'])
      expect(adaptHeredoc(`cat > f.txt <<'EOF'\nbody\nEOF\necho x`)).toMatch(/\n?echo x$/)
    })

    // HAND-DERIVED from bash(1), Command Substitution: `$(cat <<EOF ... EOF)` yields the body as the substitution's value, but the stdout rewrite writes to the console handle, which PowerShell's `$(...)` never captures; so inside a parenthesis the stdout form is left as written, and outside it is rewritten.
    it('leaves a stdout cat heredoc inside parentheses as written and rewrites one outside', () => {
      for (const inside of [`$x = $(\ncat <<'EOF'\nhi\nEOF\n)`, `$x = $(echo a; cat <<'EOF'\nhi\nEOF\n)`, `$x = (\ncat <<'EOF'\nhi\nEOF\n)`]) expect(adaptHeredoc(inside)).toBe(inside)
      // A file write or a pipe into a cmdlet inside parentheses prints nothing to stdout, so bash's value for the substitution is empty and the rewrite is the same.
      expect(adaptHeredoc(`$x = (\ncat <<'EOF' > f.txt\nhi\nEOF\n)`)).toContain('WriteAllText')
      const outside = `$a = 1; cat <<'EOF'\nhi\nEOF\n$b = (1 + 2)`
      expect(adaptHeredoc(outside)).toContain('OpenStandardOutput')
      expect(adaptHeredoc(`$x = (1 + 2); cat <<'EOF'\nhi\nEOF`)).toContain('OpenStandardOutput')
    })

    // HAND-DERIVED from bash(1), Quoting: an unquoted backslash is removed (`C:\temp\x.txt` names `C:tempx.txt`), a single-quoted one is literal, so only the quoted forms name the file a PowerShell string would; a bare backslash name is left whole.
    it('rewrites a single- or double-quoted backslash file name and leaves a bare one as written', () => {
      const bare = `cat > C:\\temp\\x.txt <<'EOF'\nx\nEOF`
      expect(adaptHeredoc(bare)).toBe(bare)
      const single = adaptHeredoc(`cat > 'C:\\temp\\x.txt' <<'EOF'\nx\nEOF`)
      expect(single).toContain(`FromPSPath('C:\\temp\\x.txt')`)
      expect(adaptHeredoc(`cat > "C:\\temp\\x.txt" <<'EOF'\nx\nEOF`)).toContain('FromPSPath(')
    })

    // HAND-DERIVED: a command line is carried as one environment variable, which Windows caps near 32,767 characters, so a rewrite whose text passes the shared limit is not made; base64Bytes(text).base64.length is what the guard measures.
    it('leaves a heredoc whose encoded body passes the shared limit as written', () => {
      const small = `cat > f.txt <<'EOF'\n${'a'.repeat(1000)}\nEOF`
      expect(adaptHeredoc(small)).not.toBe(small)
      const big = `cat > f.txt <<'EOF'\n${'a'.repeat(MAX_ENCODED_CHARS)}\nEOF`
      expect(adaptHeredoc(big)).toBe(big)
      expect(adaptPowerShellCommand(big)).toBe(big)
      const many = `cat > a.txt <<'EOF'\n${'b'.repeat(15000)}\nEOF\ncat > b.txt <<'EOF'\n${'b'.repeat(15000)}\nEOF`
      expect(adaptPowerShellCommand(many)).toBe(many)
    })

    // HAND-DERIVED: base64 of n bytes is 4*ceil(n/3) characters; the text is encoded as UTF-8.
    it('counts base64 characters from the UTF-8 bytes', () => {
      expect(base64Bytes('h\u00e9llo')).toEqual({ base64: Buffer.from('h\u00e9llo').toString('base64'), bytes: 6 })
      expect(base64Bytes('').bytes).toBe(0)
    })

    // HAND-DERIVED: a global regex keeps lastIndex across calls; two consecutive calls with the same input must give the same output whatever the first call matched.
    it('gives the same rewrite on two consecutive calls', () => {
      const cmd = `python -c 'print(1)'; python -c "print(2)"`
      const first = adaptPowerShellCommand(cmd)
      expect(first).not.toBe(cmd)
      expect(adaptPowerShellCommand(cmd)).toBe(first)
      expect(adaptPowerShellCommand(`python -c 'print(3)'`)).toBe(adaptPowerShellCommand(`python -c 'print(3)'`))
      const hd = `python - <<'EOF'\nprint(1)\nEOF\npython - <<'EOF'\nprint(2)\nEOF`
      expect(adaptHeredoc(hd)).toBe(adaptHeredoc(hd))
      expect(adaptHeredoc(hd).match(/FromBase64String/g)?.length).toBeGreaterThanOrEqual(2)
    })

    // HAND-DERIVED: PowerShell appends CRLF to a string piped into a native command, which bash does not; the rewrite for a native command line writes the body's bytes to the process, and a cmdlet target keeps the pipeline.
    it('writes a native pipe target\'s stdin as bytes and leaves a cmdlet target on the pipeline', () => {
      const native = adaptHeredoc(`cat <<'EOF' | python -c "import sys; print(1)"\nx\nEOF`)
      expect(native).toContain('BaseStream.Write')
      expect(adaptHeredoc(`cat <<'EOF' | Measure-Object -Line\nx\nEOF`)).not.toContain('BaseStream')
      for (const target of ['python - 2>&1', 'python - > out.txt', 'python - | head', '"python" -']) {
        const input = `cat <<'EOF' | ${target}\nx\nEOF`
        expect(adaptHeredoc(input)).toBe(input)
      }
    })

    // HAND-DERIVED: bash's `cat <<EOF` writes the body's bytes to standard output; Write-Output would print them in the console code page.
    it('writes a bare cat heredoc to standard output as bytes', () => {
      const adapted = adaptHeredoc(`cat <<'EOF'\nh\u00e9llo\nEOF`)
      expect(adapted).toMatch(/^\[System\.Console\]::OpenStandardOutput\(\)\.Write\(\[System\.Convert\]::FromBase64String\('[^']*'\), 0, 7\)$/)
      expect(decodedBodies(adapted)).toEqual(['h\u00e9llo\n'])
    })

    // FORMAT-DERIVED from `python --help` (CPython 3.x usage text): "PYTHONIOENCODING: encoding[:errors] used for stdin/stdout/stderr", the only switch a script read from stdin can be given; the command itself, launcher version switch and options included, runs as written.
    it('runs a Python heredoc target as written, with UTF-8 standard streams', () => {
      expect(adaptHeredoc(`python3 <<'PY'\nprint(42)\nPY`)).toMatch(/\$env:PYTHONIOENCODING = 'utf-8' \}; .*\| python3 -; /)
      expect(adaptHeredoc(`py -3 - <<'PY'\nprint(42)\nPY`)).toMatch(/\$env:PYTHONIOENCODING = 'utf-8' \}; .*\| py -3 -; /)
      expect(adaptHeredoc(`python -X utf8 - <<'PY'\nprint(42)\nPY`)).toMatch(/\| python -X utf8 -; /)
      const node = adaptHeredoc(`node - <<'EOF'\nconsole.log(1)\nEOF`)
      expect(node).toMatch(/\| node -; /)
      expect(node).not.toContain('PYTHONIOENCODING')
      for (const adapted of [adaptHeredoc(`python3 <<'PY'\nprint(42)\nPY`), adaptInlinePython(`python -c 'print(1)'`), adaptInlinePython(`python -c "print(1)"`)]) expect(adapted).not.toContain('-X utf8')
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
    // HAND-DERIVED: the script is a -c argument PowerShell 5.1 would split at its double quotes, so it travels as hex in the next argument, which the -c loader decodes and runs; the loader holds no double quote and imports no module a file in the working directory could shadow.
    it('adapts python -c with double quotes inside single quotes to a -c loader and a hex argument', () => {
      const input = `python -c 's = "unterminated \\"string\\" literal"; print(s)'`
      const adapted = adaptInlinePython(input)
      expect(withoutLoader(adapted)).toMatch(/^python -c LOADER x[0-9a-f]+$/)
      expect(decodedBodies(adapted)).toEqual([`s = "unterminated \\"string\\" literal"; print(s)`])
      expect(adapted).not.toContain('|')
      expect(adapted).not.toContain('"')
      expect([...adapted.matchAll(/__import__\(''(\w+)''\)/g)].map((m) => m[1])).toEqual(['sys', 'sys'])
    })

    // HAND-DERIVED: bash `python -c SCRIPT a b` gives sys.argv ['-c', 'a', 'b'] and leaves stdin to the script, so the arguments stay after the -c string and nothing is piped in.
    it('preserves interpreter flags and arguments after script', () => {
      const input = `python3 -u -c 'import sys; print(sys.argv)' arg1 arg2`
      const adapted = adaptInlinePython(input)
      expect(withoutLoader(adapted)).toMatch(/^python3 -u -c LOADER x[0-9a-f]+ arg1 arg2$/)
    })

    it('handles chained statements with python -c', () => {
      const input = `Write-Output "part1"; python -c "print('part2')"; Write-Output "part3"`
      const adapted = adaptInlinePython(input)
      expect(adapted).toContain('Write-Output "part1"; python -c $(& { param($TgS)')
      expect(adapted).toMatch(/ "print\('part2'\)"\); Write-Output "part3"$/)
    })

    // HAND-DERIVED: Windows' CreateProcess takes at most 32,767 characters, and hex is twice the size of the script, so a script that would not fit is left as written.
    it('leaves a script too long for a hex command line as written', () => {
      const input = `python -c 'print(1)  # ${'x'.repeat(14_000)}'`
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
      expect(adaptInlinePython(`python -X utf8 -W ignore -c "print(1)"`)).toMatch(/^python -X utf8 -W ignore -c \$\(& /)
      expect(adaptInlinePython(`py -3 -c "print(1)"`)).toMatch(/^py -3 -c \$\(& /)
      expect(adaptInlinePython(`C:/Python312/python.exe -c "print(1)"`)).toMatch(/^C:\/Python312\/python\.exe -c \$\(& /)
    })

    // HAND-DERIVED: a double-quoted PowerShell string is expandable ($name, $(...), backtick escapes, doubled quotes), so it must reach python as PowerShell evaluates it: the string is encoded at run time as written, never decoded with bash rules, and passed as written when its hex would not fit the command line.
    it('encodes a double-quoted script at run time from the PowerShell string it is', () => {
      const loaderArgs = (expandable: string) => `$(& { param($TgS) $TgH = 'x' + [System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($TgS)).Replace('-', ''); if ($TgH.Length -gt 28000) { $TgS } else { LOADER; $TgH } } ${expandable})`
      expect(withoutLoader(adaptInlinePython(`$name = 'w'; python -c "print('hi $name')" one`))).toBe(`$name = 'w'; python -c ${loaderArgs(`"print('hi $name')"`)} one`)
      expect(withoutLoader(adaptInlinePython('python -c "print(`"q`")"'))).toBe(`python -c ${loaderArgs('"print(`"q`")"')}`)
      expect(withoutLoader(adaptInlinePython(`python -c "print('$("x" + 'y')')"; Write-Output z`))).toBe(`python -c ${loaderArgs(`"print('$("x" + 'y')')"`)}; Write-Output z`)
    })

    // HAND-DERIVED: inside a PowerShell single-quoted string a doubled quote stands for one quote and nothing else is special.
    it('decodes a doubled quote in a single-quoted script', () => {
      const adapted = adaptInlinePython(`python -c 'print(''a\\b'')' 'x;y'; Write-Output z`)
      expect(decodedBodies(adapted)).toEqual([`print('a\\b')`])
      expect(adapted).toMatch(/' x[0-9a-f]+ 'x;y'; Write-Output z$/)
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
      expect(adaptPowerShellCommand(inline)).toContain(`-c '(lambda s:`)
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

      it('writes a cat > heredoc to a file whose bare name holds a comma', () => {
        const r = runIn(`cat > a,b.txt <<'EOF'\n${TEXT}\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.status).toBe(0)
        expect(fs.readFileSync(path.join(dir, 'a,b.txt')).toString('hex')).toBe(hex(`${TEXT}\n`))
        expect(fs.existsSync(path.join(dir, 'a b.txt'))).toBe(false)
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

      // HAND-DERIVED: python -c puts the working directory first on sys.path, so a module there named like a standard one is imported in its place; an inert base64.py and binascii.py that print MARK stand in for a hostile one.
      it.skipIf(!hasPython)(`runs a -c script past a base64.py or binascii.py in the working directory${pythonSkip}`, () => {
        fs.mkdirSync(path.join(dir, 'shadow'))
        for (const name of ['base64.py', 'binascii.py']) fs.writeFileSync(path.join(dir, 'shadow', name), "print('MARK')\n")
        for (const cmd of [`Set-Location shadow; python -c 'print("ok")'`, `Set-Location shadow; python -c "print('ok')"`, `Set-Location shadow; cat <<'EOF' | python -\nprint('ok')\nEOF`]) {
          const r = runIn(cmd)
          expect(r.stderr).toBe('')
          expect(r.stdout.trim()).toBe('ok')
          expect(r.status).toBe(0)
        }
      })

      // HAND-DERIVED: unwrapped, Python on Windows opens a file in the ANSI code page and prints in UTF-8 only when told to; the rewrite changes the standard streams alone, so open() reads what it reads unwrapped while a non-ASCII print comes out as UTF-8.
      it.skipIf(!hasPython)(`reads a file with open() as unwrapped Python does and prints non-ASCII as UTF-8${pythonSkip}`, () => {
        fs.writeFileSync(path.join(dir, 'cp.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
        const script = 'print(len(open("cp.txt").read()))'
        const direct = spawnSync('python', ['-c', script], { cwd: dir, env, encoding: 'utf8' })
        for (const cmd of [`python -c '${script}'`, `$s = 'cp.txt'; python -c "print(len(open('$s').read()))"`, `python - <<'EOF'\n${script}\nEOF`]) {
          const r = runIn(cmd)
          expect({ status: r.status, stdout: r.stdout.trim(), stderr: r.stderr }).toEqual({ status: direct.status, stdout: direct.stdout.trim(), stderr: direct.stderr })
        }
        for (const cmd of [`python -c 'print("${TEXT}")'`, `$w = '${TEXT}'; python -c "print('$w')"`, `python - <<'EOF'\nprint('${TEXT}')\nEOF`]) {
          const r = runIn(cmd)
          expect(r.stderr).toBe('')
          expect(r.stdoutHex).toMatch(new RegExp(`^${hex(TEXT)}(0d)?0a$`))
          expect(r.status).toBe(0)
        }
      })

      // HAND-DERIVED: PowerShell's $env: drive is the process environment, so a variable the rewrite sets for Python has to be put back, removed when it was not set, for the next statement to see what bash's would.
      it.skipIf(!hasPython)(`leaves $env:PYTHONIOENCODING as it was and honors a value already set${pythonSkip}`, () => {
        const probe = `cat <<'EOF' | python -\nimport sys; print(sys.stdout.encoding); sys.exit(3)\nEOF\npython -c 'import sys; print(sys.stdout.encoding)'\nWrite-Output "set=$(Test-Path env:PYTHONIOENCODING) value=[$env:PYTHONIOENCODING]"`
        expect(runIn(probe).stdout.split(/\r?\n/).filter(Boolean)).toEqual(['utf-8', 'utf-8', 'set=False value=[]'])
        expect(runIn(`$env:PYTHONIOENCODING = 'latin-1'\n${probe}`).stdout.split(/\r?\n/).filter(Boolean)).toEqual(['iso8859-1', 'iso8859-1', 'set=True value=[latin-1]'])
      })

      // HAND-DERIVED: Python 3.13 quotes the source line of each traceback frame, and for -c that line is the -c argument, so a script carried inside it would be printed whole; the exception line and the output before it are what the original prints.
      it.skipIf(!hasPython)(`keeps a failing script's traceback short and its exception and output${pythonSkip}`, () => {
        const pad = `# ${'p'.repeat(3000)}`
        for (const script of [`raise ValueError("boom")  ${pad}`, `print("first")\n${pad}\nprint("last")\nraise ValueError("boom")`]) {
          for (const cmd of [`python -c '${script}'`, `$t = 'boom'; python -c "${script.replace(/"/g, "'").replace("'boom'", "'$t'")}"`]) {
            const r = runIn(cmd)
            expect(r.stderr).toMatch(/ValueError: boom\r?\n$/)
            expect(r.stderr).not.toContain('ppp')
            expect(Buffer.byteLength(r.stderr)).toBeLessThan(2000)
            if (script.startsWith('print')) expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['first', 'last'])
            expect(r.status).toBe(1)
          }
        }
      })

      // HAND-DERIVED: a double-quoted script's length is known only once PowerShell expands it; Windows' CreateProcess takes at most 32,767 characters, which a 25,000-character value carried as hex would pass.
      it.skipIf(!hasPython)(`runs a double-quoted script that expands past the hex limit as written${pythonSkip}`, () => {
        const r = runIn(`$env:BIG = 'a' * 25000; python -c "print(len('$env:BIG'))"`)
        expect(r.stderr).toBe('')
        expect(r.stdout.trim()).toBe('25000')
        expect(r.status).toBe(0)
      })

      it.skipIf(!hasPython)(`keeps a failing pipe's $? and $LASTEXITCODE and leaves $OutputEncoding as it was, ASCII body or not${pythonSkip}`, () => {
        const before = spawnSync(shellPath, ['-NoProfile', '-NonInteractive', '-Command', '$OutputEncoding.WebName'], { encoding: 'utf8' }).stdout.trim()
        for (const word of [TEXT, 'plain']) {
          const r = runIn(`cat <<'EOF' | python -\nimport sys; print('${word}'); sys.exit(3)\nEOF\nWrite-Output "q=$? code=$LASTEXITCODE oe=$($OutputEncoding.WebName)"`)
          expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual([word, `q=False code=3 oe=${before}`])
          expect(r.status).toBe(0)
          expect(runIn(`cat <<'EOF' | python -\nimport sys; sys.exit(3)  # ${word}\nEOF`).status).toBe(1)
        }
      })

      it('keeps what a heredoc pipe sets inside the pipe, ASCII body or not, as bash keeps it in a subshell', () => {
        for (const word of [TEXT, 'plain']) {
          const r = runIn(`cat <<'EOF' | ForEach-Object { $seen = $_ }\n${word}\nEOF\nWrite-Output "seen=[$seen]"`)
          expect(r.stderr).toBe('')
          expect(r.stdout.trim()).toBe('seen=[]')
        }
      })

      it('writes a bare cat heredoc as its UTF-8 bytes, in order with the output around it', () => {
        const r = runIn(`Write-Output before\ncat <<'EOF'\n${TEXT}\nEOF\nWrite-Output after`)
        expect(r.stderr).toBe('')
        expect(r.stdoutHex).toMatch(new RegExp(`^${hex('before')}(0d)?0a${hex(`${TEXT}\n`)}${hex('after')}(0d)?0a$`))
        expect(r.status).toBe(0)
      })

      it('writes an empty heredoc body as an empty file and a <<- body without its tabs', () => {
        const r = runIn(`cat > empty.txt <<'EOF'\nEOF\ncat > tabs.txt <<-'EOF'\n\t${TEXT}\n\tEOF`)
        expect(r.stderr).toBe('')
        expect(r.status).toBe(0)
        expect(fs.readFileSync(path.join(dir, 'empty.txt')).length).toBe(0)
        expect(fs.readFileSync(path.join(dir, 'tabs.txt')).toString('hex')).toBe(hex(`${TEXT}\n`))
      })

      it.skipIf(!hasPython)(`pipes an empty heredoc body as empty input${pythonSkip}`, () => {
        const r = runIn(`cat <<'EOF' | python -c "import sys; print(repr(sys.stdin.buffer.read()))"\nEOF`)
        expect(r.stderr).toBe('')
        expect(r.stdout.trim()).toBe(`b''`)
        expect(r.status).toBe(0)
      })

      // HAND-DERIVED: bash hands a program the heredoc body's UTF-8 bytes with LF line ends and the closing newline, no BOM and nothing added; python prints the hex of exactly the bytes it read from stdin.
      it.skipIf(!hasPython)(`gives a native command the body's bytes, LF ended, with no BOM or added newline${pythonSkip}`, () => {
        for (const body of [`${TEXT}\nline 2`, 'plain', '']) {
          const r = runIn(`cat <<'EOF' | python -c "import sys; print(sys.stdin.buffer.read().hex())"\n${body}${body ? '\n' : ''}EOF`)
          expect(r.stderr).toBe('')
          expect(r.stdout.trim()).toBe(hex(body ? `${body}\n` : ''))
          expect(r.status).toBe(0)
        }
      })

      it.skipIf(!hasPython)(`still reports a native command's failure as a failed pipe${pythonSkip}`, () => {
        const r = runIn(`cat <<'EOF' | python -c "import sys; sys.stdin.read(); sys.exit(3)"\nx\nEOF\nWrite-Output "q=$? code=$LASTEXITCODE"`)
        expect(r.stdout.trim()).toBe('q=False code=3')
      })
    })
  }
})
