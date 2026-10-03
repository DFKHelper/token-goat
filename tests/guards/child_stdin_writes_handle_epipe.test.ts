import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const TESTS = path.resolve(import.meta.dirname, '..')
const WRITE = /\b(\w+)\.stdin\.(?:write|end)\(/g
const CHILD_PROCESS = /from '(?:node:)?child_process'/

function testSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'fixtures' || e.name === 'node_modules' ? [] : testSources(p)
    return e.name.endsWith('.ts') && p !== import.meta.filename ? [p] : []
  })
}

/** Every test source that spawns a child process and writes to its stdin, pinned so a moved directory or a renamed import cannot empty the scan and leave it passing. */
function writerFiles(): readonly string[] {
  const items = testSources(TESTS).filter((f) => {
    const src = fs.readFileSync(f, 'utf8')
    return CHILD_PROCESS.test(src) && /\.stdin\.(?:write|end)\(/.test(src)
  }).map((f) => path.relative(TESTS, f).split(path.sep).join('/'))
  return pinnedPopulation({ what: 'test files writing to a child process stdin', items, floor: 4, mustInclude: ['native_hook_install_e2e.test.ts', 'hook_server.test.ts', 'helpers/matrix_cases.ts'] })
}

/** Every receiver in `src` that writes to a child process's stdin without a stdin 'error' listener in the same file; a file that never imports child_process writes to an in-memory stream instead and is skipped. */
function unguardedWriters(src: string): string[] {
  if (!CHILD_PROCESS.test(src)) return []
  const receivers = new Set([...src.matchAll(WRITE)].map((m) => m[1]))
  return [...receivers].filter((r) => !src.includes(`${r}.stdin.on('error'`))
}

// Provenance: CAPTURE, CI run 37043944974 (test-linux shard 3, commit d6e16bcb): every test passed, yet the run failed on two uncaught `Error: write EPIPE` thrown from `child.stdin.end(...)` at tests/native_hook_install_e2e.test.ts:197, because a hook child that exits before reading its stdin makes the pending write fail and an EventEmitter error with no listener is thrown at the process. The exit code and stdout each case asserts on already report a child that died early, so the write error is noise that only a listener keeps from failing an otherwise green run.
describe('child process stdin writes in tests', () => {
  it('each has an error listener, so a child that exits before reading cannot fail the run with EPIPE', () => {
    const offenders = writerFiles().flatMap((f) => unguardedWriters(fs.readFileSync(path.join(TESTS, f), 'utf8')).map((r) => `${f}: ${r}.stdin`))
    expect(offenders).toEqual([])
  })

  it('flags an unguarded writer and accepts a guarded one, so the scan above cannot pass vacuously', () => {
    const spawned = "import { spawn } from 'node:child_process'\nconst child = spawn('x')\n"
    expect(unguardedWriters(`${spawned}child.stdin.end('{}')\n`)).toEqual(['child'])
    expect(unguardedWriters(`${spawned}child.stdin.on('error', () => undefined)\nchild.stdin.end('{}')\n`)).toEqual([])
    expect(unguardedWriters("const h = new PassThrough()\nh.stdin.write('x')\n")).toEqual([])
  })
})
