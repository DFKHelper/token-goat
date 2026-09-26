import type * as NodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Counts reads of one watched path through both bindings of node:fs, since hooks_read.ts reads through the namespace and evidence_cache.ts through the default export, and vi.spyOn cannot patch the namespace.
const mockState = vi.hoisted(() => ({ watchedPath: '', reads: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (typeof args[0] === 'string' && args[0] === mockState.watchedPath) mockState.reads++
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

import * as fs from 'node:fs'

import { buildDeltaCapsule } from '../src/evidence_cache.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postReadHandler, preReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { expectHookType } from './helpers/hook-output.js'

const tmpDirs: string[] = []

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evidence-text-'))
  tmpDirs.push(repo)
  fs.writeFileSync(path.join(repo, '.git'), '')
  return repo
}

function readEvent(eventName: 'pre_tool_use' | 'post_tool_use', sessionId: string, filePath: string, repo: string): HookEvent {
  return { eventName, toolName: 'Read', toolInput: { file_path: filePath }, sessionId, agentId: undefined, raw: { cwd: repo } }
}

beforeEach(() => {
  process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'
  clearModuleCaches()
  mockState.watchedPath = ''
  mockState.reads = 0
})

afterEach(() => {
  delete process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP
  delete process.env.TOKEN_GOAT_BASH_COMPRESS
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// PROVENANCE: HAND-DERIVED. EF BB BF is U+FEFF encoded as UTF-8 and FF FE is U+FEFF encoded as UTF-16LE, the two byte-order marks the Unicode Standard defines for those encodings; the bodies are arbitrary.
const MARKED_FILES: Array<[string, string, Buffer]> = [
  ['UTF-8 with a byte-order mark', 'Program.cs', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class Program {}\n', 'utf8')])],
  ['UTF-16LE with a byte-order mark', 'build.ps1', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Write-Output "built"\r\n', 'utf16le')])],
]

function readInSessionA(name: string, bytes: Buffer): { repo: string; file: string } {
  const repo = makeRepo()
  const file = path.join(repo, name)
  fs.writeFileSync(file, bytes)
  postReadHandler(readEvent('post_tool_use', 'session-a', file, repo))
  return { repo, file }
}

describe('cross-session evidence reads a file one way on every side', () => {
  it.each(MARKED_FILES)('verifies the evidence another session recorded for an unchanged %s file', (_label, name, bytes) => {
    const { repo, file } = readInSessionA(name, bytes)

    const result = preReadHandler(readEvent('pre_tool_use', 'session-b', file, repo))

    expectHookType(result, 'context')
    expect(result.context).toMatch(/Verified cross-session evidence exists for this unchanged file/)
  })

  it.each(MARKED_FILES)('does not report an unchanged %s file as changed since its evidence was cached', (_label, name, bytes) => {
    const { repo } = readInSessionA(name, bytes)

    expect(buildDeltaCapsule(repo)).toBeNull()
  })

  // PROVENANCE: HAND-DERIVED. The evidence cap is 128 KiB of UTF-8 text, and UTF-32 is the least dense encoding decodeSource reads: one character per four bytes after a four-byte mark, with up to three trailing bytes it drops. So 4 * 128 KiB + 7 is the largest file whose text can still fit, and this one is a byte past it.
  it('never reads a file too large to be cached as evidence, on either side of the Read', () => {
    const repo = makeRepo()
    const file = path.join(repo, 'capture.dat')
    fs.writeFileSync(file, Buffer.alloc(4 * 128 * 1024 + 8, 0x61))
    mockState.watchedPath = normalizePath(file)
    // The Read's served-output record reads the window under its own 2 MiB cap, a separate store this test is not about.
    process.env.TOKEN_GOAT_BASH_COMPRESS = '0'

    postReadHandler(readEvent('post_tool_use', 'session-a', file, repo))
    preReadHandler(readEvent('pre_tool_use', 'session-b', file, repo))

    expect(mockState.reads).toBe(0)
  })
})
