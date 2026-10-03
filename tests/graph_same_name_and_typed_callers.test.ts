/** Graph commands: (1) impact must keep a caller that shares its name with the symbol asked about; (2) callers must keep a typed call site in a file that defines its own same-named symbol, as `refs --callers` does; (3) callers, impact and call-chain must report an overloaded `file::Class.method` as ambiguous with `@line` picks, as `read` does, instead of "not found". Provenance: HAND-DERIVED. The fixtures are small TypeScript files whose definitions, overloads and call sites follow from the source text alone; they are driven through real indexing and the real commands. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { runCallChain, runCallers, runImpact } from '../src/graph_commands.js'
import { runDead } from '../src/graph_inspection.js'
import { indexFileSync } from '../src/parser.js'
import { runRefs } from '../src/read_refs.js'
import { setTsModuleForTesting } from '../src/ts_compiler.js'
import * as realTs from 'typescript'
import type * as TsModule from 'typescript'

let home: string
let cwdSpy: ReturnType<typeof vi.spyOn>

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

function put(rel: string, text: string): void {
  const full = path.join(home, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
  indexFileSync(full, globalDbPath())
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-graph-same-')))
  fs.writeFileSync(path.join(home, 'package.json'), '{}')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(home)
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('a same-named caller and a typed call site survive the graph filters', () => {
  beforeEach(() => {
    put('service.ts', 'export class Service {\n  run(): number {\n    return 1\n  }\n}\n')
    put('other.ts', "import { Service } from './service'\nexport class Other {\n  run(): number {\n    return new Service().run()\n  }\n}\nexport function useOther(): number {\n  return new Other().run()\n}\n")
  })

  it('callers and impact both list Other.run, the same-named caller of Service.run', () => {
    const spec = `${path.join(home, 'service.ts')}::Service.run`
    const callers = run(() => runCallers({ symbol: spec }))
    expect(callers.code, callers.stderr).toBe(0)
    expect(callers.stdout).toContain('other.ts:4')
    const impact = run(() => runImpact({ symbol: spec }))
    expect(impact.code, impact.stdout + impact.stderr).toBe(0)
    expect(impact.stdout).toMatch(/^run\t/m)
  })

  it('impact expands a same-named caller by its own definition, not into callers of a third same-named method', () => {
    put('outer.ts', 'export class Outer {\n  run(): number {\n    return 2\n  }\n}\nexport function call(): number {\n  return new Outer().run()\n}\n')
    const impact = run(() => runImpact({ symbol: `${path.join(home, 'service.ts')}::Service.run` }))
    expect(impact.code, impact.stdout + impact.stderr).toBe(0)
    expect(impact.stdout).toMatch(/^run\t\(hops: 1\)$/m)
    expect(impact.stdout).toMatch(/^useOther\t\(hops: 2\)$/m)
    expect(impact.stdout).not.toMatch(/^call\t/m)
  })

  it('dead does not report a method whose only callers sit in files defining their own same-named symbol', () => {
    put('calc.ts', 'export class Calc {\n  total(): number {\n    return 1\n  }\n  unused(): number {\n    return 2\n  }\n}\n')
    put('sum.ts', "import { Calc } from './calc'\nexport class Sum {\n  total(): number {\n    return new Calc().total()\n  }\n}\nexport const s = new Sum().total()\n")
    put('use.ts', "import { Calc } from './calc'\nexport function total(): number {\n  return 0\n}\nexport const t = new Calc().total() + total()\n")
    const dead = run(() => runDead({ kind: 'method', json: true }))
    expect(dead.code, dead.stderr).toBe(0)
    const listed = (JSON.parse(dead.stdout) as { items: Array<{ file: string; line: number }> }).items.map((r) => `${path.basename(r.file)}:${r.line}`)
    expect(listed).toContain('calc.ts:5')
    expect(listed).not.toContain('calc.ts:2')
  })

  it('keeps a typed call site in a file that defines its own same-named symbol, as refs --callers does', () => {
    put('wrap.ts', "import { Service } from './service'\nexport function run(): number {\n  return 0\n}\nexport function useIt(s: Service): number {\n  return s.run() + run()\n}\n")
    const spec = `${path.join(home, 'service.ts')}::Service.run`
    const callers = run(() => runCallers({ symbol: spec }))
    const refs = run(() => runRefs({ spec, callers: true, projectRoot: home }))
    expect(refs.stdout).toContain('wrap.ts')
    expect(callers.stdout).toContain('wrap.ts')
  })
})

describe('impact scopes a whole hop level through one growing compiler program', () => {
  afterEach(() => {
    setTsModuleForTesting(undefined)
  })

  it('builds one program for the root and one per level that adds files, not one per shared-name node', () => {
    // A.go and B.exec both call Service.run, and each shares its name with an unrelated method (X.go, Y.exec), so both hop-1 nodes are scoped; their refs bring in x.ts and y.ts, which the root's program did not hold. Scoped together that is one rebuild for the level, so two programs in all; scoped one node at a time it is three, and on a real project each was a ~600ms program built per node.
    put('service.ts', 'export class Service {\n  run(): number {\n    return 1\n  }\n}\n')
    put('a.ts', "import { Service } from './service'\nexport class A {\n  go(): number {\n    return new Service().run()\n  }\n}\nexport function useA(): number {\n  return new A().go()\n}\n")
    put('x.ts', 'export class X {\n  go(): number {\n    return 3\n  }\n}\nexport function useX(): number {\n  return new X().go()\n}\n')
    put('b.ts', "import { Service } from './service'\nexport class B {\n  exec(): number {\n    return new Service().run()\n  }\n}\nexport function useB(): number {\n  return new B().exec()\n}\n")
    put('y.ts', 'export class Y {\n  exec(): number {\n    return 4\n  }\n}\nexport function useY(): number {\n  return new Y().exec()\n}\n')
    let programs = 0
    setTsModuleForTesting({
      ...realTs,
      createProgram: (opts: TsModule.CreateProgramOptions) => {
        programs += 1
        return realTs.createProgram(opts)
      },
    } as unknown as typeof TsModule)

    const impact = run(() => runImpact({ symbol: `${path.join(home, 'service.ts')}::Service.run` }))

    expect(impact.code, impact.stdout + impact.stderr).toBe(0)
    expect(impact.stdout).toMatch(/^go\t\(hops: 1\)$/m)
    expect(impact.stdout).toMatch(/^exec\t\(hops: 1\)$/m)
    expect(impact.stdout).toMatch(/^useA\t\(hops: 2\)$/m)
    expect(impact.stdout).toMatch(/^useB\t\(hops: 2\)$/m)
    expect(impact.stdout).not.toMatch(/^useX\t/m)
    expect(impact.stdout).not.toMatch(/^useY\t/m)
    expect(programs).toBe(2)
  })
})

describe('an overloaded qualified spec is reported as ambiguous by every graph command', () => {
  it('lists the @line picks and exits 1 instead of saying not found', () => {
    put('app.ts', 'export class Outer {\n  run(a: string): void\n  run(a: number): void\n  run(a: unknown): void {\n    void a\n  }\n}\n')
    const spec = `${path.join(home, 'app.ts')}::Outer.run`
    for (const [name, fn] of [
      ['callers', () => runCallers({ symbol: spec })],
      ['impact', () => runImpact({ symbol: spec })],
      ['call-chain', () => runCallChain({ symbol: spec })],
      ['refs', () => runRefs({ spec, callers: true, projectRoot: home })],
    ] as const) {
      const r = run(fn)
      const text = r.stdout + r.stderr
      expect(r.code, `${name}: ${text}`).toBe(1)
      expect(text, name).not.toContain('not found')
      expect(text, name).toContain('Ambiguous symbol')
      expect(text, name).toContain('Outer.run@2')
      expect(text, name).toContain(`${name} `)
    }
  })

  it('refs with several symbols refuses an overloaded one instead of printing "no references found"', () => {
    put('app.ts', 'export class Outer {\n  run(a: string): void\n  run(a: number): void\n  run(a: unknown): void {\n    void a\n  }\n}\nexport function other(): void {}\n')
    const r = run(() => runRefs({ spec: `${path.join(home, 'app.ts')}::Outer.run,other`, callers: true, projectRoot: home }))
    const text = r.stdout + r.stderr
    expect(r.code, text).toBe(1)
    expect(text).toContain('Outer.run@2')
    expect(text).not.toContain('no references found')
  })
})
