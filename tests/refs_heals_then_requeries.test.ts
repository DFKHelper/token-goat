/** `refs` found stale rows, healed them, and then printed the rows it had already fetched: the answer carried the old line numbers (or a reference that no longer exists) plus a warning saying a repeat would be current. Every other multi-file command that finds its files by querying (bare `symbol`, `locate`) heals and asks again, so the first answer is already the current one. `refs` now does the same: it heals the defining file the spec names before the query, heals whatever files the query hit, and requeries once when that heal landed. A file whose reparse fails is still served with the warning and booked as a stale answer. Driven through the real `runRefs` against a real index built with `indexFileSync`; the parser is failed on demand only for the reparse-failure case. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Parser from '../src/parser.js'

// Fails the reparse only while `heal.fail` is set, so fixtures still index for real and the heal's own catch path is the one exercised.
const heal = vi.hoisted(() => ({ fail: false }))
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Parser>()
  return {
    ...actual,
    indexFileSync: (...args: Parameters<typeof actual.indexFileSync>) => {
      if (heal.fail) throw new Error('simulated reparse failure')
      return actual.indexFileSync(...args)
    },
  }
})

import { fingerprintFile } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRefs } from '../src/read_refs.js'
import { getGlobalDb } from '../src/stats.js'
import { captureStdout } from './helpers/capture-stdout.js'

let root: string
let origCwd: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-refs-heal-')))
  origCwd = process.cwd()
  process.chdir(root)
  heal.fail = false
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  heal.fail = false
  vi.restoreAllMocks()
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

function warnings(): string {
  return warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
}

function staleRows(): string[] {
  const rows = getGlobalDb().prepare(`SELECT kind, detail FROM stats WHERE kind LIKE 'stale_served:%' ORDER BY rowid`).all() as Array<{ kind: string; detail: string | null }>
  return rows.map((r) => `${r.kind} ${r.detail ?? ''}`)
}

function refs(spec: string, json = false): { out: string; code: number } {
  let code = -1
  const out = captureStdout(() => {
    code = runRefs({ spec, ...(json ? { json: true } : {}) })
  })
  return { out, code }
}

function writeIndexed(name: string, body: string): string {
  const file = join(root, name)
  writeFileSync(file, body)
  indexFileSync(normalizePath(file))
  return file
}

// HAND-DERIVED: a one-function TypeScript module and one caller. The index outlives each case's temp directory, so every case passes its own symbol name and no case can see another's rows.
const def = (fn: string): string => `export function ${fn}(): number {\n  return 1\n}\n`
const caller = (fn: string, between = ''): string => `import { ${fn} } from './heal_def4v.js'\n${between}${fn}()\n`

describe('refs heals stale rows and answers from the fresh ones', () => {
  it('a caller that moved its call site out of band is reported at the line it is on now, with no warning', () => {
    const fn = 'healRefTarget4va'
    const defFile = writeIndexed('heal_def4v.ts', def(fn))
    const callerFile = writeIndexed('heal_caller4v.ts', caller(fn))
    // HAND-DERIVED: two lines inserted above the call move it from line 2 to line 4.
    writeFileSync(callerFile, caller(fn, '// one\n// two\n'))
    const before = staleRows().length

    const { out, code } = refs(`${defFile}::${fn}`, true)
    expect(code).toBe(0)
    const payload = JSON.parse(out) as { items: Array<{ filePath: string; line: number }> }
    const lines = payload.items.filter((i) => i.filePath.endsWith('heal_caller4v.ts')).map((r) => r.line)
    expect(lines).toContain(4)
    expect(lines).not.toContain(2)
    expect(warnings()).toBe('')
    expect(staleRows().slice(before)).toEqual([])
    const resolved = normalizePath(callerFile)
    expect(getFileEntry(resolved)?.sha).toBe(fingerprintFile(resolved))
  })

  it('a reference deleted out of band is no longer listed', () => {
    const fn = 'healRefTarget4vb'
    const defFile = writeIndexed('heal_def4v.ts', def(fn))
    const callerFile = writeIndexed('heal_caller4v.ts', caller(fn))
    writeFileSync(callerFile, '// the call is gone\nexport const nothing4v = 0\n')

    // Exit 1 is refs' "No references found": the only reference there was is gone.
    const { out, code } = refs(`${defFile}::${fn}`)
    expect(out).not.toContain('heal_caller4v.ts')
    expect(code).toBe(1)
    expect(warnings()).toBe('')
  })

  it('a call added to the defining file out of band is found, because the spec names that file', () => {
    const fn = 'healRefTarget4vc'
    const defFile = writeIndexed('heal_def4v.ts', def(fn))
    // HAND-DERIVED: a same-file caller the index has never seen, on line 5; no indexed row can lead the query to it.
    writeFileSync(defFile, def(fn) + `export function healRefUser4v(): number {\n  return ${fn}()\n}\n`)

    const { out, code } = refs(`${defFile}::${fn}`, true)
    expect(code).toBe(0)
    const payload = JSON.parse(out) as { items: Array<{ filePath: string; line: number }> }
    expect(payload.items.some((i) => i.filePath.endsWith('heal_def4v.ts') && i.line === 5)).toBe(true)
  })
})

describe('refs on a changed file that could not be reindexed', () => {
  it('still warns and books one stale answer per reply rather than per file', () => {
    const fn = 'healRefTarget4vd'
    const defFile = writeIndexed('heal_def4v.ts', def(fn))
    for (const name of ['heal_caller_a4v.ts', 'heal_caller_b4v.ts']) {
      writeIndexed(name, caller(fn))
      writeFileSync(join(root, name), caller(fn, '// touched\n'))
    }
    heal.fail = true
    const before = staleRows().length

    expect(refs(`${defFile}::${fn}`).code).toBe(0)
    expect(warnings()).toMatch(/changed on disk/)
    expect(staleRows().slice(before)).toEqual(['stale_served:stale refs'])
  })
})
