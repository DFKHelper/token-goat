/** dead and coverage-gaps must not report a member the language invokes through syntax rather than by name: a C# or C++ operator, a conversion operator, a destructor or finalizer, and a C# indexer. No call site names them, so a name-based ref count of zero says nothing about use. A plain unused method in the same class must still be reported, so the exclusion cannot hide real dead code. Provenance: HAND-DERIVED. The fixtures are small C# and C++ classes whose members follow from the source text alone; they are driven through real indexing and the real commands. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { runCoverageGaps } from '../src/graph_analysis.js'
import { runDead } from '../src/graph_inspection.js'
import { isSyntaxInvokedName } from '../src/graph_traversal.js'
import { indexFileSync } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'

let home: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function run(fn: () => number): { code: number; stdout: string } {
  let stdout = ''
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    return { code: fn(), stdout }
  } finally {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

function put(rel: string, text: string): void {
  const full = path.join(home, rel)
  fs.writeFileSync(full, text)
  indexFileSync(full, globalDbPath())
}

const CSHARP = [
  'public class Calc {',
  '    public int v;',
  '    public int Get() { return v; }',
  '    public static Calc operator +(Calc a, Calc b) { return a; }',
  '    public static implicit operator int(Calc c) { return c.v; }',
  '    ~Calc() { }',
  '    public int this[int i] { get { return v; } }',
  '}',
  '',
].join('\n')

const CPP = [
  'struct Vec {',
  '  int x;',
  '  bool operator==(const Vec& o) const { return x == o.x; }',
  '  ~Vec() {}',
  '  int len() const { return x; }',
  '};',
  '',
].join('\n')

const SYNTAX_INVOKED = ['operator+', 'operator int', '~Calc', 'operator==', '~Vec']

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dead-syntax-')))
  fs.writeFileSync(path.join(home, 'package.json'), '{}')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(home)
  put('Calc.cs', CSHARP)
  put('Vec.cpp', CPP)
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('syntax-invoked members are not dead and not coverage gaps', () => {
  it('indexes every syntax-invoked member, so the exclusion below is not vacuous', () => {
    const names = querySymbols({ limit: 1000, rootDir: home }).map((s) => s.name)
    for (const name of SYNTAX_INVOKED) expect(names, name).toContain(name)
  })

  it('dead leaves out operators, conversions and destructors but still reports an unused named method', () => {
    const { code, stdout } = run(() => runDead({ kind: 'method,function' }))
    expect(code).toBe(0)
    const listed = stdout.split('\n').map((l) => l.split('\t')[0])
    for (const name of SYNTAX_INVOKED) expect(listed, name).not.toContain(name)
    expect(listed).toContain('Get')
  })

  it('coverage-gaps leaves them out too but still reports an untested named method', () => {
    const { code, stdout } = run(() => runCoverageGaps({ json: true }))
    expect(code).toBe(0)
    const listed = (JSON.parse(stdout) as Array<{ name: string }>).map((g) => g.name)
    for (const name of SYNTAX_INVOKED) expect(listed, name).not.toContain(name)
    expect(listed).toContain('Get')
  })
})

describe('isSyntaxInvokedName', () => {
  it('matches operator, conversion, destructor and indexer names', () => {
    for (const name of ['operator+', 'operator==', 'operator()', 'operator[]', 'operator int', 'operator new', '~Calc', 'this[]']) {
      expect(isSyntaxInvokedName(name), name).toBe(true)
    }
  })

  it('does not match an ordinary name that merely starts with "operator" or "this"', () => {
    for (const name of ['operator', 'operators', 'operatorFor', 'operator_id', 'thisValue', 'Get']) {
      expect(isSyntaxInvokedName(name), name).toBe(false)
    }
  })
})
