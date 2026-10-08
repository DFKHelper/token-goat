import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { preReadHandler } from '../src/hooks_read.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { takePendingLargeFileHint } from '../src/session.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

// The first-read symbol policy end to end, on the shipping path: a real file indexed by the real parser into the isolated global.db (tests/setup/isolate-home.ts pins TOKEN_GOAT_HOME and LOCALAPPDATA/XDG_DATA_HOME), then a Read driven through preReadHandler with no navigationEvidence injected, so getReadNavigationEvidence runs against the row indexFileSync wrote. Every evaluator test injects that evidence, which is how a seconds-vs-milliseconds mtime comparison that marked every indexed file stale shipped behind a green suite.

const tmpDirs: string[] = []

// HAND-DERIVED: a synthetic TypeScript module of `count` one-line exported functions, sized past the 50,000-byte default threshold and under the 100,000-byte generic large-file gate.
function writeLargeModule(name = 'big.ts', count = 1200): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-first-read-policy-'))
  tmpDirs.push(dir)
  const filePath = path.join(dir, name)
  const lines: string[] = []
  for (let i = 0; i < count; i++) lines.push(`export function alphaEntry${i}(value: number): number { return value + ${i} }`)
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

// HAND-DERIVED: a synthetic markdown guide of `count` `##` sections with one line of prose each, sized past the 50,000-byte default threshold.
function writeLargeMarkdown(name = 'guide.md', count = 401, headingFor: (i: number) => string = (i) => `Section ${i}`, title = 'Guide'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-first-read-policy-md-'))
  tmpDirs.push(dir)
  const filePath = path.join(dir, name)
  const sections: string[] = []
  for (let i = 0; i < count; i++) sections.push(`## ${headingFor(i)}\n\nThis section describes step ${i} of the procedure in enough words to fill a line, then says why the step matters.\n`)
  fs.writeFileSync(filePath, `# ${title}\n\n` + sections.join('\n'), 'utf8')
  return filePath
}

function firstRead(filePath: string, sessionId: string, extraInput: Record<string, unknown> = {}) {
  return preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: filePath, ...extraInput }, sessionId }))
}

/** The arguments of every recordStat call that booked a first-read-symbol deny since the spy was last cleared. */
function firstReadDenyStats(): unknown[][] {
  return vi.mocked(recordStat).mock.calls.filter((args) => args[4] === 'first-read-symbol-deny')
}

