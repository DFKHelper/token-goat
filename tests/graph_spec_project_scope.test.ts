/** callers, call-chain, impact and brief must scope their lookup to the project that owns the spec's file, not the project the shell happens to be in. Before, a spec naming a file in a sibling project resolved the symbol but then searched the cwd project's rows, so the callers sat in another project and the commands answered "not found" or an empty caller list. Provenance: HAND-DERIVED. The fixture is two sibling directories each holding a package.json marker (the project-root signal findProject uses) and a one-call-site source file; who calls whom follows from the source text alone. Driven through real indexing and the real commands. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { runCallChain, runCallers, runImpact } from '../src/graph_commands.js'
import { indexFileSync } from '../src/parser.js'
import { runBriefCore } from '../src/read_brief.js'

let home: string
let other: string
let cwdSpy: ReturnType<typeof vi.spyOn>
let spec: string

function run(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write
  try {
    return { code: fn(), stdout, stderr }
  } finally {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-home-')))
  other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-other-')))
  fs.writeFileSync(path.join(home, 'package.json'), '{}')
  fs.writeFileSync(path.join(other, 'package.json'), '{}')
  fs.writeFileSync(path.join(home, 'main.ts'), 'export function homeOnly(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(other, 'lib.ts'), 'export function outsideFn(): number {\n  return 2\n}\n')
  fs.writeFileSync(path.join(other, 'use.ts'), "import { outsideFn } from './lib'\nexport function useIt(): number {\n  return outsideFn()\n}\n")
  for (const f of [path.join(home, 'main.ts'), path.join(other, 'lib.ts'), path.join(other, 'use.ts')]) indexFileSync(f, globalDbPath())
  spec = `${path.join(other, 'lib.ts').replaceAll(String.fromCharCode(92), '/')}::outsideFn`
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(home)
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
})

describe('a spec naming a file in another project scopes to that project', () => {
  it('callers finds the call site in the spec file\'s project', () => {
    const r = run(() => runCallers({ symbol: spec }))
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).toContain('useIt')
  })

  it('impact reaches the caller', () => {
    const r = run(() => runImpact({ symbol: spec }))
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).toContain('useIt')
  })

  it('call-chain resolves the symbol and does not report it missing', () => {
    const r = run(() => runCallChain({ symbol: spec }))
    expect(r.stderr).not.toContain('not found')
    expect(r.code, r.stderr).toBe(0)
  })

  it('brief lists the caller', () => {
    const r = runBriefCore({ spec, projectRoot: home })
    expect(r.code, r.text).toBe(0)
    expect(r.text).toContain('useIt')
  })
})
