/** The commands token-goat suggests for other programs (`pandoc` for HTML and Office files, `duckdb` for Parquet, and `mem import --from-md` from `baseline --suggest-mem`) wrote the path raw or inside hand-written double quotes, where a `$` or backtick substitutes and a `"` ends the argument. Each now quotes the path with quotedArg after displaySafePath, and the DuckDB SQL embeds the path only when it is plain. Provenance: HAND-DERIVED. The hostile paths are built from the shell rules alone, the payload is the inert `echo MARK`, and the oracle is two real shells, each running the command with the program renamed to a `token-goat` function that prints its argv. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatMemSuggestions } from '../src/baseline.js'
import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { FILE_TYPE_THRESHOLDS, handleHtml, handleOfficeBinary, handleParquet } from '../src/hints/file_type_handler.js'
import { literalArgv, POSIX_SH, POWERSHELL, powershellRunAll, shRunAll } from './helpers/shell_argv.js'

const PLACEHOLDER = '<a value no quote mark can hold>'

/** Paths a repository can hold: `$` beside a control character, a `"` that would end a double-quoted argument and run what follows, `'` beside `$`, a backtick, and a bidi override. */
const HOSTILE = ['C:/p/a$MARK\u0001.x', 'C:/p/a"b; echo MARK; ".x', "C:/p/a'$MARK.x", 'C:/p/a`echo MARK`.x', 'C:/p/a\u202Eb.x']
const PLAIN = 'C:/p/report.x'

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u200B-\u200D\u202A-\u202E]/

/** Every message a site writes for `p`. */
function messages(p: string): string[] {
  const big = FILE_TYPE_THRESHOLDS.html + 1
  return [
    handleHtml(p + '.html', '', big).message,
    handleHtml(p + '.html', '<p>' + 'x'.repeat(big) + '</p>').message,
    handleHtml(p + '.html', '<h1>Title</h1>\n' + '<p>text</p>\n'.repeat(Math.ceil(big / 12))).message,
    handleOfficeBinary(p + '.doc').message,
    handleParquet(p + '.parquet').message,
  ]
}

/** Each pandoc or duckdb command in `text`, as a `token-goat` call the shell oracle can run: the program becomes the first argument. */
function commandsIn(text: string): string[] {
  return Array.from(text.matchAll(/(?:pandoc|duckdb) [^\r\n]*/g), (m) => 'token-goat ' + m[0].trimEnd())
}

/** Both shells hand every command its arguments as its quotes read literally, and run nothing else. Git Bash drops a carriage return from evaluated text, so its expectation leaves CR out on Windows. */
function expectShellsHoldLiterally(all: readonly string[]): void {
  const commands = all.filter((c) => !c.includes(PLACEHOLDER))
  if (commands.length === 0) return
  const want = commands.map((c) => ({ calls: [literalArgv(c)], stray: [] }))
  if (POSIX_SH !== null) {
    const got = shRunAll(POSIX_SH, commands)
    commands.forEach((c, i) => expect.soft(got[i], `sh: ${JSON.stringify(c)}`).toEqual(want[i]))
  }
  if (POWERSHELL !== null) {
    const got = powershellRunAll(POWERSHELL, commands)
    commands.forEach((c, i) => expect.soft(got[i], `PowerShell: ${JSON.stringify(c)}`).toEqual(want[i]))
  }
}

describe('pandoc and duckdb commands in file-type hints', () => {
  it('name a plain path in double quotes, and the guard leaves them alone', () => {
    const all = messages(PLAIN)
    expect(all.map(commandsIn).flat().length).toBe(5)
    for (const m of all) expect.soft(stripUnsafeSuggestions(m)).toBe(m)
    expect(all.join('\n')).toContain('pandoc "C:/p/report.x.doc" -t plain -o "C:/p/report.x.doc.txt"')
    expect(all.join('\n')).toContain("read_parquet('C:/p/report.x.parquet')")
  })

  it('embed only a plain path in the DuckDB SQL, and name <file> for any other', () => {
    for (const p of HOSTILE) expect.soft(handleParquet(p + '.parquet').message, JSON.stringify(p)).toContain("read_parquet('<file>')")
    expect(handleParquet('\\\\server\\share\\a.parquet').message).toContain("read_parquet('<file>')")
  })

  it('name a Windows path with backslashes in the DuckDB SQL by its forward-slash spelling, unless it holds a hostile character', () => {
    expect(handleParquet('C:\\Users\\me\\data\\a.parquet').message).toContain("read_parquet('C:/Users/me/data/a.parquet')")
    expect(handleParquet("C:\\p\\a'$MARK.parquet").message).toContain("read_parquet('<file>')")
    expect(handleParquet('C:\\p\\a"b.parquet').message).toContain("read_parquet('<file>')")
    expect(handleParquet('C:\\p\\a\u202Eb.parquet').message).toContain("read_parquet('<file>')")
  })

  it.skipIf(POSIX_SH === null && POWERSHELL === null)('hand every hostile path to the program as written in both shells, or write the placeholder', () => {
    const commands = HOSTILE.flatMap((p) => messages(p).flatMap(commandsIn))
    expect(commands.length).toBe(HOSTILE.length * 5)
    for (const c of commands) expect.soft(c, 'raw control, zero-width or bidi character').not.toMatch(RAW_CONTROL)
    expectShellsHoldLiterally(commands)
  })
})

describe('the suggestion guard on commands for other programs', () => {
  it('drops a pandoc or duckdb command a path broke out of, and keeps the sentence', () => {
    const pandoc = 'Extract content first: pandoc "C:/p/a"; echo MARK; ".doc" -t plain'
    expect(stripUnsafeSuggestions(pandoc)).toBe('Extract content first: token-goat (command omitted: the path contains shell metacharacters)')
    const duckdb = `Query with DuckDB: duckdb -c "SELECT * FROM read_parquet('C:/p/$(echo MARK).parquet') LIMIT 10"`
    expect(stripUnsafeSuggestions(duckdb)).not.toContain('echo MARK')
  })

  it('leaves prose and fenced commands with nothing quoted alone', () => {
    for (const text of [
      'Use `token-goat refs <symbol>` or `rg -l <symbol>` for faster symbol-file discovery.',
      'Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass).',
      "The org 'x\" is a name, and so is --from-md 'y\".",
      'A rg-like tool or a pandoc-style filter "a; b" is prose.',
    ]) expect.soft(stripUnsafeSuggestions(text)).toBe(text)
  })
})

describe('baseline --suggest-mem', () => {
  it.skipIf(POSIX_SH === null && POWERSHELL === null)('quotes the CLAUDE.md path of a project whose directory holds $ and a zero-width space', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-mem-$MARK\u200B-'))
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# Preferences\n\n- Prefer small diffs over large rewrites\n')
      const text = formatMemSuggestions(root)
      const line = text.split('\n').find((l) => l.startsWith('Consider: mem import --from-md ')) ?? ''
      expect(line, text).not.toBe('')
      const command = 'token-goat ' + line.slice('Consider: '.length, line.indexOf('  # migrates'))
      expect(command).not.toMatch(RAW_CONTROL)
      expect(command).not.toContain(PLACEHOLDER)
      expect(command).toContain("'")
      expectShellsHoldLiterally([command])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
