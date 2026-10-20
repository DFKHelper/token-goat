// One pre_tool_use decision reads a file's bytes once to hash them (SHA-256, up to 2 MiB), however many of its checks and range records look at the hash: the hook is on every tool call's latency path. These rows count calls to fingerprintFile through the real hook path (relayInProcess, which loads and saves the session state around the handlers the way a real invocation does) for the three flows that once hashed again: a ranged Read after a Bash sed read, the first-read symbol policy's range record, and a multi-range sed command. Fixture provenance: the file contents, the sed commands, the windows and the same-size rewrite are HAND-DERIVED; the PreToolUse/PostToolUse envelopes are FORMAT-DERIVED from the Claude Code hook input documentation (tests/fixtures/harness_hook_payloads.ts, rows 'Bash command' and the ranged Read, CC_DOC), and the Bash tool_response is the CAPTURE shape tests/hooks_real_harness_payload_shape.test.ts records.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import * as fingerprintModule from '../src/fingerprint.js'
import type { NavigationEvidence } from '../src/read_navigation_evidence.js'
import * as navigationEvidenceModule from '../src/read_navigation_evidence.js'
import { relayInProcess } from '../src/relay.js'
import { rewriteKeepingSizeAndMtime, stampWholeSecondMtime } from './helpers/same_stat_rewrite.js'

const savedEnv: Record<string, string | undefined> = {}
let project: string
let seq = 0

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  project = mkdtempSync(join(tmpdir(), 'tg-hash-once-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  invalidateConfigCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(project, { recursive: true, force: true })
})

function newSessionId(): string {
  seq += 1
  return `hash-once-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

/** Short lines on purpose: a window stays under IDENTICAL_READ_MIN_BODY_BYTES (512), so the byte-for-byte served-output proof never answers. */
function makeSmallFile(name: string): string {
  const file = join(project, name)
  writeFileSync(file, Array.from({ length: 120 }, (_, i) => `export const v${i + 1} = ${i + 1}`).join('\n'))
  return file
}

/** A TypeScript module of one-line exported functions between 50,000 and 100,000 bytes: past the first-read symbol threshold, under the generic large-file gate. */
function makeLargeModule(name: string): string {
  const file = join(project, name)
  writeFileSync(file, Array.from({ length: 1200 }, (_, i) => `export function alphaEntry${i}(value: number): number { return value + ${i} }`).join('\n') + '\n')
  expect(statSync(file).size).toBeGreaterThan(50_000)
  expect(statSync(file).size).toBeLessThan(100_000)
  return file
}

function readEnvelope(sid: string, hookEventName: string, file: string, offset: number, limit: number): Record<string, unknown> {
  return { session_id: sid, cwd: project, permission_mode: 'default', hook_event_name: hookEventName, tool_name: 'Read', tool_input: { file_path: file, offset, limit }, tool_use_id: `toolu_${offset}_${limit}` }
}

function bashEnvelope(sid: string, hookEventName: string, command: string): Record<string, unknown> {
  return { session_id: sid, cwd: project, permission_mode: 'default', hook_event_name: hookEventName, tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${seq}_${Math.random().toString(36).slice(2, 8)}` }
}

/** The deny reason a pre_tool_use answer carries in Claude Code's wire form ({ decision: 'block', reason }), or null when the call is let through. */
function denyReason(emitted: string): string | null {
  const parsed = JSON.parse(emitted) as { decision?: string; reason?: string }
  return parsed.decision === 'block' ? (parsed.reason ?? '') : null
}

/** A sed read of lines `start..end` through both Bash hooks, naming the file relative to the session's cwd (the read extractors exempt an absolute path under the temp dir). The post hook carries the lines as they are on disk now. */
async function sedRead(sid: string, file: string, start: number, end: number): Promise<void> {
  const name = file.slice(project.length + 1)
  const command = `sed -n '${start},${end}p' ${name}`
  await relayInProcess('pre_tool_use', bashEnvelope(sid, 'PreToolUse', command))
  const stdout = readFileSync(file, 'utf8').split('\n').slice(start - 1, end).join('\n') + '\n'
  await relayInProcess('post_tool_use', { ...bashEnvelope(sid, 'PostToolUse', command), tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })
}

/** How many times `emit` read the whole file to hash it, and what it answered. */
async function countingHashes(emit: () => Promise<string>): Promise<{ answer: string; hashes: number }> {
  const spy = vi.spyOn(fingerprintModule, 'fingerprintFile')
  spy.mockClear()
  const answer = await emit()
  return { answer, hashes: spy.mock.calls.length }
}

describe('a ranged Read whose only history is a Bash sed read', () => {
  it('hashes the file once when a same-size rewrite lets the read through and its window is recorded', async () => {
    const sid = newSessionId()
    const file = makeSmallFile('server.log')
    stampWholeSecondMtime(file)
    await sedRead(sid, file, 1, 20)
    rewriteKeepingSizeAndMtime(file, 5)
    const { answer, hashes } = await countingHashes(() => relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 20)))
    expect(denyReason(answer)).toBeNull()
    expect(hashes).toBe(1)
  })
})

