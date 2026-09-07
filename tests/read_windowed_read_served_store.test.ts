/**
 * A windowed Read must mark only the lines it actually delivered.
 *
 * `hooks_read.ts::readWindowFromDisk` is the single slicing shared by the two ends that have to
 * agree byte-for-byte on "what this Read was worth": the producer that stores a finished Read into
 * the per-file served-output store, and the checks that later ask whether those bytes were already
 * served. It consulted `offset` only when a `limit` was also present, so a Read carrying an offset
 * and no limit -- which the harness answers with "that line to the end of the file" -- recorded the
 * WHOLE file as served. A later whole-file Read of the same file then had its never-delivered head
 * withheld under a notice claiming those lines "were already served verbatim in this session".
 *
 * That is the worst shape a compression bug can take here: the model asked for the file, received
 * almost none of it, and was handed a false reason to stop looking. The invariant these tests pin
 * is the elision contract itself -- a line we withhold must have genuinely been delivered earlier,
 * and the command the notice names must return it.
 *
 * Reproduced against the built bundle before the fix: a 178-line file read at offset=100, then read
 * whole, came back as 145 bytes carrying the single notice "lines 1-178 were already served
 * verbatim in this session". Zero of lines 1-99 had ever been delivered.
 *
 * Every case here pairs its must-not-drop assertions with a positive control in the same test: the
 * genuinely-served tail MUST still be withheld and the notice MUST name it. Without that pairing a
 * regression that simply stopped eliding anything would read as a pass, and over-collapsing is not
 * the only way to fail this seam -- under-collapsing passes a byte-ratio floor just as easily.
 *
 * Two layers, per this project's injected-seam discipline:
 *   1. In-process, for the slicing decision and the store's contents.
 *   2. Built-bundle e2e in separate processes, which is the authoritative layer: in production the
 *      two Reads are different process invocations, so the served body only reaches the second one
 *      if it was persisted to disk and rehydrated. An in-process test shares module state across
 *      both and would stay green even if nothing were ever written.
 *
 * Fixture provenance:
 *   - The file body is HAND-DERIVED: generated here from a line template, independent of any
 *     token-goat code, and the delivered windows are sliced from that same generated text with
 *     plain `Array.prototype.slice` rather than through the implementation's own helper. The
 *     expected line numbers are therefore computed independently of the code under test.
 *   - The PostToolUse request payload keys (`hook_event_name`, `session_id`, `cwd`, `tool_name`,
 *     `tool_input`, `tool_response.file.{filePath,content,numLines,startLine,totalLines}`) with
 *     `content` UNNUMBERED are CAPTURE-grade: this is the shape 104 of 104 real Claude Code Reads
 *     arrive in, recorded from live hook payloads. Deliberately not the `cat -n` display rendering,
 *     which the harness never sends on this field.
 *   - The response shape (`hookSpecificOutput.{hookEventName,updatedToolOutput}`) is FORMAT-DERIVED
 *     from this repo's own serializer contract in `src/hook_registry.ts::serializeOutput`. That
 *     proves agreement with our serializer, not that a shipped Claude Code build emits it.
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
import { rewrittenBody } from './helpers/updated-tool-output.js'

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'token-goat.mjs')

/** The distinctive wording of the elision notice. Asserting on it rather than on `hookType` keeps these honest: some other rewrite would otherwise read as this one firing. */
const NOTICE = 'were already served verbatim in this session'

const LINE_COUNT = 60
/** The 1-indexed line the windowed Read starts at. Chosen so both sides of it are comfortably past every shipped floor: the tail must clear the store's cache_min_bytes, and the head must be worth more than the notice that would replace it. */
const OFFSET = 20
/** Wide enough that the served tail clears bash_compress.cache_min_bytes (512) and IDENTICAL_READ_MIN_BODY_BYTES, and that withholding it clears min_net_savings_bytes (100) even after the ~150-byte notice. */
const LINE_WIDTH = 70

/** The last line number the harness reports for this fixture. The generated body is written with a trailing newline, exactly as a real source file is, so the file carries one more (empty) line than it has content lines. Computed here from the fixture text rather than read off any token-goat helper, and asserted against the written file in beforeEach so a change to how the fixture is emitted fails loudly instead of quietly widening the range these tests accept. */
const LAST_LINE = LINE_COUNT + 1

let dir: string
let target: string
let lines: string[]

