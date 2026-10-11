/** Guard: a flag an agent guesses must not cost a round trip. `read f.ts --lines 1-5` is rewritten to the spec grammar and run; a guessed rename (`--top` for `--limit`, `--search` for `--grep`) fails as before and the failure gains the corrected command. Provenance: the failure text in the bundle cases is CAPTURE (the unchanged main-checkout bundle, run in an isolated home on 2026-10-11: `read f.ts --lines 1-5` -> "token-goat: unknown option '--lines'", `search foo --top 3` -> "unknown option '--top'", `read f.ts --start 2 --end 4` -> "unknown option '--start'" then "(Did you mean --stats?)"); the rewrite and suggestion expectations are HAND-DERIVED from the `file@A-B` spec grammar in src/read_spec.ts and from the quoting rules in src/hint_suggestion_guard.ts, not from option_intent.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { FLAG_RENAMES, LINE_RANGE_FLAGS, rewriteLineRangeFlag, suggestForUnknownOption } from '../src/option_intent.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// Provenance. The commander text the bundle cases expect (`unknown option '--top'`, `unknown option '--lines'`) is CAPTURE: `node dist/token-goat.mjs search foo --top 3` and `read f.ts --lines abc` run through the built bundle on 2026-10-11 printed exactly that; `(Did you mean --stats?)` for `read f.ts --start 2` was captured in the same run. The spec forms (`f.ts@2-4`) are FORMAT-DERIVED from the read spec grammar in src/read_spec.ts (parseLineRange). The suggested commands in the unit cases are HAND-DERIVED: the alias swapped for its real flag, written out by hand.
const argvOf = (...args: string[]): string[] => ['node', 'token-goat', ...args]

describe('rewriteLineRangeFlag', () => {
  it('turns a whole-range flag into the spec suffix', () => {
    const r = rewriteLineRangeFlag(argvOf('read', 'f.ts', '--lines', '1-5'))
    expect(r?.argv).toEqual(argvOf('read', 'f.ts@1-5'))
    expect(r?.note).toBe('Note: ran as `read "f.ts@1-5"` (--lines is not an option; a line range goes in the spec as @A-B).')
  })

  it('accepts the inline form, a single line, the other spellings, and a flag before the file', () => {
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts', '--lines=3'))?.argv).toEqual(argvOf('read', 'f.ts@3'))
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts', '--line', '7'))?.argv).toEqual(argvOf('read', 'f.ts@7'))
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts', '--range', '2-4'))?.argv).toEqual(argvOf('read', 'f.ts@2-4'))
    expect(rewriteLineRangeFlag(argvOf('read', '--lines', '2-4', 'f.ts'))?.argv).toEqual(argvOf('read', 'f.ts@2-4'))
  })

  it('joins a start flag and an end flag, in either order and either spelling', () => {
    const r = rewriteLineRangeFlag(argvOf('read', 'f.ts', '--start', '2', '--end', '4'))
    expect(r?.argv).toEqual(argvOf('read', 'f.ts@2-4'))
    expect(r?.note).toContain('--start and --end are not options')
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts', '--to=9', '--from=6'))?.argv).toEqual(argvOf('read', 'f.ts@6-9'))
  })

  it('keeps the other flags of the command in place', () => {
    expect(rewriteLineRangeFlag(argvOf('--json', 'read', 'f.ts', '--lines', '1-5', '--no-hint'))?.argv).toEqual(argvOf('--json', 'read', 'f.ts@1-5', '--no-hint'))
  })

  // Each of these has an intent the rewrite cannot know, so commander's plain failure is the better answer.
  it('leaves an invocation alone when the intent is not certain', () => {
    const alone = [
      argvOf('read', 'f.ts', '--lines', 'abc'),
      argvOf('read', 'f.ts', '--lines'),
      argvOf('read', 'f.ts', '--lines', '1-5', '--lines', '2-3'),
      argvOf('read', 'f.ts', '--lines', '1-5', '--start', '2'),
      argvOf('read', 'f.ts', '--start', '2'),
      argvOf('read', 'f.ts', '--end', '4'),
      argvOf('read', 'f.ts', '--start', '2-3', '--end', '4'),
      argvOf('read', 'f.ts@3-9', '--lines', '1-5'),
      argvOf('read', 'f.ts::main', '--lines', '1-5'),
      argvOf('read', 'f.ts:3-9', '--lines', '1-5'),
      argvOf('read', '--lines', '1-5'),
      argvOf('read', 'a.ts', 'b.ts', '--lines', '1-5'),
      argvOf('read', 'f.ts', '--', '--lines', '1-5'),
      argvOf('read', 'f.ts'),
      argvOf('section', 'f.ts', '--lines', '1-5'),
      argvOf('read', 'f.ts', '--offset', '3', '--limit', '4'),
    ]
    for (const argv of alone) expect(rewriteLineRangeFlag(argv), argv.join(' ')).toBeNull()
  })
})

describe('suggestForUnknownOption', () => {
  it('gives the command with the real flag for a renamed limit', () => {
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--top', '3'))).toBe('Did you mean: `token-goat search "foo" --limit 3`?')
    expect(suggestForUnknownOption(argvOf('recall', 'x', '-k', '5'))).toBe('Did you mean: `token-goat recall "x" --limit 5`?')
    expect(suggestForUnknownOption(argvOf('semantic', 'x y', '--max=4'))).toBe('Did you mean: `token-goat semantic "x y" --limit=4`?')
  })

  it('gives the command with the real flag for a renamed filter on a cached output', () => {
    expect(suggestForUnknownOption(argvOf('bash-output', 'ab12', '--search', 'ERR'))).toBe('Did you mean: `token-goat bash-output "ab12" --grep "ERR"`?')
    expect(suggestForUnknownOption(argvOf('web-output', 'ab12', '--filter=ERR'))).toBe('Did you mean: `token-goat web-output "ab12" --grep=ERR`?')
  })

  it('keeps flags it does not rename exactly as given', () => {
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--json', '--top', '3'))).toBe('Did you mean: `token-goat search "foo" --json --limit 3`?')
  })

  // A value is never completed or guessed: `--lines` could be --head or --tail, so it names no rename.
  it('stays silent when no rename covers the flag or the command', () => {
    expect(suggestForUnknownOption(argvOf('bash-output', 'ab12', '--lines', '5'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--bogus'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('read', 'f.ts', '--top', '3'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('--top', '3'))).toBeNull()
  })

  it('gives no suggestion for a value that would break the fence around it', () => {
    expect(suggestForUnknownOption(argvOf('search', 'a`b', '--top', '3'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('search', 'a\nb', '--top', '3'))).toBeNull()
  })

  it('single-quotes a value holding a dollar so the shell does not expand it', () => {
    expect(suggestForUnknownOption(argvOf('search', 'a$b', '--top', '3'))).toBe("Did you mean: `token-goat search 'a$b' --limit 3`?")
  })
})

// The module promises it never shadows a real flag: a rename whose alias became a registered option would turn a working command into a suggestion.
describe('the tables against the registered commands', () => {
  const program = buildProgram()
  const optionsOf = (name: string): string[] => {
    const cmd = program.commands.find((c) => c.name() === name)
    expect(cmd, `command ${name} is registered`).toBeDefined()
    return cmd!.options.flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined))
  }

  it('names no alias that its command already registers, and a target that it does', () => {
    for (const rename of FLAG_RENAMES) {
      for (const command of rename.commands) {
        const options = optionsOf(command)
        expect(options, `${command} registers ${rename.target}`).toContain(rename.target)
        for (const alias of rename.aliases) expect(options, `${command} registers ${alias}`).not.toContain(alias)
      }
    }
  })

  it('names no line-range flag that read registers', () => {
    const options = optionsOf('read')
    for (const flag of [...LINE_RANGE_FLAGS.whole, ...LINE_RANGE_FLAGS.start, ...LINE_RANGE_FLAGS.end]) expect(options, flag).not.toContain(flag)
  })
})

describe('through the built bundle', () => {
  let base: string
  let env: NodeJS.ProcessEnv
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-option-intent-'))
    env = tgIsolatedEnv(base, { TOKEN_GOAT_HOME: path.join(base, 'tg') })
    fs.writeFileSync(path.join(base, 'f.ts'), 'line1\nline2\nline3\nline4\nline5\nline6\n')
  })
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

  it('runs a flag range as the spec form and says so on stderr', () => {
    const spec = runBundle(['read', 'f.ts@2-4'], { cwd: base, env })
    expect(spec.status).toBe(0)
    expect(spec.stdout).toContain('line3')
    expect(spec.stdout).not.toContain('line5')
    for (const flags of [['--lines', '2-4'], ['--start', '2', '--end', '4']]) {
      const r = runBundle(['read', 'f.ts', ...flags], { cwd: base, env })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(spec.stdout)
      expect(r.stderr).toContain('Note: ran as `read "f.ts@2-4"`')
    }
  })

  it('keeps commander’s failure and appends the corrected command for a renamed flag', () => {
    const r = runBundle(['search', 'foo', '--top', '3'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--top'")
    expect(r.stderr).toContain('Did you mean: `token-goat search "foo" --limit 3`?')
  })

  it('books each rewrite and each suggestion as a cli_option_alias stat', () => {
    const ownBase = path.join(base, 'own')
    fs.mkdirSync(ownBase)
    const own = tgIsolatedEnv(ownBase, { TOKEN_GOAT_HOME: path.join(ownBase, 'tg') })
    runBundle(['read', 'f.ts', '--lines', '2-4'], { cwd: base, env: own })
    runBundle(['search', 'foo', '--top', '3'], { cwd: base, env: own })
    runBundle(['read', 'f.ts', '--lines', 'abc'], { cwd: base, env: own })
    const stats = JSON.parse(runBundle(['stats', '--json'], { cwd: base, env: own }).stdout) as { by_kind: Record<string, { events: number }> }
    expect(stats.by_kind['cli_option_alias']?.events).toBe(2)
  })

  it('leaves a flag with no safe translation to commander alone', () => {
    const r = runBundle(['read', 'f.ts', '--lines', 'abc'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--lines'")
    expect(r.stderr).not.toContain('Did you mean: `')
    expect(r.stderr).not.toContain('Note: ran as')
  })
})
