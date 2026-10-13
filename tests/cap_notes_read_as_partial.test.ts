/** Every way the output caps cut a result must read as "capped" to isCappedOutput, and the served-extent bookkeeping behind a Bash `token-goat read` must then record no lines as seen. The producers are called as shipped; nothing here writes a marker by hand. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-partial-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { clearModuleCaches } = await import('../src/reset.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')
const { normalizePath } = await import('../src/paths.js')
const { displaySafeJson } = await import('../src/paths.js')
const { recordFileRead, getFileLineRanges } = await import('../src/session.js')
const { postBashHandler } = await import('../src/hooks_bash_post.js')
const { capJsonRows, isCappedOutput, trimToBudget } = await import('../src/overflow_guard.js')
const { capListField } = await import('../src/fence_cap.js')

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-partial-files-'))

beforeEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

// FORMAT-DERIVED: the rows are plain objects of the shape the listings serialize; the cut outputs below are the producers' own (trimToBudget, capJsonRows through the {items, truncated, totalCount} envelope read_commands.ts prints, capListField as describe_sqlite.ts calls it), so the markers cannot drift from what isCappedOutput looks for.
const ROWS = Array.from({ length: 4000 }, (_, i) => ({ name: `symbol_${i}`, file: `src/file_${i}.ts`, line: i }))
const TEXT = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n'

function jsonRowsCut(): string {
  const capped = capJsonRows(ROWS, 100)
  return displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, 0)
}

function listFieldCut(): string {
  return capListField({ tables: ROWS }, 'tables', (o) => displaySafeJson(o, 0))
}

const CUT_OUTPUTS: Array<[string, () => string]> = [
  ['trimToBudget', () => trimToBudget(TEXT, 100)],
  ['capJsonRows through the listing envelope', jsonRowsCut],
  ['capListField', listFieldCut],
]

describe('a cut result reads as capped', () => {
  it.each(CUT_OUTPUTS)('%s', (_name, produce) => {
    expect(isCappedOutput(produce())).toBe(true)
  })

  // HAND-DERIVED: a listing that fit prints truncated:false and no marker.
  it('does not read an uncut listing or text as capped', () => {
    const small = capJsonRows(ROWS.slice(0, 2), 25000)
    expect(isCappedOutput(displaySafeJson({ items: small.items, truncated: small.truncated, totalCount: small.totalCount }, 0))).toBe(false)
    expect(isCappedOutput(capListField({ tables: ROWS.slice(0, 2) }, 'tables', (o) => displaySafeJson(o, 0)))).toBe(false)
    expect(isCappedOutput(trimToBudget('one line\n', 100))).toBe(false)
  })
})

describe('the served-extent bookkeeping treats a cut read as partial', () => {
  // FORMAT-DERIVED: the Claude Code Bash tool_response envelope (stdout, stderr, interrupted, isImage, noOutputExpected), as in tests/fixtures/harness_hook_payloads.ts and read by extractToolResponse.
  function postBash(command: string, stdout: string): Promise<unknown> {
    const raw = { cwd: FILES_DIR, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
    return postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'test', raw }))
  }

  let counter = 0
  function seed(): string {
    const target = path.join(FILES_DIR, `cap${++counter}.ts`)
    fs.writeFileSync(target, TEXT.slice(0, 2000))
    recordFileRead(target, false)
    return target
  }

  // HAND-DERIVED: a ranged read of lines 1-50 that came back whole records the range; the same read whose output was cut records none.
  it('records the range of a whole result', async () => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}@1-50"`, 'served\n')
    expect(getFileLineRanges(target).length).toBeGreaterThan(0)
  })

  it.each(CUT_OUTPUTS)('records no range when the output is cut by %s', async (_name, produce) => {
    const target = seed()
    await postBash(`token-goat read "${normalizePath(target)}@1-50"`, produce())
    expect(getFileLineRanges(target)).toEqual([])
  })
})