beforeEach(() => {
  clearModuleCaches()
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setPolicy(policy: 'warn' | 'deny' | 'off'): void {
  vi.stubEnv('TOKEN_GOAT_FIRST_READ_SYMBOL_POLICY', policy)
  invalidateConfigCache()
}

describe('first-read symbol policy on a really indexed file', () => {
  it('denies a whole-file first read under policy deny', () => {
    setPolicy('deny')
    const filePath = writeLargeModule()
    const size = fs.statSync(filePath).size
    expect(size).toBeGreaterThan(50_000)
    expect(size).toBeLessThan(100_000)
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-deny-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(out.message).toContain('1200 indexed symbols')
    expect(out.message).toContain('::alphaEntry0')
  })

  it('warns on a whole-file first read under policy warn', () => {
    setPolicy('warn')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-warn-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('1200 indexed symbols; prefer surgical reads')
  })

  it('stays quiet about a file indexed and then changed on disk', () => {
    setPolicy('deny')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    // HAND-DERIVED: a later edit the index has not seen, with an mtime moved well past the indexed one.
    fs.appendFileSync(filePath, 'export function lateAddition(): number { return 0 }\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(filePath, later, later)

    const out = firstRead(filePath, `policy-stale-${process.pid}-${Date.now()}`)
    expect(out.hookType === 'deny' && out.message.includes('first_read_symbol_policy')).toBe(false)
  })

  it('still denies a file whose mtime moved while its bytes did not', () => {
    setPolicy('deny')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    // HAND-DERIVED: what a branch switch back and forth does to an unchanged file, a new mtime over the same bytes.
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(filePath, later, later)

    const out = firstRead(filePath, `policy-touched-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
  })

  it('keeps the deny for a path holding $ readable once the relay guard has passed over it', () => {
    setPolicy('deny')
    // HAND-DERIVED: a legal file name holding `$`, which a double-quoted argument would expand.
    const filePath = writeLargeModule('gen$big.ts')
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-dollar-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    const relayed = stripUnsafeSuggestions(out.message)
    expect(relayed).toMatch(/Run `token-goat read '[^']*gen\$big\.ts::alphaEntry0'` to read surgically\./)
    expect(relayed).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(relayed).toMatch(/`token-goat outline '[^']*gen\$big\.ts'`/)
    expect(relayed).toMatch(/`token-goat skeleton '[^']*gen\$big\.ts'`/)
  })
})

describe('first-read symbol policy during hints.quiet_hours', () => {
  // HAND-DERIVED: an overnight window and a clock set inside it, the same pair tests/hooks_read.test.ts uses for its quiet-hours wiring.
  function enterQuietHours(): void {
    vi.stubEnv('TOKEN_GOAT_QUIET_HOURS', '22:00-06:00')
    invalidateConfigCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 1, 23, 0))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('still denies under policy deny, as every other deny does', () => {
    setPolicy('deny')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    enterQuietHours()

    const out = firstRead(filePath, `policy-quiet-deny-${process.pid}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('Whole-file first read denied by first_read_symbol_policy')
  })

  it('holds back the advisory under policy warn', () => {
    setPolicy('warn')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    enterQuietHours()

    const out = firstRead(filePath, `policy-quiet-warn-${process.pid}`)
    expect(out.hookType === 'context' && out.context.includes('prefer surgical reads')).toBe(false)
  })
})

describe('first-read symbol policy on a large markdown file', () => {
  it('keeps the deny for a path holding $ readable once the relay guard has passed over it', () => {
    setPolicy('deny')
    const filePath = writeLargeMarkdown('notes$v2.md')
    expect(fs.statSync(filePath).size).toBeGreaterThan(50_000)
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-md-dollar-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    const relayed = stripUnsafeSuggestions(out.message)
    expect(relayed).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(relayed).toMatch(/Run `token-goat section '[^']*notes\$v2\.md::[^']+'` to read surgically\./)
    expect(relayed).toMatch(/Use `token-goat outline '[^']*notes\$v2\.md'` to map sections/)
  })

  it('names no section when every heading holds a backtick, rather than a placeholder that does not exist', () => {
    setPolicy('deny')
    // HAND-DERIVED: a backtick closes a suggested command's fence, so no such heading can be named in a command and the deny has no real section to point at.
    const filePath = writeLargeMarkdown('api.md', 401, (i) => `The \`call${i}\` method`, 'The `api` module')
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-md-backticks-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(out.message).not.toContain('SectionHeading')
  })

  it('reports every heading the index holds, not a capped list', () => {
    setPolicy('deny')
    const filePath = writeLargeMarkdown()
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-md-count-${process.pid}-${Date.now()}`)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    // HAND-DERIVED: writeLargeMarkdown writes one `# Guide` and 401 `##` sections.
    expect(out.message).toContain('KB with 402 headings). Whole-file first read denied by first_read_symbol_policy.')
  })

  it('leaves an unindexed markdown file to the heading tree, as it leaves unindexed code alone', () => {
    setPolicy('deny')
    const filePath = writeLargeMarkdown()

    const out = firstRead(filePath, `policy-md-unindexed-${process.pid}-${Date.now()}`)
    expect(out.hookType === 'deny' && out.message.includes('first_read_symbol_policy')).toBe(false)
  })

  it('leaves a markdown file edited since indexing to the heading tree', () => {
    setPolicy('deny')
    const filePath = writeLargeMarkdown()
    indexFileSync(filePath, globalDbPath())
    // HAND-DERIVED: a later edit the index has not seen, with an mtime moved well past the indexed one.
    fs.appendFileSync(filePath, '\n## Late addition\n\nWritten after indexing.\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(filePath, later, later)

    const out = firstRead(filePath, `policy-md-stale-${process.pid}-${Date.now()}`)
    expect(out.hookType === 'deny' && out.message.includes('first_read_symbol_policy')).toBe(false)
  })

  it('treats first_read_symbol_bytes = 0 as off, as the code policy does', () => {
    setPolicy('deny')
    vi.stubEnv('TOKEN_GOAT_FIRST_READ_SYMBOL_BYTES', '0')
    invalidateConfigCache()
    const filePath = writeLargeMarkdown()
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, `policy-md-zero-${process.pid}-${Date.now()}`)
    expect(out.hookType === 'deny' && out.message.includes('first_read_symbol_policy')).toBe(false)
  })
})

describe('first-read symbol policy on a whole read that follows slice reads', () => {
  const session = (tag: string) => `policy-slice-${tag}-${process.pid}-${Date.now()}`

  it('denies a whole read after a slice read and books it as the first-read deny does', () => {
    setPolicy('deny')
    const direct = writeLargeModule()
    indexFileSync(direct, globalDbPath())
    expect(firstRead(direct, session('direct')).hookType).toBe('deny')
    const booked = firstReadDenyStats()
    expect(booked).toHaveLength(1)
    expect(booked[0]![1]).toBeGreaterThan(0)

    vi.mocked(recordStat).mockClear()
    const sliced = writeLargeModule()
    indexFileSync(sliced, globalDbPath())
    const sliceSession = session('sliced')
    expect(firstRead(sliced, sliceSession, { offset: 1, limit: 10 }).hookType).not.toBe('deny')
    const out = firstRead(sliced, sliceSession)
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(firstReadDenyStats()).toEqual(booked)
  })

  it('records the pending large-file hint on a warning, whether or not a slice came first', () => {
    setPolicy('warn')
    vi.stubEnv('TOKEN_GOAT_LOG_LARGE_FILE_HINT_OUTCOMES', '1')
    invalidateConfigCache()
    const direct = writeLargeModule()
    indexFileSync(direct, globalDbPath())
    expect(firstRead(direct, session('warn-direct')).hookType).toBe('context')
    expect(takePendingLargeFileHint(direct)).toBe(fs.statSync(direct).size)

    const sliced = writeLargeModule()
    indexFileSync(sliced, globalDbPath())
    const sliceSession = session('warn-sliced')
    firstRead(sliced, sliceSession, { offset: 1, limit: 10 })
    expect(takePendingLargeFileHint(sliced)).toBeNull()
    const out = firstRead(sliced, sliceSession)
    expect(out.hookType).toBe('context')
    expect(takePendingLargeFileHint(sliced)).toBe(fs.statSync(sliced).size)
  })

  it('treats the first whole read of a file read only in slices as a first read, with the large-file hint', () => {
    setPolicy('warn')
    // HAND-DERIVED: 2,000 one-line functions, about 150KB, past the 100,000-byte generic large-file gate.
    const filePath = writeLargeModule('huge.ts', 2000)
    expect(fs.statSync(filePath).size).toBeGreaterThan(100_000)
    indexFileSync(filePath, globalDbPath())
    const id = session('large')
    expect(firstRead(filePath, id, { offset: 1, limit: 10 }).hookType).toBe('pass')

    const out = firstRead(filePath, id)
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain(' is large (')
    expect(out.context).not.toContain('already read this session')
  })

  it('lets a slice of lines the session never served through without a note', () => {
    setPolicy('off')
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    const id = session('unseen')
    expect(firstRead(filePath, id, { offset: 1, limit: 10 }).hookType).toBe('pass')
    expect(firstRead(filePath, id, { offset: 500, limit: 10 }).hookType).toBe('pass')
  })

  it('denies a small slice of a file already read in full, since every line was served', () => {
    setPolicy('off')
    // The four most recent reads are protected from the count-based deny; switch that window off so the deny is what is under test.
    vi.stubEnv('TOKEN_GOAT_PROTECT_RECENT_READS', '0')
    invalidateConfigCache()
    const filePath = writeLargeModule()
    indexFileSync(filePath, globalDbPath())
    const id = session('after-whole')
    firstRead(filePath, id)
    expect(firstRead(filePath, id, { offset: 500, limit: 10 }).hookType).toBe('deny')
  })

  it('falls through to the large-file hint for a file of 100KB or more under policy warn', () => {
    setPolicy('warn')
    const filePath = writeLargeModule('huge.ts', 2000)
    indexFileSync(filePath, globalDbPath())

    const out = firstRead(filePath, session('large-first'))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain(' is large (')
    expect(out.context).not.toContain('prefer surgical reads')
  })
})

describe('first-read symbol policy and a markdown file already read in full', () => {
  it('denies a small slice of it, since the whole file was already served', () => {
    setPolicy('off')
    const filePath = writeLargeMarkdown()
    indexFileSync(filePath, globalDbPath())
    const id = `policy-md-reread-${process.pid}-${Date.now()}`
    expect(firstRead(filePath, id).hookType).toBe('context')

    for (const offset of [1, 40]) {
      const out = firstRead(filePath, id, { offset, limit: 5 })
      expect(out.hookType).toBe('deny')
    }
  })
})
