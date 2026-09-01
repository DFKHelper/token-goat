/**
 * A completed Read is rewritten to withhold the stretches of it the session already holds
 * (`hooks_read.ts` `elideAlreadyServedLines`, reached from `postReadHandler`).
 *
 * `alreadyServedOutputId` can only withhold a read whose window is ENTIRELY inside an earlier
 * delivery. Measured over a month of real sessions that is the smaller half: 400 Read calls were
 * fully served against 589 that mixed new lines with already-served ones, and denying any of the
 * 589 would have deleted the new lines too. This path keeps them and replaces only the overlap.
 *
 * The failure this feature is one line away from is self-elision. `postReadHandler` also records
 * the finished Read into the very store the elision compares against, so if the recording ran
 * first every line would match itself and a plain first read would come back as nothing but a
 * notice. The "first read is untouched" test below is the guard for exactly that ordering, and it
 * is why several tests here assert on *content that must survive* rather than only on what went
 * away: an over-collapse improves every byte-count assertion while destroying the feature.
 *
 * Fixture provenance:
 *   - The Read result row shape (`<n>\t<line>`, no padding) is CAPTURE-grade: it was read off
 *     10,549 real Read tool results, of which every numbered row carried a tab separator and zero
 *     leading pad. The parser also tolerates leading spaces, and the one test that exercises that
 *     tolerance says so rather than implying the harness emits them.
 *   - The file content is HAND-DERIVED: generated lines whose sizes are asserted against the
 *     shipped floors rather than assumed, so a change to those floors fails loudly here instead of
 *     turning these into vacuous passes.
 *   - The PostToolUse request payload keys and the `hookSpecificOutput.updatedToolOutput` response
 *     shape are FORMAT-DERIVED from this repo's own `hook_registry.ts::serializeOutput`. That
 *     proves agreement with our serializer, not that a shipped harness build emits it.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'token-goat.mjs')

/** The distinctive wording of the elision notice. Asserting on it rather than on `hookType` keeps
 *  these honest: some other rewrite would otherwise read as this one firing. */
const NOTICE = 'were already served verbatim in this session'

const LINE_COUNT = 40
/** Wide enough that twenty lines clear bash_compress.cache_min_bytes (512) and a twenty-line run
 *  clears min_net_savings_bytes (100) even after the ~150-byte notice replacing it. */
const LINE_WIDTH = 70

let dir: string
let target: string

function bodyLine(i: number, marker: string): string {
  return `line ${i}: ${marker} ` + 'q'.repeat(LINE_WIDTH)
}

function writeTarget(marker: string): string[] {
  const lines = Array.from({ length: LINE_COUNT }, (_, i) => bodyLine(i + 1, marker))
  fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8')
  return lines
}

/** The harness's `cat -n` rendering of a 1-indexed line window of the file on disk. */
function rendered(from = 1, to = LINE_COUNT, pad = ''): string {
  const lines = fs.readFileSync(target, 'utf8').split('\n')
  const rows: string[] = []
  for (let n = from; n <= to; n++) rows.push(pad + n + '\t' + (lines[n - 1] ?? ''))
  return rows.join('\n')
}

function readEvent(
  phase: 'pre_tool_use' | 'post_tool_use',
  opts: { offset?: number; limit?: number; content?: string } = {},
) {
  const toolInput: Record<string, unknown> = { file_path: target }
  if (opts.offset !== undefined) toolInput['offset'] = opts.offset
  if (opts.limit !== undefined) toolInput['limit'] = opts.limit
  return makeHookEvent({
    eventName: phase,
    toolName: 'Read',
    toolInput,
    raw: {
      cwd: dir,
      tool_name: 'Read',
      tool_input: toolInput,
      tool_response: { content: opts.content ?? 'ok' },
    },
  })
}

/** One complete delivery: the pre hook records the read, the post hook stores what it handed over. */
function deliver(opts: { offset?: number; limit?: number } = {}): void {
  preReadHandler(readEvent('pre_tool_use', opts))
  postReadHandler(readEvent('post_tool_use', opts))
}

/** The post hook's view of a Read that returned `content`, with the pre hook run first so the
 *  session has the file recorded exactly as it would in production. */
function readBack(content: string, opts: { offset?: number; limit?: number } = {}) {
  preReadHandler(readEvent('pre_tool_use', opts))
  return postReadHandler(readEvent('post_tool_use', { ...opts, content }))
}

