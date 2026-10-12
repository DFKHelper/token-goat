/** Guard: a flag an agent guesses must not cost a round trip. `read f.ts --lines 1-5` is rewritten to the spec grammar and run; a guessed rename (`--top` for `--limit`, `--search` for `--grep`) is rewritten and run the same way when its value is certain, and fails as before with the corrected command when it is not. Provenance: the failure text in the bundle cases is CAPTURE (the unchanged main-checkout bundle, run in an isolated home on 2026-10-11: `read f.ts --lines 1-5` -> "token-goat: unknown option '--lines'", `search foo --top 3` -> "unknown option '--top'", `read f.ts --start 2 --end 4` -> "unknown option '--start'" then "(Did you mean --stats?)"); the rewrite and suggestion expectations are HAND-DERIVED from the `file@A-B` spec grammar in src/read_spec.ts and from the quoting rules in src/hint_suggestion_guard.ts, not from option_intent.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { GLOBAL_VALUE_OPTIONS } from '../src/command_intent.js'
import { FLAG_RENAMES, LINE_RANGE_FLAGS, rewriteFlagRename, rewriteLineRangeFlag, rewriteOptionIntent, suggestForUnknownOption } from '../src/option_intent.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// Provenance. The commander text the bundle cases expect (`unknown option '--top'`, `unknown option '--lines'`) is CAPTURE: `node dist/token-goat.mjs search foo --top 3` and `read f.ts --lines abc` run through the built bundle on 2026-10-11 printed exactly that; `(Did you mean --stats?)` for `read f.ts --start 2` was captured in the same run. The spec forms (`f.ts@2-4`) are FORMAT-DERIVED from the read spec grammar in src/read_spec.ts (parseLineRange). The suggested commands in the unit cases are HAND-DERIVED: the alias swapped for its real flag, written out by hand.
const argvOf = (...args: string[]): string[] => ['node', 'token-goat', ...args]

describe('rewriteLineRangeFlag', () => {
  it('turns a whole-range flag into the spec suffix', () => {
    const r = rewriteLineRangeFlag(argvOf('read', 'f.ts', '--lines', '1-5'))
    expect(r?.argv).toEqual(argvOf('read', 'f.ts@1-5'))
    expect(r?.note).toBe('Note: ran as `token-goat read "f.ts@1-5"` (--lines is not an option; a line range goes in the spec as @A-B).')
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

  // `--offset` is the first line and `--limit` how many, the Read-tool meaning: 3 and 4 are lines 3, 4, 5, 6.
  it('reads an offset and a count as the first line and how many', () => {
    const r = rewriteLineRangeFlag(argvOf('read', 'f.ts', '--offset', '3', '--limit', '4'))
    expect(r?.argv).toEqual(argvOf('read', 'f.ts@3-6'))
    expect(r?.note).toContain('--offset and --limit are not options')
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts', '--limit=1', '--offset=9'))?.argv).toEqual(argvOf('read', 'f.ts@9-9'))
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
      argvOf('read', 'f.ts', '--offset', '3'),
      argvOf('read', 'f.ts', '--limit', '4'),
      argvOf('read', 'f.ts', '--offset', '3', '--limit', '0'),
      argvOf('read', 'f.ts', '--offset', '0', '--limit', '4'),
      argvOf('read', 'f.ts', '--start', '2', '--limit', '3'),
      argvOf('read', 'f.ts', '--offset', '2', '--end', '3'),
      argvOf('read', 'f.ts', '--start', '5', '--end', '2'),
      argvOf('read', 'f.ts', '--lines', '0'),
      argvOf('read', 'f.ts', '--lines', '5-2'),
      argvOf('read', 'f.ts', '--lines', '1-2-3'),
    ]
    for (const argv of alone) expect(rewriteLineRangeFlag(argv), argv.join(' ')).toBeNull()
  })
})

describe('rewriteFlagRename', () => {
  it('runs a renamed limit with its value carried over', () => {
    const r = rewriteFlagRename(argvOf('search', 'foo', '--top', '3'))
    expect(r?.argv).toEqual(argvOf('search', 'foo', '--limit', '3'))
    expect(r?.note).toBe('Note: ran as `token-goat search "foo" --limit 3` (--top is not an option; the flag is --limit).')
    expect(rewriteFlagRename(argvOf('recall', 'x', '-k', '5'))?.argv).toEqual(argvOf('recall', 'x', '--limit', '5'))
    expect(rewriteFlagRename(argvOf('semantic', 'x y', '--max=4'))?.argv).toEqual(argvOf('semantic', 'x y', '--limit=4'))
    expect(rewriteFlagRename(argvOf('search', '--count', '2', 'foo'))?.argv).toEqual(argvOf('search', '--limit', '2', 'foo'))
  })

  it('runs a renamed filter on a cached output with its value carried over', () => {
    for (const command of ['bash-output', 'web-output', 'mcp-output']) {
      for (const alias of ['--search', '--filter', '--pattern']) {
        const r = rewriteFlagRename(argvOf(command, 'ab12', alias, 'ERR'))
        expect(r?.argv, `${command} ${alias}`).toEqual(argvOf(command, 'ab12', '--grep', 'ERR'))
        expect(r?.note).toBe(`Note: ran as \`token-goat ${command} "ab12" --grep "ERR"\` (${alias} is not an option; the flag is --grep).`)
      }
    }
    expect(rewriteFlagRename(argvOf('bash-output', 'ab12', '--search=a b'))?.argv).toEqual(argvOf('bash-output', 'ab12', '--grep=a b'))
  })

  // Each of these has a value or a choice the rename cannot settle, so the failure carries the suggestion instead.
  it('leaves an invocation alone when the translation is not certain', () => {
    const alone = [
      argvOf('search', 'foo', '--top', 'abc'),
      argvOf('search', 'foo', '--top', '0'),
      argvOf('search', 'foo', '--top', '-3'),
      argvOf('search', 'foo', '--top'),
      argvOf('search', 'foo', '--top', '3', '--limit', '5'),
      argvOf('search', 'foo', '--top', '3', '-l', '5'),
      argvOf('search', 'foo', '--top', '3', '--max', '4'),
      argvOf('search', 'foo', '--top', '3', '-k', '4'),
      argvOf('search', 'foo', '--', '--top', '3'),
      argvOf('bash-output', 'ab12', '--search'),
      argvOf('bash-output', 'ab12', '--search', '--json'),
      argvOf('bash-output', 'ab12', '--search='),
      argvOf('bash-output', 'ab12', '--search', 'ERR', '--grep', 'WARN'),
      argvOf('bash-output', 'ab12', '--search', 'a`b'),
      argvOf('bash-output', 'ab12', '--lines', '5'),
      argvOf('read', 'f.ts', '--top', '3'),
      argvOf('search', 'foo'),
      argvOf('--top', '3'),
    ]
    for (const argv of alone) expect(rewriteFlagRename(argv), argv.join(' ')).toBeNull()
  })
})

// HAND-DERIVED: each argv is one invocation written out by hand; the expected notes are the argv with the flag swapped, escaped the way displaySafeText escapes a control character (ESC is \x1b).
describe('what the rewrites echo back', () => {
  it('escapes a control character in the spec and refuses a spec that would break the fence', () => {
    expect(rewriteLineRangeFlag(argvOf('read', 'a\u001b[31m.ts', '--lines', '1-2'))?.note).toBe('Note: ran as `token-goat read "a\\x1b[31m.ts@1-2"` (--lines is not an option; a line range goes in the spec as @A-B).')
    expect(rewriteLineRangeFlag(argvOf('read', 'a`b.ts', '--lines', '1-2'))).toBeNull()
    expect(rewriteLineRangeFlag(argvOf('read', 'a\nb.ts', '--lines', '1-2'))).toBeNull()
    expect(rewriteLineRangeFlag(argvOf('read', 'a\rb.ts', '--lines', '1-2'))).toBeNull()
  })

  it('quotes an inline value and escapes a control character in a renamed flag', () => {
    expect(rewriteFlagRename(argvOf('bash-output', 'ab12', '--search=\u001b[31mERR'))?.note).toBe('Note: ran as `token-goat bash-output "ab12" --grep "\\x1b[31mERR"` (--search is not an option; the flag is --grep).')
    expect(rewriteFlagRename(argvOf('web-output', 'ab12', '--filter=$(id)'))?.note).toBe("Note: ran as `token-goat web-output \"ab12\" --grep '$(id)'` (--filter is not an option; the flag is --grep).")
    expect(rewriteFlagRename(argvOf('search', 'foo', '--top=3'))?.note).toBe('Note: ran as `token-goat search "foo" --limit 3` (--top is not an option; the flag is --limit).')
  })
})

describe('a path that holds an @', () => {
  // HAND-DERIVED: only a trailing @N or @N-M is a line range (parseLineRange); an @ inside a path is part of the name.
  it('still gets its line range, since only a trailing @N or @N-M names a place', () => {
    expect(rewriteLineRangeFlag(argvOf('read', 'node_modules/@types/node/index.d.ts', '--lines', '3-4'))?.argv).toEqual(argvOf('read', 'node_modules/@types/node/index.d.ts@3-4'))
    expect(rewriteLineRangeFlag(argvOf('read', 'C:/Users/a@b.com/x.ts', '--lines', '3'))?.argv).toEqual(argvOf('read', 'C:/Users/a@b.com/x.ts@3'))
    expect(suggestForUnknownOption(argvOf('section', 'node_modules/@types/node/index.d.ts', '--lines', '1-2'))).toBe('Did you mean: `token-goat read "node_modules/@types/node/index.d.ts@1-2"`?')
  })

  it('leaves a spec that already ends in a line range alone', () => {
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts@1-5', '--lines', '3'))).toBeNull()
    expect(rewriteLineRangeFlag(argvOf('read', 'f.ts@7', '--lines', '3'))).toBeNull()
  })
})

describe('a global option before the command', () => {
  it('names the program options that take a value, as the program registers them', () => {
    const takesValue = buildProgram().options.filter((o) => o.required || o.optional).map((o) => o.long)
    expect([...takesValue].sort()).toEqual([...GLOBAL_VALUE_OPTIONS].sort())
  })

  it('does not mistake the value of --cwd or --notice for the command', () => {
    expect(rewriteLineRangeFlag(argvOf('--cwd', 'X', 'read', 'f.ts', '--lines', '1-5'))?.argv).toEqual(argvOf('--cwd', 'X', 'read', 'f.ts@1-5'))
    expect(rewriteFlagRename(argvOf('--notice', 'hi', 'search', 'foo', '--top', '3'))?.argv).toEqual(argvOf('--notice', 'hi', 'search', 'foo', '--limit', '3'))
    expect(rewriteFlagRename(argvOf('--cwd', 'X', 'search', 'foo', '--top', '3'))?.note).toBe('Note: ran as `token-goat search "foo" --limit 3` (--top is not an option; the flag is --limit).')
    expect(suggestForUnknownOption(argvOf('--cwd', 'X', 'section', 'README.md', '--lines', '1-5'))).toBe('Did you mean: `token-goat read "README.md@1-5"`?')
    expect(suggestForUnknownOption(argvOf('--cwd', 'X', 'search', 'foo', '--top', '3', '--max', '4'))).toBe('Did you mean: `token-goat search "foo" --limit 3 --limit 4`?')
  })

  it('leaves a global option that is itself named like a guess alone', () => {
    expect(rewriteFlagRename(argvOf('--notice', '--top', 'search', 'foo'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('--notice', '--top', 'search', 'foo', '--bogus'))).toBeNull()
  })
})

describe('rewriteOptionIntent', () => {
  it('picks the line-range rewrite for read and the rename rewrite for the rest', () => {
    expect(rewriteOptionIntent(argvOf('read', 'f.ts', '--lines', '1-5'))?.command).toBe('read')
    expect(rewriteOptionIntent(argvOf('search', 'foo', '--top', '3'))?.command).toBe('search')
    expect(rewriteOptionIntent(argvOf('search', 'foo', '--top', '3'))?.flags).toEqual(['--top'])
    expect(rewriteOptionIntent(argvOf('search', 'foo'))).toBeNull()
  })
})

describe('suggestForUnknownOption', () => {
  it('names the read command for a line range given to section, which has no range grammar', () => {
    expect(suggestForUnknownOption(argvOf('section', 'README.md', '--lines', '1-5'))).toBe('Did you mean: `token-goat read "README.md@1-5"`?')
    expect(suggestForUnknownOption(argvOf('section', 'README.md', '--start', '2', '--end', '4'))).toBe('Did you mean: `token-goat read "README.md@2-4"`?')
    expect(suggestForUnknownOption(argvOf('section', 'README.md', '--offset=2', '--limit=3'))).toBe('Did you mean: `token-goat read "README.md@2-4"`?')
    expect(suggestForUnknownOption(argvOf('section', 'README.md::Install', '--lines', '1-5'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('section', 'README.md', '--lines', 'abc'))).toBeNull()
    expect(suggestForUnknownOption(argvOf('section', 'README.md'))).toBeNull()
  })

  it('still gives the command with the real flag when a choice, not the value, stopped the rewrite', () => {
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--top', '3', '--max', '4'))).toBe('Did you mean: `token-goat search "foo" --limit 3 --limit 4`?')
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--top', '3', '--limit', '5'))).toBe('Did you mean: `token-goat search "foo" --limit 3 --limit 5`?')
  })

  // The real flag would refuse these values, so the corrected command would fail again.
  it('gives no corrected command for a value the real flag would refuse', () => {
    for (const argv of [argvOf('search', 'foo', '--top', 'abc'), argvOf('search', 'foo', '--top', '0'), argvOf('search', 'foo', '--top'), argvOf('search', 'foo', '--top=-3'), argvOf('bash-output', 'ab12', '--search'), argvOf('bash-output', 'ab12', '--search', '--json'), argvOf('bash-output', 'ab12', '--search=')]) {
      expect(suggestForUnknownOption(argv), argv.join(' ')).toBeNull()
    }
  })

  it('gives the command with the real flag for a renamed limit', () => {
    expect(suggestForUnknownOption(argvOf('search', 'foo', '--top', '3'))).toBe('Did you mean: `token-goat search "foo" --limit 3`?')
    expect(suggestForUnknownOption(argvOf('recall', 'x', '-k', '5'))).toBe('Did you mean: `token-goat recall "x" --limit 5`?')
    expect(suggestForUnknownOption(argvOf('semantic', 'x y', '--max=4'))).toBe('Did you mean: `token-goat semantic "x y" --limit 4`?')
  })

  it('gives the command with the real flag for a renamed filter on a cached output', () => {
    expect(suggestForUnknownOption(argvOf('bash-output', 'ab12', '--search', 'ERR'))).toBe('Did you mean: `token-goat bash-output "ab12" --grep "ERR"`?')
    expect(suggestForUnknownOption(argvOf('web-output', 'ab12', '--filter=ERR'))).toBe('Did you mean: `token-goat web-output "ab12" --grep "ERR"`?')
  })

  // A `--flag=value` token is the caller's text in a hint typed back into a shell, so the value is quoted like any other value.
  it('quotes the value of an inline flag, and escapes control characters in the whole hint', () => {
    expect(suggestForUnknownOption(argvOf('web-output', 'ab12', '--filter=$(id)'))).toBe("Did you mean: `token-goat web-output \"ab12\" --grep '$(id)'`?")
    const hint = suggestForUnknownOption(argvOf('bash-output', 'ab12', '--search=\u001b[31mERR')) ?? ''
    expect(hint).toBe('Did you mean: `token-goat bash-output "ab12" --grep "\\x1b[31mERR"`?')
    expect(suggestForUnknownOption(argvOf('section', 'a\u001b.md', '--lines', '1-2'))).toBe('Did you mean: `token-goat read "a\\x1b.md@1-2"`?')
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

  it('names no line-range flag that read or section registers', () => {
    for (const command of ['read', 'section']) {
      const options = optionsOf(command)
      for (const flag of Object.values(LINE_RANGE_FLAGS).flat()) expect(options, `${command} ${flag}`).not.toContain(flag)
    }
  })

  // --lines is a real option on the cached-output commands (a-b, 1-based), which is why it is not a rename there: the table would shadow it.
  it('keeps --lines out of the rename table because the cached-output commands register it', () => {
    for (const command of ['bash-output', 'web-output', 'mcp-output']) expect(optionsOf(command), command).toContain('--lines')
    expect(FLAG_RENAMES.flatMap((r) => r.aliases)).not.toContain('--lines')
  })

  it('names, as other spellings of a target, only flags that the command registers or that are short forms', () => {
    for (const rename of FLAG_RENAMES) {
      for (const command of rename.commands) {
        const options = optionsOf(command)
        for (const spelling of rename.targetSpellings) if (!/^-[a-z]$/.test(spelling)) expect(options, `${command} ${spelling}`).toContain(spelling)
      }
    }
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
      expect(r.stderr).toContain('Note: ran as `token-goat read "f.ts@2-4"`')
    }
  })

  it('runs a renamed limit and says so on stderr', () => {
    const real = runBundle(['search', 'foo', '--limit', '3'], { cwd: base, env })
    for (const flags of [['--top', '3'], ['-k', '3'], ['--max=3'], ['--count', '3']]) {
      const r = runBundle(['search', 'foo', ...flags], { cwd: base, env })
      expect(r.status, flags.join(' ')).toBe(real.status)
      expect(r.stdout.replace(/\d+ms/, 'Nms')).toBe(real.stdout.replace(/\d+ms/, 'Nms'))
      expect(r.stderr).toContain('Note: ran as `token-goat search "foo" --limit')
      expect(r.stderr).not.toContain('unknown option')
    }
  })

  it('runs a renamed filter on a cached output and says so on stderr', () => {
    for (const alias of ['--search', '--filter', '--pattern']) {
      const r = runBundle(['bash-output', 'zz00', alias, 'ERR'], { cwd: base, env })
      expect(r.stderr, alias).toContain(`Note: ran as \`token-goat bash-output "zz00" --grep "ERR"\` (${alias} is not an option; the flag is --grep).`)
      expect(r.stderr).not.toContain('unknown option')
    }
  })

  it('keeps commander’s failure and appends the corrected command when two guesses stop the rename', () => {
    const r = runBundle(['search', 'foo', '--top', '3', '--max', '4'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--top'")
    expect(r.stderr).toContain('Did you mean: `token-goat search "foo" --limit 3 --limit 4`?')
    expect(r.stderr).not.toContain('Note: ran as')
  })

  // CAPTURE (dogfood of this branch's previous build, 2026-10-12): `search zzqq --top abc` printed commander's `unknown option '--top'` plus ``Did you mean: `token-goat search "zzqq" --limit "abc"`?``, and that command fails again, so no corrected command is offered for a value the real flag would refuse.
  it('offers no corrected command for a limit that is not a positive integer', () => {
    const r = runBundle(['search', 'foo', '--top', 'abc'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--top'")
    expect(r.stderr).not.toContain('Did you mean: `')
    expect(r.stderr).not.toContain('Note: ran as')
  })

  it('rewrites a command that follows a global option and its value', () => {
    const r = runBundle(['--cwd', base, 'read', 'f.ts', '--lines', '2-3'], { cwd: os.tmpdir(), env })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('line2')
    expect(r.stderr).toContain('Note: ran as `token-goat read "f.ts@2-3"`')
  })

  it('prints nothing raw to the terminal for an escape in a spec or a pattern', () => {
    const noteOf = (stderr: string): string => stderr.split('\n').find((l) => l.startsWith('Note: ran as')) ?? ''
    const spec = noteOf(runBundle(['read', 'e\u001b[31mx.ts', '--lines', '1-2'], { cwd: base, env }).stderr)
    expect(spec).toContain('token-goat read "e\\x1b[31mx.ts@1-2"')
    expect(spec).not.toContain('\u001b')
    const grep = noteOf(runBundle(['bash-output', 'zz00', '--search=\u001b[31mERR'], { cwd: base, env }).stderr)
    expect(grep).toContain('--grep "\\x1b[31mERR"')
    expect(grep).not.toContain('\u001b')
  })

  it('leaves the real --lines of a cached output command alone', () => {
    const r = runBundle(['bash-output', 'zz00', '--lines', '1-2'], { cwd: base, env })
    expect(r.stderr).not.toContain('unknown option')
    expect(r.stderr).not.toContain('Note: ran as')
  })

  it('names the read command for a line range given to section', () => {
    const r = runBundle(['section', 'f.ts', '--lines', '1-2'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--lines'")
    expect(r.stderr).toContain('Did you mean: `token-goat read "f.ts@1-2"`?')
  })

  it('books each rewrite and each suggestion as a cli_option_alias stat', () => {
    const ownBase = path.join(base, 'own')
    fs.mkdirSync(ownBase)
    const own = tgIsolatedEnv(ownBase, { TOKEN_GOAT_HOME: path.join(ownBase, 'tg') })
    runBundle(['read', 'f.ts', '--lines', '2-4'], { cwd: base, env: own })
    runBundle(['search', 'foo', '--top', '3'], { cwd: base, env: own })
    runBundle(['read', 'f.ts', '--lines', 'abc'], { cwd: base, env: own })
    runBundle(['search', 'foo', '--top', '3', '--max', '4'], { cwd: base, env: own })
    const stats = JSON.parse(runBundle(['stats', '--json'], { cwd: base, env: own }).stdout) as { by_kind: Record<string, { events: number }> }
    expect(stats.by_kind['cli_option_alias']?.events).toBe(3)
  })

  it('leaves a flag with no safe translation to commander alone', () => {
    const r = runBundle(['read', 'f.ts', '--lines', 'abc'], { cwd: base, env })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown option '--lines'")
    expect(r.stderr).not.toContain('Did you mean: `')
    expect(r.stderr).not.toContain('Note: ran as')
  })
})
