import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { preReadHandler } from '../src/hooks_read.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
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

function firstRead(filePath: string, sessionId: string) {
  return preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: filePath }, sessionId }))
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setPolicy(policy: 'warn' | 'deny'): void {
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
})