describe('the first-read symbol policy letting a ranged Read through', () => {
  // HAND-DERIVED: invented evidence of the shape getReadNavigationEvidence returns (tests/hooks_read_symbol_policy.test.ts builds the same), not read off any index. It is stubbed because the real one hashes the whole file itself to decide whether the index is stale, which would be a second, unrelated hash in these counts.
  const evidence: NavigationEvidence = { filePath: 'big.ts', indexedMtime: 1, isStale: false, symbolCount: 1200, topSymbols: [{ name: 'alphaEntry0', kind: 'function', lineStart: 1, lineEnd: 1 }], headingCount: 0, topHeadings: [] }

  beforeEach(() => {
    vi.spyOn(navigationEvidenceModule, 'getReadNavigationEvidence').mockReturnValue(evidence)
  })

  function setPolicy(policy: 'warn' | 'deny'): void {
    vi.stubEnv('TOKEN_GOAT_FIRST_READ_SYMBOL_POLICY', policy)
    invalidateConfigCache()
  }

  it('hashes the file once when a warning lets it through and records the window after a sed read of other lines', async () => {
    setPolicy('warn')
    const sid = newSessionId()
    const file = makeLargeModule('big.ts')
    await sedRead(sid, file, 1, 5)
    // Lines 1..1200 overlap the recorded 1..5 without being inside it, and span the file, so no small-slice bypass applies.
    const { answer, hashes } = await countingHashes(() => relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 1200)))
    expect(denyReason(answer)).toBeNull()
    expect(answer).toContain('1200 indexed symbols')
    expect(hashes).toBe(1)
  })

  it('hashes the file once when the circuit breaker lets the retried read through and records the window', async () => {
    setPolicy('deny')
    const sid = newSessionId()
    const file = makeLargeModule('big.ts')
    await sedRead(sid, file, 1, 5)
    expect(denyReason(await relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 1200)))).toContain('Whole-file first read denied by first_read_symbol_policy')
    const { answer, hashes } = await countingHashes(() => relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 1200)))
    expect(denyReason(answer)).toBeNull()
    expect(answer).toContain('circuit breaker')
    expect(hashes).toBe(1)
  })
})

describe('a multi-range sed command in the Bash pre hook', () => {
  it('hashes the file once however many ranges it records', async () => {
    const sid = newSessionId()
    const file = makeSmallFile('app.ts')
    const name = file.slice(project.length + 1)
    const { hashes } = await countingHashes(() => relayInProcess('pre_tool_use', bashEnvelope(sid, 'PreToolUse', `sed -n '1,5p;20,25p;40,45p' ${name}`)))
    expect(hashes).toBe(1)
  })

  it('hashes the file once when ranges of it are already on record and the new command adds more', async () => {
    const sid = newSessionId()
    const file = makeSmallFile('app.ts')
    const name = file.slice(project.length + 1)
    await sedRead(sid, file, 60, 65)
    const { hashes } = await countingHashes(() => relayInProcess('pre_tool_use', bashEnvelope(sid, 'PreToolUse', `sed -n '1,5p;20,25p' ${name}`)))
    expect(hashes).toBe(1)
  })
})

describe('a ranged Read of a CSV the universal file-type handler reads', () => {
  /** 50 KB of short rows: past the size where the handler reads the file, under the sizes where it blocks. */
  function makeCsv(name: string): string {
    const file = join(project, name)
    writeFileSync(file, 'a,b\n' + Array.from({ length: 4000 }, (_, i) => `r${String(i).padStart(5, '0')},${i}`).join('\n') + '\n')
    stampWholeSecondMtime(file)
    return file
  }

  it('records its window from the bytes the handler read, without reading the file again to hash it', async () => {
    const sid = newSessionId()
    const file = makeCsv('data.csv')
    const { answer, hashes } = await countingHashes(() => relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 50)))
    expect(denyReason(answer)).toBeNull()
    expect(hashes).toBe(0)
  })

  it('denies the same window again while the file is untouched, so the hash it was recorded with is the file\'s own', async () => {
    const sid = newSessionId()
    const file = makeCsv('data.csv')
    await relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 50))
    expect(denyReason(await relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 50)))).not.toBeNull()
  })

  it('lets the window through again after a same-size rewrite that put the mtime back', async () => {
    const sid = newSessionId()
    const file = makeCsv('data.csv')
    await relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 50))
    rewriteKeepingSizeAndMtime(file, 5)
    expect(denyReason(await relayInProcess('pre_tool_use', readEnvelope(sid, 'PreToolUse', file, 1, 50)))).toBeNull()
  })
})
