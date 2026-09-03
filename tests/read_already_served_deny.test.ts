/**
 * A Read whose bytes were already served is answered with a pointer, not the file
 * (`hooks_read.ts` `alreadyServedOutputId` -> the `read_served_deny` branch of `preReadHandler`).
 *
 * Every other re-read branch reasons about how many times a *file* has been read, and the
 * four-slot recent-read protection window exists because that reasoning can be wrong: it waves
 * through the most recently read files so a legitimate re-read is never blocked on a guess.
 * Measured over a month of real sessions, 830 Read calls returned a line range the session had
 * already been given, and a file sitting inside that window was the largest reason nothing fired --
 * which is exactly the case where the bytes are most certainly still in context. This branch
 * replaces the guess with a byte comparison, so the protection window no longer has to cover it.
 *
 * The tests below all run with the file as the single most recently read one, so it is inside the
 * protection window in every case. That is deliberate: it means a deny here can only have come from
 * the proof branch, since every count-based branch is gated on the file NOT being protected.
 *
 * Fixture provenance: HAND-DERIVED. The file is generated line text sized past the shared
 * IDENTICAL_READ_MIN_BODY_BYTES floor, and both the stored body and the compared body are read from
 * that same file on disk by the product's own path. Nothing here encodes a wire format, so nothing
 * weaker than a capture is being claimed. Sizes are asserted rather than assumed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { clearModuleCaches } from '../src/reset.js'
import { IDENTICAL_READ_MIN_BODY_BYTES } from '../src/util.js'
import { makeHookEvent } from './helpers/hook-event.js'

/** The distinctive wording of the proof branch. Asserting on it, rather than on `hookType`, is what
 *  keeps these tests honest: a count-based deny is also a deny, and would otherwise read as a pass. */
const PROOF = 'byte for byte'

let dir: string
let target: string

function writeTarget(marker: string): void {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}: ${marker} ${'q'.repeat(60)}`)
  fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8')
}

function readEvent(phase: 'pre_tool_use' | 'post_tool_use', opts: { offset?: number; limit?: number } = {}) {
  const toolInput: Record<string, unknown> = { file_path: target }
  if (opts.offset !== undefined) toolInput['offset'] = opts.offset
  if (opts.limit !== undefined) toolInput['limit'] = opts.limit
  return makeHookEvent({
    eventName: phase,
    toolName: 'Read',
    toolInput,
    raw: { cwd: dir, tool_name: 'Read', tool_input: toolInput, tool_response: { content: 'ok' } },
  })
}

/** One complete delivery of the file to the model: the pre hook records the read, the post hook
 *  stores what it handed over. Both halves are needed -- the served store is written post-read,
 *  while the re-read machinery only engages for a file the pre hook already recorded. */
function deliver(opts: { offset?: number; limit?: number } = {}): void {
  preReadHandler(readEvent('pre_tool_use', opts))
  postReadHandler(readEvent('post_tool_use', opts))
}

describe('preReadHandler denies a Read whose exact bytes were already served', () => {
  beforeEach(() => {
    clearModuleCaches()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-served-deny-'))
    target = path.join(dir, 'sample.ts')
    writeTarget('alpha')
    expect(fs.statSync(target).size).toBeGreaterThan(IDENTICAL_READ_MIN_BODY_BYTES)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env['TOKEN_GOAT_REREAD_DENY']
  })

  it('denies the second read of a file still inside the recent-read protection window', () => {
    deliver()
    const out = preReadHandler(readEvent('pre_tool_use'))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') {
      expect(out.message).toContain(PROOF)
      // The withheld text has to stay reachable, or this deletes content instead of deduplicating it.
      expect(out.message).toContain('token-goat bash-output ')
    }
  })

  it('does not deny when nothing was served for the file', () => {
    // Discrimination half of the test above: without it, a branch that denied every read would look
    // identical to one that checks what was actually delivered.
    // The file IS recorded as read, so the re-read machinery engages; only the served body is
    // missing. Without that first pre hook this would pass by never reaching the branch at all.
    preReadHandler(readEvent('pre_tool_use'))
    const out = preReadHandler(readEvent('pre_tool_use'))
    if (out.hookType === 'deny') expect(out.message).not.toContain(PROOF)
  })

  it('allows the read again once the file on disk no longer matches what was served', () => {
    deliver()
    writeTarget('beta')

    const changed = preReadHandler(readEvent('pre_tool_use'))
    if (changed.hookType === 'deny') expect(changed.message).not.toContain(PROOF)

    // Positive control: put the original bytes back and the same read is withheld again, so the
    // decline above is the content check doing its job rather than an empty store.
    clearModuleCaches()
    writeTarget('alpha')
    deliver()
    const same = preReadHandler(readEvent('pre_tool_use'))
    expect(same.hookType).toBe('deny')
    if (same.hookType === 'deny') expect(same.message).toContain(PROOF)
  })

  it('allows a read that reaches past the window already served', () => {
    // The earlier read handed over lines 1-10 and nothing else. A read of lines 1-40 carries 30
    // lines nobody has seen, and withholding it would delete them.
    deliver({ offset: 1, limit: 10 })
    const wider = preReadHandler(readEvent('pre_tool_use'))
    if (wider.hookType === 'deny') expect(wider.message).not.toContain(PROOF)

    // Positive control: the whole file, once served whole, is withheld.
    clearModuleCaches()
    deliver()
    const same = preReadHandler(readEvent('pre_tool_use'))
    expect(same.hookType).toBe('deny')
    if (same.hookType === 'deny') expect(same.message).toContain(PROOF)
  })

  it('stays out of the way when re-read denial is turned off', () => {
    // Having proof does not change what a user who disabled denials asked for.
    process.env['TOKEN_GOAT_REREAD_DENY'] = '0'
    clearModuleCaches()
    deliver()
    const out = preReadHandler(readEvent('pre_tool_use'))
    if (out.hookType === 'deny') expect(out.message).not.toContain(PROOF)

    // Positive control: with the setting back on, the same state does deny -- so the decline above
    // is the setting, not a store that clearModuleCaches emptied.
    delete process.env['TOKEN_GOAT_REREAD_DENY']
    clearModuleCaches()
    deliver()
    const on = preReadHandler(readEvent('pre_tool_use'))
    expect(on.hookType).toBe('deny')
    if (on.hookType === 'deny') expect(on.message).toContain(PROOF)
  })
})