describe('postReadHandler withholds already-served stretches of a Read', () => {
  beforeEach(() => {
    clearModuleCaches()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-elide-'))
    target = path.join(dir, 'sample.ts')
    const lines = writeTarget('alpha')
    // Size assertions, so a later change to the shipped floors fails here instead of silently
    // turning every case below into a decline that still reads as a pass.
    expect(Buffer.byteLength(lines.slice(0, 20).join('\n'), 'utf-8')).toBeGreaterThan(512)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env['TOKEN_GOAT_ELIDE_SERVED_LINES']
  })

  it('withholds the served run and keeps every line the session has not seen', () => {
    deliver({ offset: 1, limit: 20 })
    const out = readBack(rendered())

    expect(out.hookType).toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') return
    expect(out.updatedOutput).toContain(NOTICE)
    // Must-not-drop: the twenty lines nobody has seen are the whole reason this is a rewrite and
    // not a deny. An over-collapse would shrink the output further and pass a size-only check.
    for (const n of [21, 30, 40]) expect(out.updatedOutput).toContain(bodyLine(n, 'alpha'))
    // And the served ones are actually gone, so the rewrite did something.
    for (const n of [1, 10, 20]) expect(out.updatedOutput).not.toContain(bodyLine(n, 'alpha'))
    expect(out.updatedOutput).toContain('token-goat bash-output ')
  })

  it('leaves a first read of a file completely untouched', () => {
    // The ordering guard. `postReadHandler` records this read into the store the elision consults;
    // recording before eliding would make every line match itself, and a first read would come
    // back as a notice with the file's entire content withheld.
    const original = rendered()
    const out = readBack(original)
    expect(out.hookType).not.toBe('rewriteOutput')

    // Positive control: the identical result, once something HAS been served, is rewritten -- so
    // the pass above is the store being empty rather than the branch being unreachable.
    clearModuleCaches()
    deliver({ offset: 1, limit: 20 })
    const second = readBack(original)
    expect(second.hookType).toBe('rewriteOutput')
  })

  it('keeps the line numbers of surviving rows and names the withheld range exactly', () => {
    deliver({ offset: 1, limit: 20 })
    const out = readBack(rendered())
    if (out.hookType !== 'rewriteOutput') throw new Error('expected a rewrite')

    expect(out.updatedOutput).toContain('lines 1-20')
    // Row 21 still calls itself 21. A rewrite that renumbered from the top would leave every later
    // reference in the conversation pointing at the wrong line.
    expect(out.updatedOutput).toContain('21\t' + bodyLine(21, 'alpha'))
    expect(out.updatedOutput).toContain('40\t' + bodyLine(40, 'alpha'))
  })

  it('emits surviving rows byte-for-byte on both sides of a cut, pad included', () => {
    // The parser tolerates a leading pad; Claude Code does not emit one. This asserts the rewrite
    // is purely subtractive either way -- if surviving rows were re-rendered from the parsed number
    // and text, the pad would vanish and part of the "saving" would be silent reformatting of lines
    // that were never withheld.
    //
    // The served window sits in the MIDDLE of the read on purpose. Rows before a cut and rows after
    // it are emitted by two separate loops, and a window at the head of the file leaves the first
    // loop with nothing to do -- so either loop could drift on its own and the assertion would
    // still pass. Lines 10-29 are withheld; 1-9 and 30-40 have to come back untouched.
    deliver({ offset: 10, limit: 20 })
    const out = readBack(rendered(1, LINE_COUNT, '   '))
    if (out.hookType !== 'rewriteOutput') throw new Error('expected a rewrite')
    expect(out.updatedOutput).toContain('   1\t' + bodyLine(1, 'alpha'))
    expect(out.updatedOutput).toContain('   9\t' + bodyLine(9, 'alpha'))
    expect(out.updatedOutput).toContain('   30\t' + bodyLine(30, 'alpha'))
    expect(out.updatedOutput).toContain('   40\t' + bodyLine(40, 'alpha'))
    expect(out.updatedOutput).not.toContain(bodyLine(20, 'alpha'))
  })

  it('preserves harness text that follows the numbered block', () => {
    // Real results carry trailers -- truncation notices, "(N lines total)", system reminders. The
    // block ends where the numbering stops, and everything after it is not ours to drop.
    const trailer = '\n... (40 lines total) ...\nUse Read with offset and limit to see more.'
    deliver({ offset: 1, limit: 20 })
    const out = readBack(rendered() + trailer)
    if (out.hookType !== 'rewriteOutput') throw new Error('expected a rewrite')
    expect(out.updatedOutput).toContain('... (40 lines total) ...')
    expect(out.updatedOutput).toContain('Use Read with offset and limit to see more.')
  })

  it('stops withholding once the file on disk no longer matches what was served', () => {
    deliver({ offset: 1, limit: 20 })
    writeTarget('beta')
    const changed = readBack(rendered())
    expect(changed.hookType).not.toBe('rewriteOutput')

    // Positive control: restore the served bytes and the same read is rewritten again.
    clearModuleCaches()
    writeTarget('alpha')
    deliver({ offset: 1, limit: 20 })
    expect(readBack(rendered()).hookType).toBe('rewriteOutput')
  })

  it('makes only the cuts that pay for their own notice', () => {
    // A short block at the head of this file repeats near its end, so one served window produces two
    // separate runs in the same read: fifty-five wide lines, a cut that clearly pays, and five
    // four-character ones, ~40 bytes against a ~130-byte notice -- a cut that loses. The first cut
    // saves thousands of bytes, so the whole-rewrite gate below still sees a large net saving and
    // cannot tell that the second cut is losing money inside it. Only a per-cut check can.
    const repeated = ['aa1', 'aa2', 'aa3', 'aa4', 'aa5']
    const mixed = [
      ...repeated,
      ...Array.from({ length: 55 }, (_, i) => bodyLine(i + 6, 'alpha')),
      ...repeated,
    ]
    fs.writeFileSync(target, mixed.join('\n') + '\n', 'utf8')
    expect(Buffer.byteLength(mixed.slice(0, 60).join('\n'), 'utf-8')).toBeGreaterThan(512)

    deliver({ offset: 1, limit: 60 })
    const out = readBack(rendered(1, 65))
    if (out.hookType !== 'rewriteOutput') throw new Error('expected a rewrite')

    // Exactly one notice: the long run went, and the five short lines it could not pay to withhold
    // stayed. A second notice here would mean the rewrite spent ~130 bytes to remove ~40.
    expect((out.updatedOutput ?? '').split(NOTICE)).toHaveLength(2)
    expect(out.updatedOutput).toContain('61\taa1')
    expect(out.updatedOutput).toContain('65\taa5')
    expect(out.updatedOutput).not.toContain(bodyLine(30, 'alpha'))
  })

  it('leaves a long overlap whose bytes cannot pay for the notice', () => {
    // A run of five lines is a real overlap by any line count, but five lines of four characters is
    // ~50 bytes against a ~130-byte notice, so withholding them would make the result LARGER. A
    // rewrite that decided on run length alone would ship a negative saving here.
    const narrow = Array.from({ length: 200 }, (_, i) => 'L' + (i + 1))
    fs.writeFileSync(target, narrow.join('\n') + '\n', 'utf8')
    expect(Buffer.byteLength(narrow.slice(0, 150).join('\n'), 'utf-8')).toBeGreaterThan(512)

    deliver({ offset: 1, limit: 150 })
    const tiny = readBack(rendered(146, 200), { offset: 146, limit: 55 })
    expect(tiny.hookType).not.toBe('rewriteOutput')

    // Positive control: the same file and the same served body, overlapping widely enough to pay.
    clearModuleCaches()
    deliver({ offset: 1, limit: 150 })
    expect(readBack(rendered(1, 200)).hookType).toBe('rewriteOutput')
  })

  it('declines when the whole rewrite clears the per-cut bar but not the net floor', () => {
    // The two gates are different bars and this is the band between them. One cut of eight
    // medium-width lines removes ~224 bytes and its notice costs ~145, so the cut pays for itself
    // and is made -- but ~79 bytes of net saving is under the 100-byte floor a rewrite has to clear
    // to be worth handing the model a different result at all. Only the whole-rewrite gate declines
    // here, and without it token-goat would spend a rewrite to save less than it charges for one.
    const lines = Array.from({ length: 200 }, (_, i) => 'm' + (i + 1) + ':' + 'x'.repeat(20))
    fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8')
    expect(Buffer.byteLength(lines.slice(0, 60).join('\n'), 'utf-8')).toBeGreaterThan(512)

    deliver({ offset: 1, limit: 60 })
    const thin = readBack(rendered(53, 82), { offset: 53, limit: 30 })
    expect(thin.hookType).not.toBe('rewriteOutput')

    // Positive control: the same file and served window, overlapped by twenty lines instead of
    // eight, so the identical machinery clears the floor and does rewrite.
    clearModuleCaches()
    fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8')
    deliver({ offset: 1, limit: 60 })
    const fat = readBack(rendered(41, 82), { offset: 41, limit: 42 })
    if (fat.hookType !== 'rewriteOutput') throw new Error('expected a rewrite')
    expect(fat.updatedOutput).toContain(NOTICE)
  })

  it('declines when the result carries anything the redactor would strip', () => {
    // On a pass-through the harness's own text reaches the model. Rewriting here would hand back a
    // redacted copy of the user's own file, so the branch steps aside instead.
    deliver({ offset: 1, limit: 20 })
    const withSecret = rendered() + '\n41\tconst k = "AKIAQQQQQQQQQQQQQQQQ"'
    expect(readBack(withSecret).hookType).not.toBe('rewriteOutput')

    // Positive control: the same read without that line is rewritten, so the decline above is the
    // redaction check and not the appended row breaking the parse.
    clearModuleCaches()
    deliver({ offset: 1, limit: 20 })
    expect(readBack(rendered() + '\n41\tconst k = "not-a-key"').hookType).toBe('rewriteOutput')
  })

  it('passes through a result with no numbered rows at all', () => {
    deliver({ offset: 1, limit: 20 })
    expect(readBack('This tool cannot read binary files.').hookType).not.toBe('rewriteOutput')
  })

  it('stays out of the way when the setting is off', () => {
    process.env['TOKEN_GOAT_ELIDE_SERVED_LINES'] = '0'
    clearModuleCaches()
    deliver({ offset: 1, limit: 20 })
    expect(readBack(rendered()).hookType).not.toBe('rewriteOutput')

    // Positive control: with the setting back on, the same state does rewrite.
    delete process.env['TOKEN_GOAT_ELIDE_SERVED_LINES']
    clearModuleCaches()
    deliver({ offset: 1, limit: 20 })
    expect(readBack(rendered()).hookType).toBe('rewriteOutput')
  })
})

