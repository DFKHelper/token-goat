/** `refs` narrows a name's call sites with the TypeScript checker only once it has found the one definition the spec names, so the `file` in `file::symbol` has to be resolved to the absolute path the index stores before it is looked up. The single-symbol form did that; the same-file multi-symbol form (`a.ts::run,stop`) and the cross-file form (`a.ts::run,b.ts::run`) passed the spec's own spelling, so a relative path found no definition, the checker never ran, and every same-named method in the project was reported as a reference. Driven through the real path: indexFileSync writes the symbols and refs rows, and runRefs queries them with no mocks. Provenance: HAND-DERIVED. Two classes share a method name and each is called from its own file; which caller belongs to which class follows from the imports alone, independent of the code under test, and the single-symbol control asserts the checker separates them for this fixture. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { runRefs } from '../src/read_refs.js'

const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refs-multi-')))
  dirs.push(dir)
  const files: Record<string, string[]> = {
    'fileA.ts': ['export class Foo {', '  run(): void {', "    console.log('foo')", '  }', '  stop(): void {', "    console.log('stop')", '  }', '}'],
    'fileB.ts': ['export class Bar {', '  run(): void {', "    console.log('bar')", '  }', '}'],
    'callerA.ts': ["import { Foo } from './fileA'", 'const foo = new Foo()', 'foo.run()', 'foo.stop()'],
    'callerB.ts': ["import { Bar } from './fileB'", 'const bar = new Bar()', 'bar.run()'],
  }
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`)
    indexFileSync(path.join(dir, name), globalDbPath())
  }
  return dir
}

function stdoutOf(fn: () => number): { code: number; stdout: string } {
  let stdout = ''
  const orig = process.stdout.write.bind(process.stdout)
  const sink = (chunk: string | Uint8Array): boolean => {
    stdout += String(chunk)
    return true
  }
  process.stdout.write = sink as typeof process.stdout.write
  try {
    return { code: fn(), stdout }
  } finally {
    process.stdout.write = orig
  }
}

function jsonCallers(stdout: string): Record<string, string[]> {
  const parsed = JSON.parse(stdout) as Record<string, { items: Array<{ filePath: string }> }>
  return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, entry.items.map((i) => path.basename(i.filePath))]))
}

describe('refs with a relative defining file', () => {
  it('narrows a single symbol to its own class (control)', () => {
    const dir = project()
    const { code, stdout } = stdoutOf(() => runRefs({ spec: 'fileA.ts::run', projectRoot: dir, json: true }))
    expect(code).toBe(0)
    expect(JSON.parse(stdout).items.map((i: { filePath: string }) => path.basename(i.filePath))).toEqual(['callerA.ts'])
  })

  it('narrows each symbol of a same-file multi-symbol spec the same way', () => {
    const dir = project()
    const { code, stdout } = stdoutOf(() => runRefs({ spec: 'fileA.ts::run,stop', projectRoot: dir, json: true }))
    expect(code).toBe(0)
    expect(jsonCallers(stdout)).toEqual({ run: ['callerA.ts'], stop: ['callerA.ts'] })
  })

  it('narrows each pair of a cross-file spec to its own class', () => {
    const dir = project()
    const { code, stdout } = stdoutOf(() => runRefs({ spec: 'fileA.ts::run,fileB.ts::run', projectRoot: dir, json: true }))
    expect(code).toBe(0)
    expect(jsonCallers(stdout)).toEqual({ 'fileA.ts::run': ['callerA.ts'], 'fileB.ts::run': ['callerB.ts'] })
  })
})