function writeTarget(): string[] {
  const body = Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1}: ` + 'q'.repeat(LINE_WIDTH))
  fs.writeFileSync(target, body.join('\n') + '\n', 'utf8')
  return body
}

/** The text the harness delivers for a Read starting at `from` and running to the end of the file, sliced from the generated body rather than through any token-goat helper. */
function windowText(from: number): string {
  return lines.slice(from - 1).join('\n') + '\n'
}

function readEvent(
  phase: 'pre_tool_use' | 'post_tool_use',
  opts: { offset?: number; content?: string } = {},
) {
  const toolInput: Record<string, unknown> = { file_path: target }
  if (opts.offset !== undefined) toolInput['offset'] = opts.offset
  const content = opts.content ?? ''
  return makeHookEvent({
    eventName: phase,
    toolName: 'Read',
    toolInput,
    raw: {
      hook_event_name: phase === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
      session_id: 's1',
      cwd: dir,
      tool_name: 'Read',
      tool_input: toolInput,
      tool_response: {
        file: {
          filePath: target,
          content,
          numLines: content === '' ? 0 : content.split('\n').length,
          startLine: opts.offset ?? 1,
          totalLines: LAST_LINE,
        },
      },
    },
  })
}

/** One complete delivery: the pre hook records the read, the post hook stores what it handed over. */
function deliver(opts: { offset?: number; content: string }): void {
  preReadHandler(readEvent('pre_tool_use', opts))
  postReadHandler(readEvent('post_tool_use', opts))
}

describe('a windowed Read marks only the lines it delivered', () => {
  beforeEach(() => {
    clearModuleCaches()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-window-'))
    target = path.join(dir, 'sample.ts')
    lines = writeTarget()
    // Size assertions, so a later change to the shipped floors fails here rather than silently turning every case below into a decline that still reads as a pass.
    expect(Buffer.byteLength(windowText(OFFSET), 'utf-8')).toBeGreaterThan(512)
    expect(Buffer.byteLength(lines.slice(0, OFFSET - 1).join('\n'), 'utf-8')).toBeGreaterThan(512)
    // The fixture really does carry LAST_LINE lines, so a change to how it is written fails here rather than quietly widening the line range the assertions below accept.
    expect(fs.readFileSync(target, 'utf8').split('\n').length).toBe(LAST_LINE)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('delivers the head a later whole-file Read never saw, and still withholds the tail it did', () => {
    deliver({ offset: OFFSET, content: windowText(OFFSET) })

    const out = postReadHandler(readEvent('post_tool_use', { content: lines.join('\n') + '\n' }))
    // A decline is an acceptable outcome for the head, but not for the tail: the positive control below would then fail, so this branch cannot be reached by a handler that simply stopped eliding. In-process the handler returns its pre-serialization shape, so the body is read off `updatedOutput` here and off the serialized `hookSpecificOutput.updatedToolOutput` envelope in the built-bundle layer below.
    const body = out !== null && out.hookType === 'rewriteOutput' ? out.updatedOutput : lines.join('\n') + '\n'

    // Must-not-drop list. These lines were NEVER delivered to the model, so no notice may stand in for them. Named individually rather than counted, because a byte-ratio floor is satisfied just as well by dropping them.
    expect(body).toContain(lines[0])
    expect(body).toContain(lines[OFFSET - 3])
    expect(body).toContain(lines[OFFSET - 2])

    // Positive control, in the same test: the tail WAS delivered at step one, so it must still be withheld and the notice must name that range and no wider one.
    expect(body).toContain(NOTICE)
    expect(body).toContain(`lines ${OFFSET}-${LAST_LINE}`)
    expect(body).not.toContain(`lines 1-${LAST_LINE}`)
    expect(body).not.toContain(lines[LINE_COUNT - 1])
  })

  it('names a recall command that returns the withheld bytes', () => {
    deliver({ offset: OFFSET, content: windowText(OFFSET) })
    const out = postReadHandler(readEvent('post_tool_use', { content: lines.join('\n') + '\n' }))
    expect(out).not.toBeNull()
    const body = out !== null && out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    const notice = body.split('\n').find((l) => l.includes(NOTICE))
    expect(notice).toBeDefined()
    // Without `--full` every render path in cmdBashOutput elides the middle past head+tail, so the command the notice names returns less than the notice just withheld. Pinned as an exact substring rather than a loose /--full/ match so a pointer that carries the flag on some other token still fails.
    expect(notice).toMatch(/token-goat bash-output [0-9a-f]+ --full`/)
  })
})

describe('built bundle: a windowed Read does not poison the served store across processes', () => {
  let bdir: string
  let btarget: string
  let blines: string[]

  beforeEach(() => {
    bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-window-e2e-'))
    btarget = path.join(bdir, 'sample.ts')
    blines = Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1}: ` + 'q'.repeat(LINE_WIDTH))
    fs.writeFileSync(btarget, blines.join('\n') + '\n', 'utf8')
    expect(fs.readFileSync(btarget, 'utf8').split('\n').length).toBe(LAST_LINE)
  })

  afterEach(() => {
    fs.rmSync(bdir, { recursive: true, force: true })
  })

  function post(session: string, content: string, startLine: number, offset?: number): string {
    const toolInput: Record<string, unknown> = { file_path: btarget }
    if (offset !== undefined) toolInput['offset'] = offset
    const event = {
      session_id: session,
      hook_event_name: 'PostToolUse',
      cwd: bdir,
      tool_name: 'Read',
      tool_input: toolInput,
      tool_response: {
        file: { filePath: btarget, content, numLines: content.split('\n').length, startLine, totalLines: LAST_LINE },
      },
    }
    const r = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      cwd: bdir,
    })
    let parsed: Record<string, unknown> | null
    try {
      parsed = JSON.parse(r.stdout ?? '') as Record<string, unknown>
    } catch {
      parsed = null
    }
    const hs = (parsed?.['hookSpecificOutput'] ?? parsed) as Record<string, unknown> | null | undefined
    const updated = hs?.['updatedToolOutput']
    if (updated === undefined || updated === null) return content
    return rewrittenBody(updated)
  }

  it('withholds only the offset window, never the head that was never sent', () => {
    const session = 'tg-window-e2e-' + process.pid + '-' + Date.now()
    const tail = blines.slice(OFFSET - 1).join('\n') + '\n'
    post(session, tail, OFFSET, OFFSET)
    const body = post(session, blines.join('\n') + '\n', 1)

    // Must-not-drop list: never delivered, so never withholdable.
    expect(body).toContain(blines[0])
    expect(body).toContain(blines[OFFSET - 2])
    // Positive control: the seam is alive across processes, so a persistence regression cannot pass as a correct decline.
    expect(body).toContain(NOTICE)
    expect(body).toContain(`lines ${OFFSET}-${LAST_LINE}`)
    expect(body).not.toContain(`lines 1-${LAST_LINE}`)
  })
})
