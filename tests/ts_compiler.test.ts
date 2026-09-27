/** src/ts_compiler.ts is the one place the `typescript` compiler API is loaded, for ts_refs.ts (the type-resolved `refs` tier) and dep_docs.ts (the `.d.ts` outline), which each carried a copy of the loader until the two were merged. The copies had drifted: dep_docs.ts dropped the load error that `doctor` reports, and clearModuleCaches never cleared its test override, so a test that forced the compiler away left it away for the rest of the file. These pin the merged loader through both consumers. PROVENANCE: HAND-DERIVED. The declaration and definition texts and the failing require are written here; nothing is captured from a run. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractDtsOutline } from '../src/dep_docs.js'
import { clearModuleCaches } from '../src/reset.js'
import { isAvailable, loadError, loadTs, setTsModuleForTesting } from '../src/ts_compiler.js'
import { resolveTypedRefs, type ResolveTypedRefsInput } from '../src/ts_refs.js'

const DTS = 'export declare function foo(): void;\n'

afterEach(() => {
  setTsModuleForTesting(undefined)
})

describe('the typescript compiler API loader', () => {
  it('loads the installed compiler once and hands every caller the same module', () => {
    const first = loadTs()
    expect(first?.version, 'calibration: the cases below read null as the override, so the real compiler has to load here').toBe(ts.version)
    expect(loadTs()).toBe(first)
    expect(isAvailable()).toBe(true)
    expect(loadError()).toBeNull()
  })

  it('takes both consumers offline with one override, so neither keeps a loader of its own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ts-compiler-'))
    try {
      const defFile = path.join(dir, 'def.ts')
      fs.writeFileSync(defFile, 'export function run(): void {}\n')
      const input: ResolveTypedRefsInput = { defFile, defLineStart: 1, defLineEnd: 1, symbolName: 'run', candidates: [] }
      expect(resolveTypedRefs(input), 'calibration: the real compiler resolves this definition, so the null below is the override').toEqual([])
      setTsModuleForTesting(null)
      expect(extractDtsOutline('/fake/index.d.ts', DTS)).toBeNull()
      expect(resolveTypedRefs(input)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops the override for both consumers on clearModuleCaches', () => {
    setTsModuleForTesting(null)
    clearModuleCaches()
    expect(extractDtsOutline('/fake/index.d.ts', DTS)?.map((row) => row.name)).toEqual(['foo'])
    expect(isAvailable()).toBe(true)
  })

  it('keeps a failed require for loadError and does not attempt it again', async () => {
    const attempts: string[] = []
    vi.resetModules()
    vi.doMock('node:module', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      createRequire: () => (id: string) => {
        attempts.push(id)
        throw new Error(`Cannot find module '${id}'`)
      },
    }))
    try {
      const fresh = await import('../src/ts_compiler.js')
      expect(fresh.loadTs()).toBeNull()
      expect(fresh.isAvailable()).toBe(false)
      expect(fresh.loadError()?.message).toBe("Cannot find module 'typescript'")
      expect(attempts).toEqual(['typescript'])
    } finally {
      vi.doUnmock('node:module')
      vi.resetModules()
    }
  })
})
