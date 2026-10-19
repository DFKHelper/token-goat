/** `refs <file>::<symbol>` answered from every project on the machine, so the real caller of a TypeScript `store` came back buried under (or replaced by) a Python test in an unrelated project that merely called its own `store`; and a caller that imported `store as snapshotStore` was never listed at all, because only the local spelling was indexed. Provenance: the code shapes are HAND-DERIVED (written here from the reporter's description, independent of the matcher). The paths and the test name `test_label_store_*` in the leak rows are CAPTURE: the output the reporter saw from `token-goat refs src/snapshots.ts::store --callers` on 2.9.31 listed two rows from `TorqueTrace/.../tests/test_answer_sheet_calibration.py` (lines 355 and 357) and missed `src/hooks_read_post.ts:67`, which imports `store as snapshotStore`. The rows index through the real indexer (`indexFileSync` -> the `refs` table in `global.db`) and query through the real `runRefs`; nothing is injected. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRefs } from '../src/read_refs.js'

import { captureStdout } from './helpers/capture-stdout.js'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function seed(root: string, rel: string, body: string): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  indexFileSync(normalizePath(file), globalDbPath())
}

function refs(spec: string, flags: { callers?: boolean } = {}): { code: number; out: string } {
  let code = -1
  const out = captureStdout(() => {
    code = runRefs({ spec, ...flags })
  })
  return { code, out }
}

beforeEach(() => {
  rootA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refsscope-a-')))
  rootB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refsscope-b-')))
  fs.mkdirSync(path.join(rootA, '.git'))
  fs.mkdirSync(path.join(rootB, '.git'))
  seed(rootA, 'a.ts', 'export function store(value: number): number {\n  return value\n}\n\nexport function useStore(): number {\n  return store(1)\n}\n')
  seed(rootA, 'c.ts', 'export function helper(): number {\n  return 2\n}\n\nexport function runHelper(): number {\n  return helper()\n}\n')
  seed(rootB, 'tests/test_snapshots.py', 'def test_label_store_roundtrip():\n    assert store(1) == 1\n\n\ndef test_label_store_again():\n    assert store(2) == 2\n')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('refs file::symbol with cross_project_symbols left at its default', () => {
  it('lists the caller in its own project and nothing from the project that shares the name', () => {
    const { code, out } = refs('a.ts::store')
    expect(code, out).toBe(0)
    expect(out).toContain('useStore')
    expect(out).not.toContain('test_label_store')
    expect(out).not.toContain(path.basename(rootB))
  })

  it('--callers stays in the project too', () => {
    const { code, out } = refs('a.ts::store', { callers: true })
    expect(code, out).toBe(0)
    expect(out).toContain('useStore')
    expect(out).not.toContain('test_label_store')
    expect(out).not.toContain(path.basename(rootB))
  })

  it('the same-file multi-symbol form stays in the project', () => {
    const { code, out } = refs('a.ts::store,useStore')
    expect(code, out).toBe(0)
    expect(out).toContain('useStore')
    expect(out).not.toContain('test_label_store')
  })

  it('the cross-file form stays in the project', () => {
    const { code, out } = refs('a.ts::store,c.ts::helper')
    expect(code, out).toBe(0)
    expect(out).toContain('runHelper')
    expect(out).not.toContain('test_label_store')
  })

  it('a bare name is still searched machine-wide', () => {
    const { code, out } = refs('store')
    expect(code, out).toBe(0)
    expect(out).toContain('useStore')
    expect(out).toContain('test_label_store')
  })
})

describe('refs through an import alias', () => {
  beforeEach(() => {
    seed(rootA, 'snapshots.ts', 'export function snap(value: number): number {\n  return value\n}\n')
    seed(rootA, 'elsewhere.ts', 'export function snap(value: number): number {\n  return -value\n}\n')
    seed(rootA, 'consumer.ts', "import { snap as snapshotSnap } from './snapshots.js'\n\nexport function saveAll(): number {\n  return snapshotSnap(1)\n}\n")
    seed(rootA, 'other_consumer.ts', "import { snap as otherSnap } from './elsewhere.js'\n\nexport function loadAll(): number {\n  return otherSnap(2)\n}\n")
  })

  it('--callers lists the call made under the local name', () => {
    const { code, out } = refs('snapshots.ts::snap', { callers: true })
    expect(code, out).toBe(0)
    expect(out).toContain('consumer.ts')
    expect(out).toContain('saveAll')
  })

  it('the plain form lists it too', () => {
    const { code, out } = refs('snapshots.ts::snap')
    expect(code, out).toBe(0)
    expect(out).toContain('consumer.ts')
  })

  it('a call through an alias of a different definition with the same name is not listed', () => {
    const { code, out } = refs('snapshots.ts::snap', { callers: true })
    expect(code, out).toBe(0)
    expect(out).not.toContain('other_consumer.ts')
    expect(out).not.toContain('loadAll')
  })
})
