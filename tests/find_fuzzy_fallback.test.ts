/**
 * Regression: `find` was a case-insensitive SUBSTRING scan over symbol names, but the docs
 * advertised it as the fuzzy lookup to reach for when an exact `symbol` lookup misses on a typo.
 * A substring scan cannot reach a typo that drops, swaps, or mistypes a character (`getUserr` is
 * neither a substring of `getUser` nor the reverse), so the single case the command was most
 * often reached FOR returned "No indexed files match".
 *
 * `find` now falls back to the same edit-distance ranking `Did you mean:` uses, but ONLY when the
 * substring pass found nothing -- so a real match is never reordered or displaced, and a query
 * near nothing still reports a clean miss rather than dredging up noise.
 *
 * Mirrors tests/find_project_scope.test.ts: exercises the real querySymbols/getDb path against a
 * real (test-isolated) global.db rather than mocking index_reader.js.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runFind } from '../src/read_commands.js'

/** Capture stdout AND stderr: the fuzzy-fallback note is emitted on stderr, the file list on stdout. */
function capture(fn: () => number): { stdout: string; stderr: string; code: number } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  let code: number
  try {
    code = fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = origErr
  }
  return { stdout, stderr, code }
}

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function addSymbol(file: string, name: string): void {
  const db = getDb(globalDbPath())
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`${normalizePath(root)}/${file}`, name, 'function', 1, 1, '', '')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-find-fuzzy-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('runFind fuzzy fallback', () => {
  it('recovers a mistyped name that no substring scan could reach', () => {
    addSymbol('user.ts', 'getUser')

    // 'getUserr' is neither a substring of 'getUser' nor the reverse -- the exact case the
    // docs point at this command for, and the case that used to return nothing.
    const { stdout, code } = capture(() => runFind({ pattern: 'getUserr' }))

    expect(code).toBe(0)
    expect(stdout).toContain('user.ts')
  })

  it('names the symbol it actually matched, so a caller cannot mistake it for their own spelling', () => {
    addSymbol('user.ts', 'getUser')

    const { stderr } = capture(() => runFind({ pattern: 'getUserr' }))

    expect(stderr).toContain('getUser')
    expect(stderr).toContain("No symbol name contains 'getUserr'")
    // Singular, since exactly one name matched -- the count-dependent branch that a
    // multi-match fixture would never exercise.
    expect(stderr).toContain('nearest indexed name:')
    expect(stderr).not.toContain('nearest indexed names:')
  })

  it('uses the plural wording when more than one name is equally near', () => {
    addSymbol('a.ts', 'parseConfig')
    addSymbol('b.ts', 'parseConfog')

    const { stderr } = capture(() => runFind({ pattern: 'parseConfng' }))

    expect(stderr).toContain('nearest indexed names:')
  })

  it('never runs when the substring pass found something: an exact match is not displaced by a near one', () => {
    addSymbol('exact.ts', 'parseConfig')
    addSymbol('near.ts', 'parseConfog')

    const { stdout, stderr, code } = capture(() => runFind({ pattern: 'parseConfig' }))

    expect(code).toBe(0)
    expect(stdout).toContain('exact.ts')
    // 'parseConfog' does not contain 'parseConfig', so it must not appear: the fuzzy pass is
    // gated off entirely whenever containment matched.
    expect(stdout).not.toContain('near.ts')
    expect(stderr).not.toContain('nearest indexed')
  })

  it('still reports a clean miss for a query near nothing, rather than dredging up unrelated names', () => {
    // The anti-regression half: the fallback must not turn every miss into a match. This name
    // is far past any typo budget for the query, so the old exit-1 message must survive.
    addSymbol('user.ts', 'getUser')

    const { stderr, code } = capture(() => runFind({ pattern: 'zzzcompletelyunrelated' }))

    expect(code).toBe(1)
    expect(stderr).toContain("No indexed files match 'zzzcompletelyunrelated'")
    expect(stderr).not.toContain('nearest indexed')
  })

  it('--json flags a fuzzy recovery with dedicated fields', () => {
    addSymbol('user.ts', 'getUser')

    const { stdout } = capture(() => runFind({ pattern: 'getUserr', json: true }))

    const payload = JSON.parse(stdout) as { files: string[]; fuzzy?: boolean; matchedNames?: string[] }
    expect(payload.fuzzy).toBe(true)
    expect(payload.matchedNames).toEqual(['getUser'])
    expect(payload.files.length).toBeGreaterThan(0)
  })

  it('--json omits the fuzzy fields entirely on an exact hit, so a consumer can tell the two apart', () => {
    addSymbol('user.ts', 'getUser')

    const { stdout } = capture(() => runFind({ pattern: 'getUser', json: true }))

    const payload = JSON.parse(stdout) as { files: string[]; fuzzy?: boolean; matchedNames?: string[] }
    expect(payload.fuzzy).toBeUndefined()
    expect(payload.matchedNames).toBeUndefined()
    expect(payload.files.length).toBeGreaterThan(0)
  })

  it('orders files by ranking closeness, closest name first', () => {
    // 'parseConfog' is one edit from the query, 'parseConfigure' is further; the closer name's
    // file must lead, which a plain index-order pass would not guarantee.
    addSymbol('far.ts', 'parseConfigure')
    addSymbol('close.ts', 'parseConfog')

    const { stdout } = capture(() => runFind({ pattern: 'parseConfng' }))

    const closeIdx = stdout.indexOf('close.ts')
    const farIdx = stdout.indexOf('far.ts')
    expect(closeIdx).toBeGreaterThanOrEqual(0)
    if (farIdx >= 0) expect(closeIdx).toBeLessThan(farIdx)
  })
})
