/**
 * The `secret_redacted` stat must count what a handler EMITS, not what its redaction found.
 *
 * These two numbers differ on most branches and the gap is not a rounding detail. A poll-diff
 * handler emits a suffix delta; the approved-plan handler emits a truncated prefix; several
 * branches replace the output with a short notice outright. In every one of those, a secret outside
 * the emitted region was removed by slicing, truncation, or replacement -- not by redaction -- so
 * reporting the redaction's own input count would credit this subsystem for a protection some other
 * mechanism already provided. That is the accounting-honesty half of the redaction work; the
 * security half (redact where the value ARRIVES, so a later branch inherits it) is guarded
 * separately by `guards/rewritten_output_never_carries_a_secret.test.ts`.
 *
 * Measured before this was written: a BashOutput poll pair carrying one credential rewrote 22KB
 * with the secret redacted and recorded nothing at all, because both poll-diff handlers discarded
 * `.count` at the call site and had no `recordStat` anywhere in the file.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted: spy on recordStat while still calling through, matching tests/hooks_grep.test.ts.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

// Importing relay registers every hook module, so runHook dispatches through the production
// registry rather than a directly-imported handler reference.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordStat } from '../src/stats.js'
import { countRedactionPlaceholders } from '../src/secret_redact.js'

const SECRET = 'AKIAABCDEFGHIJKLMNOP'
/** Comfortably over the poll handlers' cache_min_bytes floor so the rewrite branches engage. */
const BULK = Array.from({ length: 300 }, (_, i) => `line ${i} of accumulated build output`).join('\n')

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-redact-stat-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `rs-${path.basename(tmpHome)}`
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function poll(output: string): Record<string, unknown> {
  return {
    tool_name: 'BashOutput',
    tool_input: { bash_id: 'bash_1' },
    session_id: sessionId,
    tool_response: { output, status: 'running' },
  }
}

/** Every `secret_redacted` call recorded since the last clear, as `[count, detail]` pairs. */
function redactionStats(): Array<[unknown, unknown]> {
  return vi
    .mocked(recordStat)
    .mock.calls.filter((c) => c[0] === 'secret_redacted')
    .map((c) => [c[2], c[4]])
}

describe('secret_redacted counts the emitted text, not the redaction input', () => {
  it('counts a credential that survives into the emitted delta', async () => {
    const first = await runHook(buildEvent('post_tool_use', poll(BULK)))
    expect(first.hookType).toBe('pass')

    vi.mocked(recordStat).mockClear()
    const second = await runHook(buildEvent('post_tool_use', poll(`${BULK}\nexport AWS_KEY=${SECRET}\n${BULK}`)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return
    expect(second.updatedOutput).not.toContain(SECRET)
    expect(redactionStats()).toEqual([[1, 'bashoutput']])
  })

  it('records nothing when the branch replaces the output with a notice instead of redacting it', async () => {
    // This is the assertion that discriminates "count what you emit" from "count what you found".
    // Both polls carry the credential, so the redaction finds one every time -- but the second poll
    // is unchanged, so the handler emits a short no-new-output notice that contains no secret at
    // all. The credential did not reach the model because the notice replaced the whole output, not
    // because a redaction stripped it. Crediting one here would be claiming a protection this
    // subsystem did not provide. Counting the redaction's own input count would do exactly that.
    const withSecret = `${BULK}\nexport AWS_KEY=${SECRET}\n${BULK}`
    const first = await runHook(buildEvent('post_tool_use', poll(withSecret)))
    expect(first.hookType).toBe('pass')

    vi.mocked(recordStat).mockClear()
    const second = await runHook(buildEvent('post_tool_use', poll(withSecret)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return
    // Guards the guard: if this ever stopped being the notice branch, the test would be asserting
    // zero against some other branch and would no longer discriminate anything.
    expect(second.updatedOutput.length).toBeLessThan(400)
    expect(second.updatedOutput).not.toContain(SECRET)
    expect(redactionStats(), 'a wholesale replacement is not a redaction this subsystem performed').toEqual([])
  })

  it('does not credit a redaction on a pass, where the harness own output reaches the model', async () => {
    const only = await runHook(buildEvent('post_tool_use', poll(`${BULK}\nexport AWS_KEY=${SECRET}`)))
    expect(only.hookType).toBe('pass')
    expect(redactionStats(), 'on a pass the model sees the raw result, so nothing was protected').toEqual([])
  })
})

describe('countRedactionPlaceholders', () => {
  it('counts each placeholder, including repeats of one kind', () => {
    expect(countRedactionPlaceholders('a [REDACTED:aws_access_key] b [REDACTED:aws_access_key]')).toBe(2)
    expect(countRedactionPlaceholders('[REDACTED:aws_access_key] and [REDACTED:generic_secret]')).toBe(2)
  })

  it('returns zero for text with no placeholder', () => {
    expect(countRedactionPlaceholders('')).toBe(0)
    expect(countRedactionPlaceholders('nothing redacted here, REDACTED is just a word')).toBe(0)
  })

  it('does not match a malformed or partial placeholder', () => {
    // The pattern is deliberately narrow. A prose mention of the word must not inflate the count,
    // or every changelog entry describing this feature would register as a live redaction.
    expect(countRedactionPlaceholders('[REDACTED]')).toBe(0)
    expect(countRedactionPlaceholders('[REDACTED:]')).toBe(0)
    expect(countRedactionPlaceholders('[REDACTED:UPPER]')).toBe(0)
  })
})
