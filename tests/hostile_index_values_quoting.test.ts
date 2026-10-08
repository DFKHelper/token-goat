/** A suggested command built from an indexed name must never run more than token-goat. quotedArg single-quoted a value holding `$` or a backtick only when single quotes could hold the rest of it, and otherwise fell back to double quotes, where both shells substitute: `x/$(echo MARK)` + U+0001 + `.ts::run` came out as `"x/$(echo MARK)\x01.ts::run"`. A file name, a markdown heading, a JSON key and a TS identifier can each carry such a value, and several commands printed it with no escaping at all. Provenance: HAND-DERIVED. The hostile values are built from the shell rules alone (what bash and PowerShell rewrite inside each quote mark), the payload is the inert `echo MARK`, and the oracle is two real shells, each running the suggestion through a `token-goat` function that prints its argv: the value must arrive as the literal reading of its quotes, or the command must be the unquotable placeholder. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAnswer } from '../src/answer_router.js'
import { resolveNoteAnchor } from '../src/cli_file_ops.js'
import { runAsk } from '../src/graph_commands.js'
import { runContextFor } from '../src/graph_analysis.js'
import { quotedArg, quotedArgs } from '../src/hint_suggestion_guard.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRead } from '../src/read_commands.js'
import { runSection } from '../src/read_section.js'
import { runSymbol } from '../src/read_symbol.js'
import { literalArgv, POSIX_SH, POWERSHELL, powershellRunAll, shRunAll } from './helpers/shell_argv.js'

const PLACEHOLDER = '<a value no quote mark can hold>'

/** A character that must never reach a printed command raw: C0 controls, zero-width marks and bidi overrides. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u200B-\u200D\u202A-\u202E]/

/** What a shell runs when it substitutes or splits: each with the inert `echo MARK`. */
const PAYLOADS = ['$(echo MARK)', '`echo MARK`', '${MARK}', '$MARK', '; echo MARK', '& echo MARK', '| echo MARK', 'plain']
/** What a value can carry beside a payload: line breaks, C0 and ESC, zero-width and bidi characters, PowerShell's curly quotes, both ASCII quotes, and backslash runs before a quote or at the end. */
const EXTRAS = ['', '\r', '\n', '\u0001', '\u001b', '\u200B', '\u200D', '\u202E', '\u2018', '\u2019', '\u201C', '\u201D', "'", '"', '\\', '\\\\', '\\"', "\\'", `'"`]
const VALUES = PAYLOADS.flatMap((p) => EXTRAS.map((e) => `src/x ${p}${e}.ts::run`))

