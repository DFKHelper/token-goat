/** The hook pointer (`hook-entry.json`) judged by its TypeScript reader on the fixture the Rust reader also runs, the writer's output, and the safe-answer table the native client carries against the adapters' own no-ops. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ADAPTER_HARNESSES, noopOutputs } from '../src/hook_adapters.js'
import { checkHookBroken } from '../src/cli_doctor_native.js'
import { clearHookBroken, hookBrokenPath, hookPointerPath, readHookBroken, readHookPointer, validateHookPointer, writeHookPointer } from '../src/hook_pointer.js'

interface Case {
  name: string
  files: string[]
  pointer?: unknown
  raw?: string
  rawBytes?: number
  expect: { usable: boolean; node?: boolean; shim?: boolean }
}

const EXE = process.platform === 'win32' ? '.exe' : ''
const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'hook_pointer', 'cases.json'), 'utf8')) as { cases: Case[] }
const roots: string[] = []

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ptr-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fill(text: string, root: string): string {
  return text.split('{ROOT}').join(root.split(path.sep).join('/')).split('{EXE}').join(EXE)
}

function substitute(value: unknown, root: string): unknown {
  if (typeof value === 'string') return fill(value, root)
  if (Array.isArray(value)) return value.map((v) => substitute(v, root))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, root)]))
  return value
}

describe('the shared pointer fixture', () => {
  it('has enough cases to mean something', () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(20)
  })

  for (const c of FIXTURE.cases) {
    it(`judges "${c.name}" as the fixture says`, () => {
      const root = scratch()
      for (const f of c.files) {
        const p = path.join(root, fill(f, root))
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, 'x')
      }
      const text = c.raw !== undefined ? fill(c.raw, root) : c.rawBytes !== undefined ? ' '.repeat(c.rawBytes) : JSON.stringify(substitute(c.pointer, root))
      const verdict = validateHookPointer(text)
      expect(verdict.ok, JSON.stringify(verdict)).toBe(c.expect.usable)
      if (verdict.ok) {
        expect(verdict.pointer.node !== undefined, 'node').toBe(c.expect.node)
        expect(verdict.pointer.shim !== undefined, 'shim').toBe(c.expect.shim)
      }
    })
  }
})

describe('writeHookPointer', () => {
  function bundle(): { home: string; entry: string; bin: string } {
    const root = scratch()
    const entry = path.join(root, 'dist', 'token-goat.mjs')
    const bin = path.join(root, 'dist', 'native', `tg-hook${EXE}`)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(entry, '//')
    fs.writeFileSync(bin, 'x')
    return { home: path.join(root, 'data'), entry, bin }
  }

  it('writes a pointer its own reader accepts, and rewrites it atomically over an older one', () => {
    const { home, entry, bin } = bundle()
    expect(writeHookPointer(entry, bin, home)).toBe(true)
    const first = readHookPointer(home)
    expect(first.ok && first.pointer.entry).toBe(path.resolve(entry))
    expect(writeHookPointer(entry, bin, home, () => new Date(0))).toBe(true)
    expect(JSON.parse(fs.readFileSync(hookPointerPath(home), 'utf8')).writtenAt).toBe('1970-01-01T00:00:00.000Z')
    expect(fs.readdirSync(home).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  // Windows only: a device prefix names a drive, so the prefixed spellings exist only where paths carry one.
  it.runIf(process.platform === 'win32')('records the plain drive spelling of a device-prefixed entry and native binary', () => {
    const { home, entry, bin } = bundle()
    expect(writeHookPointer(`\\\\?\\${path.resolve(entry)}`, `\\\\?\\${path.resolve(bin)}`, home)).toBe(true)
    const read = readHookPointer(home)
    expect(read.ok && read.pointer.entry, 'the entry is the plain drive path').toBe(path.resolve(entry))
    const stored = JSON.parse(fs.readFileSync(hookPointerPath(home), 'utf8'))
    expect(stored.bundleDir, 'the bundle directory is the plain drive path').toBe(path.dirname(path.resolve(entry)))
    expect(stored.nativeBin, 'the native binary is the plain drive path').toBe(path.resolve(bin))
  })

  it('writes nothing for an entry that is missing or not the bundle entry, and keeps the old pointer', () => {
    const { home, entry, bin } = bundle()
    expect(writeHookPointer(entry, bin, home)).toBe(true)
    const before = fs.readFileSync(hookPointerPath(home), 'utf8')
    expect(writeHookPointer(path.join(path.dirname(entry), 'missing.mjs'), bin, home)).toBe(false)
    expect(writeHookPointer(path.join(path.dirname(entry), 'gone', 'token-goat.mjs'), bin, home)).toBe(false)
    expect(fs.readFileSync(hookPointerPath(home), 'utf8')).toBe(before)
  })

  it('refuses a nativeBin the reader would reject, keeps the old pointer, and writes one it accepts', () => {
    const { home, entry, bin } = bundle()
    expect(writeHookPointer(entry, bin, home)).toBe(true)
    const before = fs.readFileSync(hookPointerPath(home), 'utf8')
    const wrongName = path.join(path.dirname(bin), 'other-binary')
    expect(writeHookPointer(entry, wrongName, home), 'a name that is not tg-hook').toBe(false)
    expect(writeHookPointer(entry, '', home), 'an empty name').toBe(false)
    expect(fs.readFileSync(hookPointerPath(home), 'utf8')).toBe(before)
    expect(writeHookPointer(entry, bin, home, () => new Date(0)), 'the accepted name still writes').toBe(true)
    expect(readHookPointer(home).ok).toBe(true)
  })

  it('does not throw when the data directory cannot be created', () => {
    const { home, entry, bin } = bundle()
    fs.writeFileSync(home, 'a file where the directory should be')
    expect(writeHookPointer(entry, bin, home)).toBe(false)
  })
})

describe('the hook-broken notice', () => {
  it('reads a notice the native client wrote and clears it, absent already being fine', () => {
    const home = scratch()
    expect(readHookBroken(home)).toBeUndefined()
    const notice = { schema: 1, first: 'a', last: 'b', count: 2, events: [{ time: 't', route: 'node-argv', path: '/x', error: 'cannot start' }] }
    fs.writeFileSync(hookBrokenPath(home), JSON.stringify(notice))
    expect(readHookBroken(home)?.count).toBe(2)
    clearHookBroken(home)
    clearHookBroken(home)
    expect(fs.existsSync(hookBrokenPath(home))).toBe(false)
  })

  it('treats garbage as no notice', () => {
    const home = scratch()
    fs.writeFileSync(hookBrokenPath(home), '{"schema":9}')
    expect(readHookBroken(home)).toBeUndefined()
  })
})

// HAND-DERIVED: the notice events are written as native deadline.rs / fallback.rs record them (route names as written there).
describe('checkHookBroken splits busy answers from route failures', () => {
  const busy = { time: 't', route: 'deadline-busy', path: '', error: 'no lane freed before the deadline; the host was told to run the call again' }
  const failure = { time: 't', route: 'node-argv', path: '/x', error: 'cannot start' }
  function writeNotice(home: string, events: readonly object[], count: number): void {
    fs.writeFileSync(hookBrokenPath(home), JSON.stringify({ schema: 1, first: 'a', last: 'b', count, events }))
  }

  it('gives one non-fail busy row and no FAIL when every event is a busy answer', () => {
    const home = scratch()
    writeNotice(home, [busy, busy], 2)
    expect(checkHookBroken(home)).toEqual([{ name: 'Hook busy answers', status: 'ok', message: expect.stringContaining('2 hook calls were answered busy') }])
  })

  it('gives a FAIL row counting only the route failure, beside the busy row', () => {
    const home = scratch()
    writeNotice(home, [busy, failure, busy], 3)
    expect(checkHookBroken(home)).toEqual([
      { name: 'Hook busy answers', status: 'ok', message: expect.stringContaining('2 hook calls were answered busy') },
      { name: 'Hook fallback', status: 'fail', message: expect.stringContaining('left their first route 1 time ') },
    ])
  })

  it('gives the busy row alone when the notice holds only a busy object', () => {
    const home = scratch()
    fs.writeFileSync(hookBrokenPath(home), JSON.stringify({ schema: 1, count: 0, events: [], busy: { count: 20, first: 'a', last: 'b' } }))
    expect(checkHookBroken(home)).toEqual([{ name: 'Hook busy answers', status: 'ok', message: expect.stringContaining('20 hook calls were answered busy') }])
  })

  it('counts a busy object beside one route failure, and the FAIL counts only the route failure', () => {
    const home = scratch()
    fs.writeFileSync(hookBrokenPath(home), JSON.stringify({ schema: 1, first: 'a', last: 'b', count: 1, events: [failure], busy: { count: 20, first: 'a', last: 'b' } }))
    expect(checkHookBroken(home)).toEqual([
      { name: 'Hook busy answers', status: 'ok', message: expect.stringContaining('20 hook calls were answered busy') },
      { name: 'Hook fallback', status: 'fail', message: expect.stringContaining('left their first route 1 time ') },
    ])
  })

  it('gives no row at all without a notice', () => {
    expect(checkHookBroken(scratch())).toEqual([])
  })
})

describe('the native client safe-answer table', () => {
  const table = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'native', 'tg-hook', 'safe_answers.json'), 'utf8')) as Record<string, { noop: string; events: Record<string, string> }>

  it('names every adapter harness and nothing else', () => {
    expect(Object.keys(table).sort()).toEqual([...ADAPTER_HARNESSES].sort())
  })

  for (const harness of ADAPTER_HARNESSES) {
    it(`matches the ${harness} adapter's no-op for every event`, () => {
      const { noop, noops } = noopOutputs(harness)
      expect(table[harness]?.noop).toBe(noop)
      expect(Object.entries(table[harness]?.events ?? {}).sort()).toEqual([...noops].sort())
    })
  }
})
