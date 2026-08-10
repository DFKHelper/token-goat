/**
 * `symbol --exclude-tests`: the flag already existed on refs/callers/dead/semantic but not on
 * `symbol`, the most-used command of the set. Measured against this repo's own index, that gap
 * bites hard -- `symbol run` returned 18 rows of which 14 (78%) were test-file definitions, and
 * `symbol capture` returned 9 of 9. An agent reaching for `symbol` to find the production
 * implementation paid for that noise on every lookup with no way to suppress it.
 *
 * The two traps this filter has to avoid are both already documented inside runSymbol for
 * `--grep`, and both are covered below: filtering after the SQL LIMIT would let suppressed test
 * symbols occupy slots ahead of the cutoff and silently under-return, and reporting a
 * filtered-to-nothing result as a plain "No matches" would turn "you asked the wrong question"
 * into "there is no answer".
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Insert one symbol at `file` (relative to the temp project root) under `name`. */
function addSymbol(file: string, name: string, kind = 'function'): void {
  const db = getDb(globalDbPath())
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`${normalizePath(root)}/${file}`, name, kind, 1, 1, `function ${name}() {}`, '')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-symbol-xtests-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('symbol --exclude-tests', () => {
  it('hides a test-file definition while keeping the src one', () => {
    addSymbol('src/util.ts', 'helper')
    addSymbol('tests/util.test.ts', 'helper')

    const { text, code } = runSymbol({ name: 'helper', projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('src/util.ts')
    expect(text).not.toContain('util.test.ts')
  })

  it('leaves output unchanged when the flag is omitted, so the default is not silently narrowed', () => {
    // The anti-regression half: this flag is opt-in, and every existing caller must keep
    // seeing test-file definitions exactly as before.
    addSymbol('src/util.ts', 'helper')
    addSymbol('tests/util.test.ts', 'helper')

    const { text, code } = runSymbol({ name: 'helper', projectRoot: root })

    expect(code).toBe(0)
    expect(text).toContain('src/util.ts')
    expect(text).toContain('util.test.ts')
  })

  it('reports the filter rather than a bare "No matches" when every definition was a test file', () => {
    // Saying "No matches" for a symbol that IS indexed stops the caller looking. Naming the
    // filter that hid them is the difference between "wrong question" and "no answer".
    addSymbol('tests/only.test.ts', 'testOnlyHelper')

    const { text, code } = runSymbol({ name: 'testOnlyHelper', projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('--exclude-tests')
    expect(text).toContain('testOnlyHelper')
    expect(text).not.toContain('No matches')
  })

  it('uses the singular noun when exactly one test-file definition was hidden', () => {
    // Count-dependent wording: a fixture with 2+ hidden rows would never exercise this branch.
    addSymbol('tests/only.test.ts', 'testOnlyHelper')

    const { text } = runSymbol({ name: 'testOnlyHelper', projectRoot: root, excludeTests: true })

    expect(text).toContain('1 in test file hidden')
    expect(text).not.toContain('test files hidden')
  })

  it('uses the plural noun when more than one was hidden', () => {
    addSymbol('tests/a.test.ts', 'testOnlyHelper')
    addSymbol('tests/b.test.ts', 'testOnlyHelper')

    const { text } = runSymbol({ name: 'testOnlyHelper', projectRoot: root, excludeTests: true })

    expect(text).toContain('2 in test files hidden')
  })

  it('still reports a genuine miss as "No matches", not as a filtered-to-empty result', () => {
    // Negative control for the branch above: nothing was hidden, so the message must stay the
    // plain not-found one and keep its exit code 1.
    addSymbol('src/util.ts', 'helper')

    const { text, code } = runSymbol({ name: 'noSuchSymbolAnywhere', projectRoot: root, excludeTests: true })

    expect(code).toBe(1)
    expect(text).toContain('No matches')
    expect(text).not.toContain('--exclude-tests')
  })

  it('does not under-return when test symbols would have filled the whole --limit window', () => {
    // The filter-before-slice trap. querySymbols orders by `file_path, line_start`, so the
    // decoy paths are named to sort BEFORE the real one -- with `--limit 3` a filter applied
    // AFTER the SQL LIMIT would see only the three .test.ts rows, drop all of them, and report
    // nothing for a symbol that is plainly indexed in src. Sorting the real file first (the
    // obvious `tests/...` spelling, since `src/` < `tests/`) makes this assertion pass whether
    // or not the over-fetch exists, which is exactly the vacuous shape being avoided here.
    addSymbol('src/aaa.test.ts', 'crowded')
    addSymbol('src/bbb.test.ts', 'crowded')
    addSymbol('src/ccc.test.ts', 'crowded')
    addSymbol('src/zzz.ts', 'crowded')

    const { text, code } = runSymbol({ name: 'crowded', projectRoot: root, excludeTests: true, limit: 3 })

    expect(code).toBe(0)
    expect(text).toContain('src/zzz.ts')
  })

  it('composes with --grep, filtering on name and path together', () => {
    addSymbol('src/a.ts', 'parseAlpha')
    addSymbol('src/b.ts', 'renderBeta')
    addSymbol('tests/a.test.ts', 'parseAlpha')

    const { text, code } = runSymbol({ grep: 'parse', projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('a.test.ts')
    expect(text).not.toContain('renderBeta')
  })

  it('--json reports the post-filter count as totalCount, not the pre-filter one', () => {
    // countSymbols() reruns the SQL filters with no LIMIT and has no notion of "is a test
    // file", so it would report 3 here and contradict the single row it ships.
    addSymbol('src/util.ts', 'helper')
    addSymbol('tests/x.test.ts', 'helper')
    addSymbol('tests/y.test.ts', 'helper')

    const { text, code } = runSymbol({ name: 'helper', projectRoot: root, excludeTests: true, json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(payload.items).toHaveLength(1)
    expect(payload.totalCount).toBe(1)
  })

  it('--json emits an empty envelope, not a not-found error, when the filter hid everything', () => {
    addSymbol('tests/only.test.ts', 'testOnlyHelper')

    const { text, code } = runSymbol({ name: 'testOnlyHelper', projectRoot: root, excludeTests: true, json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(payload.items).toEqual([])
    expect(payload.totalCount).toBe(0)
    expect(payload.truncated).toBe(false)
  })
})