describe('built bundle: the elision survives the hook process boundary', () => {
  let e2eDir: string
  let e2eTarget: string

  beforeEach(() => {
    e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-elide-e2e-'))
    e2eTarget = path.join(e2eDir, 'sample.ts')
    const lines = Array.from({ length: LINE_COUNT }, (_, i) => bodyLine(i + 1, 'e2e'))
    fs.writeFileSync(e2eTarget, lines.join('\n') + '\n', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(e2eDir, { recursive: true, force: true })
  })

  function runHook(event: 'pre_tool_use' | 'post_tool_use', sessionId: string, toolInput: Record<string, unknown>, content: string) {
    const payload = JSON.stringify({
      hook_event_name: event === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
      session_id: sessionId,
      cwd: e2eDir,
      tool_name: 'Read',
      tool_input: toolInput,
      tool_response: { content },
    })
    return spawnSync(process.execPath, [BUNDLE, 'hook', event], { input: payload, encoding: 'utf8' })
  }

  function renderedE2E(from: number, to: number): string {
    const lines = fs.readFileSync(e2eTarget, 'utf8').split('\n')
    const rows: string[] = []
    for (let n = from; n <= to; n++) rows.push(n + '\t' + (lines[n - 1] ?? ''))
    return rows.join('\n')
  }

  it('withholds a run served by an earlier hook process in the same session', () => {
    const sid = 'e2e-elide-partial'
    const first = { file_path: e2eTarget, offset: 1, limit: 20 }
    expect(runHook('pre_tool_use', sid, first, 'ok').status).toBe(0)
    expect(runHook('post_tool_use', sid, first, renderedE2E(1, 20)).status).toBe(0)

    const whole = { file_path: e2eTarget }
    expect(runHook('pre_tool_use', sid, whole, 'ok').status).toBe(0)
    const res = runHook('post_tool_use', sid, whole, renderedE2E(1, LINE_COUNT))
    expect(res.status).toBe(0)

    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: string }
    }
    // The cross-process assertion: if the served body lived only in module state, this separate
    // process would find an empty store and emit `{}`.
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    const replaced = parsed.hookSpecificOutput?.updatedToolOutput ?? ''
    expect(replaced).toContain(NOTICE)
    expect(replaced).toContain(bodyLine(40, 'e2e'))
    expect(replaced).not.toContain(bodyLine(1, 'e2e'))
  })

  it('does not withhold a first read in a fresh session', () => {
    // The same payload, in a session that was served nothing. A store keyed on anything wider than
    // the session would replace a first read with a pointer at a body it never saw.
    const sid = 'e2e-elide-fresh'
    const whole = { file_path: e2eTarget }
    expect(runHook('pre_tool_use', sid, whole, 'ok').status).toBe(0)
    const res = runHook('post_tool_use', sid, whole, renderedE2E(1, LINE_COUNT))
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { hookSpecificOutput?: { updatedToolOutput?: string } }
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeUndefined()
  })
})