/** Every `token-goat …` command in `text`, cut at a fence or the line end; the guard's own omission notice is not a command. */
function commandsIn(text: string): string[] {
  return Array.from(text.matchAll(/token-goat [^`\r\n]*/g), (m) => m[0].trimEnd()).filter((c) => !c.startsWith('token-goat (command omitted'))
}

/** Each shell must hand every command to token-goat exactly as its quotes read literally, and run nothing else. A placeholder command is left out: it names no value. Git Bash drops a carriage return from evaluated text however it is quoted, so its expectation leaves CR out on Windows. */
function expectShellsHoldLiterally(all: readonly string[]): void {
  const commands = all.filter((c) => !c.includes(PLACEHOLDER))
  if (commands.length === 0) return
  const want = commands.map((c) => ({ calls: [literalArgv(c)], stray: [] }))
  if (POSIX_SH !== null) {
    const got = shRunAll(POSIX_SH, commands)
    const shWant = process.platform === 'win32' ? want.map((w) => ({ calls: w.calls.map((a) => a.map((s) => s.replaceAll('\r', ''))), stray: [] })) : want
    commands.forEach((c, i) => expect.soft(got[i], `sh: ${JSON.stringify(c)}`).toEqual(shWant[i]))
  }
  if (POWERSHELL !== null) {
    const got = powershellRunAll(POWERSHELL, commands)
    commands.forEach((c, i) => expect.soft(got[i], `PowerShell: ${JSON.stringify(c)}`).toEqual(want[i]))
  }
}

describe('quotedArg and quotedArgs over hostile values', () => {
  it('writes the placeholder for $ or a backtick beside a control character, rather than double quotes', () => {
    expect(quotedArg('x/$(echo MARK)\u0001.ts::run')).toBe(`"${PLACEHOLDER}"`)
    expect(quotedArg('a`b\u202E')).toBe(`"${PLACEHOLDER}"`)
    expect(quotedArg("it's $5")).toBe(`"${PLACEHOLDER}"`)
    expect(quotedArg('a\n$b')).toBe(`"${PLACEHOLDER}"`)
  })

  it('writes the placeholder for a line break alone, which splits the command where each line is read on its own', () => {
    expect(quotedArg('a.ts::refresh\nnext')).toBe(`"${PLACEHOLDER}"`)
    expect(quotedArg('a\rb')).toBe(`"${PLACEHOLDER}"`)
    expect(quotedArgs('a\nb.ts', '<base64>')).toEqual([`"${PLACEHOLDER}"`, '"<base64>"'])
    expect(quotedArgs('x/$(echo MARK)\u0001.ts', '<base64>')).toEqual([`"${PLACEHOLDER}"`, '"<base64>"'])
  })

  it('writes the placeholder for a $ value whose neighbour forces double quotes', () => {
    expect(quotedArgs('src/a$b.json', "['a.b']")).toEqual([`"${PLACEHOLDER}"`, `"['a.b']"`])
  })

  it('single-quotes a backslash run that bash would read as an escape inside double quotes', () => {
    expect(quotedArg('dir\\')).toBe("'dir\\'")
    expect(quotedArg('a\\\\b')).toBe("'a\\\\b'")
    expect(quotedArg('C:\\Users\\a.ts')).toBe('"C:\\Users\\a.ts"')
  })

  // Two shell runs of several hundred commands, each capped at 120 s by tests/helpers/shell_argv.ts: the budget is both caps, since the test's 60 s default was crossed at about 50 s of work on a machine under load.
  it.skipIf(POSIX_SH === null && POWERSHELL === null)('every value reaches the command as written in both shells, or is the placeholder', () => {
    const commands = VALUES.flatMap((v) => [`token-goat read ${quotedArg(v)}`, `token-goat replace ${quotedArgs(v, '<base64>').join(' ')}`])
    expect(commands.filter((c) => !c.includes(PLACEHOLDER)).length).toBeGreaterThan(100)
    expectShellsHoldLiterally(commands)
    for (const v of VALUES) {
      const q = quotedArg(v)
      if (!q.includes(PLACEHOLDER)) expect.soft(literalArgv(`token-goat read ${q}`), JSON.stringify(v)).toEqual(['read', v])
    }
  }, 240_000)
})

