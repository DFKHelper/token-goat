/**
 * `types --exclude-tests`: every sibling read command (dead, refs, call-chain, symbol, semantic,
 * brief) already has this opt-in filter; `types` was the only one missing it. Mirrors
 * `dead`/`symbol`'s own `--exclude-tests` test files as the template -- same two traps: filtering
 * after `--limit` would silently under-return, and reporting a filtered-to-nothing result as a
 * bare "No type declarations found" would turn "you asked the wrong question" into "there is no
 * answer".
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runTypes } from '../src/graph_commands.js'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Insert one type-kind symbol at `file` (relative to the temp project root) under `name`. */
function addType(file: string, name: string, kind = 'interface'): void {
  const db = getDb(globalDbPath())
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`${normalizePath(root)}/${file}`, name, kind, 1, 1, `interface ${name} {}`, '')
}

/** Run `fn` with `process.stdout.write` captured, returning whatever it wrote. */
function captureStdout(fn: () => void): string {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}

/** Run `fn` with `process.stderr.write` captured, returning whatever it wrote. */
function captureStderr(fn: () => void): string {
  let captured = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = origWrite
  }
  return captured
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-types-xtests-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('types --exclude-tests', () => {
  it('hides a test-file type declaration while keeping the src one', () => {
    addType('src/foo.ts', 'Foo')
    addType('tests/foo.test.ts', 'Foo')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true }) })

    expect(code).toBe(0)
    expect(out).toContain('src/foo.ts')
    expect(out).not.toContain('foo.test.ts')
  })

  it('leaves output unchanged when the flag is omitted, so the default is not silently narrowed', () => {
    addType('src/foo.ts', 'Foo')
    addType('tests/foo.test.ts', 'Foo')

    let code = -1
    const out = captureStdout(() => { code = runTypes({}) })

    expect(code).toBe(0)
    expect(out).toContain('src/foo.ts')
    expect(out).toContain('foo.test.ts')
  })

  it('reports the filter rather than a bare "No type declarations found" when every declaration was a test file', () => {
    addType('tests/only.test.ts', 'OnlyType')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true }) })

    expect(code).toBe(0)
    expect(out).toContain('--exclude-tests')
    expect(out).not.toContain('No type declarations found')
  })

  it('still reports a genuine miss as "No type declarations found" with exit code 1, not as a filtered-to-empty result', () => {
    let code = -1
    const err = captureStderr(() => { code = runTypes({ excludeTests: true }) })

    expect(code).toBe(1)
    expect(err).toContain('No type declarations found')
    expect(err).not.toContain('--exclude-tests')
  })

  it('does not under-return when test declarations would have filled the whole --limit window', () => {
    // Ordering mirrors runTypes' own sort: file_path first, so src/zzz.ts sorts after the src/aaa..ccc.test.ts decoys and would be the one dropped by a filter-after-limit bug.
    addType('src/aaa.test.ts', 'Crowded')
    addType('src/bbb.test.ts', 'Crowded')
    addType('src/ccc.test.ts', 'Crowded')
    addType('src/zzz.ts', 'Crowded')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true, limit: 3 }) })

    expect(code).toBe(0)
    expect(out).toContain('src/zzz.ts')
  })

  it('composes with --grep, filtering on name and path together', () => {
    addType('src/a.ts', 'ParseAlpha')
    addType('src/b.ts', 'RenderBeta')
    addType('tests/a.test.ts', 'ParseAlpha')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true, grep: 'Parse' }) })

    expect(code).toBe(0)
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('a.test.ts')
    expect(out).not.toContain('RenderBeta')
  })

  it('--json reports the post-filter count as totalCount, not the pre-filter one', () => {
    addType('src/foo.ts', 'Foo')
    addType('tests/x.test.ts', 'Foo')
    addType('tests/y.test.ts', 'Foo')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true, json: true }) })

    expect(code).toBe(0)
    const payload = JSON.parse(out) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(payload.items).toHaveLength(1)
    expect(payload.totalCount).toBe(1)
  })

  it('--json emits an empty envelope, not a not-found error, when the filter hid everything', () => {
    addType('tests/only.test.ts', 'OnlyType')

    let code = -1
    const out = captureStdout(() => { code = runTypes({ excludeTests: true, json: true }) })

    expect(code).toBe(0)
    const payload = JSON.parse(out) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(payload.items).toEqual([])
    expect(payload.totalCount).toBe(0)
    expect(payload.truncated).toBe(false)
  })
})
