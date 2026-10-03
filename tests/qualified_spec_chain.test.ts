/** A `file::Qualifier.method` spec must match the symbol's whole enclosing chain. Before, the qualifier filter ran only when the method name had several candidates and fell back to the unscoped rows when nothing matched, so `read qual.ts::Square.area` printed Circle.area for a file with no Square (C1), and only the first and last dot segments were consulted, so `Outer2.Inner.run` was ambiguous between two classes named Inner (C2). Driven through real indexing (indexFileSync into the isolated global index) and the real read/refs/callers/call-chain/impact/brief commands. Provenance: HAND-DERIVED. Which class encloses which method follows from the nesting of the fixture source alone; the Python nesting was also checked against a real `token-goat outline` run of the same text (CAPTURE: Outer1 1-3 > Inner 2-3 > run 3; Outer2 5-7 > Inner 6-7 > run 7). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { runCallChain, runCallers, runImpact } from '../src/graph_commands.js'
import { indexFileSync } from '../src/parser.js'
import { runBriefCore } from '../src/read_brief.js'
import { runRead } from '../src/read_commands.js'
import { runRefs } from '../src/read_refs.js'
import { resolveSymbolSpec } from '../src/read_spec.js'

const QUAL = ['class Circle {', '  area(): number {', '    return 3', '  }', '}', ''].join('\n')
const NEST = [
  'class Outer1:',
  '    class Inner:',
  '        def run(self):',
  '            return 1',
  '',
  'class Outer2:',
  '    class Inner:',
  '        def run(self):',
  '            return 2',
  '',
].join('\n')

const NS = [
  'namespace Outer1 {',
  '  export class Inner {',
  '    run(): number {',
  '      return 1',
  '    }',
  '  }',
  '}',
  'namespace Outer2 {',
  '  export class Inner {',
  '    run(): number {',
  '      return 2',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

let dir: string
let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-qualchain-')))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'qual.ts'), QUAL)
  fs.writeFileSync(path.join(dir, 'nest.py'), NEST)
  fs.writeFileSync(path.join(dir, 'ns.ts'), NS)
  for (const f of ['qual.ts', 'nest.py', 'ns.ts']) indexFileSync(path.join(dir, f), globalDbPath())
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(origCwd)
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

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

describe('a wrong class qualifier is a miss, not another class method', () => {
  it('read misses and suggests the real spelling', () => {
    const r = runRead({ spec: 'qual.ts::Square.area', projectRoot: dir })
    expect(r.code).toBe(1)
    expect(r.text).toContain("Symbol 'Square.area' not found in 'qual.ts'")
    expect(r.text).toContain('Circle.area')
    expect(r.text).not.toContain('return 3')
  })

  it('read still serves the right qualifier', () => {
    const r = runRead({ spec: 'qual.ts::Circle.area', projectRoot: dir })
    expect(r.code).toBe(0)
    expect(r.text).toContain('return 3')
  })

  it('refs, callers, call-chain, impact and brief all miss', () => {
    const spec = 'qual.ts::Square.area'
    expect(run(() => runRefs({ spec, projectRoot: dir, json: true })).code).toBe(1)
    for (const fn of [() => runCallers({ symbol: spec }), () => runCallChain({ symbol: spec }), () => runImpact({ symbol: spec })]) {
      const r = run(fn)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('not found')
    }
    expect(runBriefCore({ spec, projectRoot: dir }).code).toBe(1)
  })
})

describe('a multi-segment qualifier matches the whole enclosing chain', () => {
  it('resolves Outer2.Inner.run to the one method inside Outer2.Inner', () => {
    const r = resolveSymbolSpec('nest.py::Outer2.Inner.run', undefined, dir)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.entry.lineStart).toBe(8)
    const first = resolveSymbolSpec('nest.py::Outer1.Inner.run', undefined, dir)
    expect(first.kind === 'ok' && first.entry.lineStart).toBe(3)
  })

  it('resolves a namespace-nested chain to the method inside the named namespace', () => {
    const r = resolveSymbolSpec('ns.ts::Outer2.Inner.run', undefined, dir)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.entry.lineStart).toBe(10)
    const first = resolveSymbolSpec('ns.ts::Outer1.Inner.run', undefined, dir)
    expect(first.kind === 'ok' && first.entry.lineStart).toBe(3)
  })

  it('keeps Inner.run ambiguous between the two Inner classes', () => {
    expect(resolveSymbolSpec('nest.py::Inner.run', undefined, dir).kind).toBe('ambiguous')
  })

  it('misses a chain that does not exist', () => {
    expect(resolveSymbolSpec('nest.py::Outer1.Outer2.run', undefined, dir).kind).toBe('none')
    expect(resolveSymbolSpec('nest.py::Outer3.Inner.run', undefined, dir).kind).toBe('none')
  })
})