/** Stdout and stderr written while `fn` runs. */
function captureOutput(fn: () => unknown): string {
  let text = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const record = ((chunk: string | Uint8Array): boolean => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  process.stdout.write = record
  process.stderr.write = record
  try {
    const r = fn()
    if (r !== null && typeof r === 'object' && 'text' in r) text += String((r as { text: string }).text)
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return text
}

describe('suggestions built from hostile names in a real index', () => {
  let project: string
  let previousCwd: string
  // A TS identifier may hold `$` and a zero-width joiner; NTFS and POSIX both allow `$(`, `)` and U+200B in a file name; a markdown heading and a JSON key may hold a C0 control.
  const IDENT = 'zzHost$q\u200Dr'
  const FILE_NAME = 'zz$(echo MARK)\u200B.ts'
  const HEADING = 'Setup $(echo MARK)\u0001'
  const KEY = '$(echo MARK)\u0001k'

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'tg-hostile-names-'))
    writeFileSync(join(project, 'package.json'), '{"name":"hostile-names"}\n')
    mkdirSync(join(project, 'src'))
    const body = Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const ts = join(project, 'src', FILE_NAME)
    writeFileSync(ts, `export function ${IDENT}(): number {\n${body}\n  return 1\n}\n\nexport class Aa {\n  ${IDENT}(): number {\n    return 2\n  }\n}\n\nexport class Bb {\n  ${IDENT}(): number {\n    return 3\n  }\n  ${IDENT}x(): number {\n    return 4\n  }\n}\n\nexport class Cc {\n  ${IDENT}x(): number {\n    return 5\n  }\n}\n`)
    const md = join(project, 'doc.md')
    writeFileSync(md, `# Doc\n\n## ${HEADING}\n\none\n\n## ${HEADING}\n\ntwo\n`)
    const json = join(project, 'conf.json')
    writeFileSync(json, JSON.stringify({ top: { [KEY]: 1 } }, null, 2) + '\n')
    const other = join(project, 'src', 'other.ts')
    writeFileSync(other, 'export const zzOther = 1\n')
    for (const f of [ts, other, md, json]) indexFileSync(normalizePath(f))
    previousCwd = process.cwd()
    process.chdir(project)
  })

  afterAll(() => {
    process.chdir(previousCwd)
    rmSync(project, { recursive: true, force: true })
  })

  /** Every command `text` suggests: none double-quotes a `$` or backtick, and both shells hold each one literally. With `escaped`, the site escaped the value before quoting it, so the command names it rather than falling back to the placeholder. */
  function expectSafeSuggestions(text: string, escaped = false): void {
    const commands = commandsIn(text)
    if (escaped) expect.soft(commands.filter((c) => c.includes(PLACEHOLDER)), 'escape-first site wrote the placeholder').toEqual([])
    expect(commands.length, text).toBeGreaterThan(0)
    for (const c of commands) {
      expect.soft(c, 'double-quoted $ or backtick').not.toMatch(/"[^"]*[$`][^"]*"/)
      expect.soft(c, 'raw control, zero-width or bidi character').not.toMatch(RAW_CONTROL)
    }
    expectShellsHoldLiterally(commands)
  }

  it('symbol: the full-body hint for a long body', () => {
    const text = captureOutput(() => runSymbol({ name: IDENT, projectRoot: project }))
    expect(text).toContain('full body:')
    expectSafeSuggestions(text, true)
  })

  it('read: the ambiguity retries for a name defined three times', () => {
    const text = captureOutput(() => runRead({ spec: `src/${FILE_NAME}::${IDENT}`, projectRoot: project }))
    expect(text).toContain('Ambiguous')
    expectSafeSuggestions(text)
  })

  it('read: the cross-file lead for a name another file defines', () => {
    const text = captureOutput(() => runRead({ spec: `src/other.ts::${IDENT}`, projectRoot: project }))
    expect(text).toContain('is defined in')
    expectSafeSuggestions(text)
  })

  it('note --anchor: the qualified-name retries for an ambiguous anchor', () => {
    let message = ''
    try {
      resolveNoteAnchor(`src/${FILE_NAME}::${IDENT}x`, project, project)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('Ambiguous')
    // Each retry is the option alone (`->  --anchor "…"`), so it is checked as the note command it completes.
    expectSafeSuggestions(Array.from(message.matchAll(/->\s+(--anchor .*)$/gm), (m) => `token-goat note add x ${m[1]!}`).join('\n'))
  })

  it('section: the ambiguity retries for a heading written twice', () => {
    const text = captureOutput(() => runSection({ spec: `doc.md::${HEADING}`, projectRoot: project }))
    expect(text).toContain('Ambiguous')
    expectSafeSuggestions(text)
  })

  it('symbol: the read-it-with hint for a nested JSON key', () => {
    const text = captureOutput(() => runSymbol({ name: KEY, projectRoot: project }))
    expect(text).toContain('is a key in')
    expectSafeSuggestions(text)
  })

  it('answer: the via line for a file question', () => {
    const text = captureOutput(() => runAnswer({ question: `what does src/${FILE_NAME} export` }))
    expect(text).toContain('via: token-goat exports')
    expectSafeSuggestions(text, true)
  })

  it('context-for and ask --json: readCmd built from escaped parts', () => {
    for (const run of [() => runContextFor({ task: 'zzHost', json: true }), () => runAsk({ question: 'zzHost', json: true })]) {
      const text = captureOutput(run)
      const cmds = Array.from(text.matchAll(/"readCmd":\s*"((?:[^"\\]|\\.)*)"/g), (m) => JSON.parse(`"${m[1]!}"`) as string)
      expect(cmds.length, text).toBeGreaterThan(0)
      for (const c of cmds) {
        expect.soft(c, 'raw control, zero-width or bidi character').not.toMatch(RAW_CONTROL)
        expect.soft(c, 'double-quoted $ or backtick').not.toMatch(/"[^"]*[$`][^"]*"/)
      }
      expect.soft(cmds.filter((c) => c.includes(PLACEHOLDER)), 'escape-first site wrote the placeholder').toEqual([])
      expectShellsHoldLiterally(cmds)
    }
  })
})
