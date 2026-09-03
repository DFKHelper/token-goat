/**
 * A completed Read feeds the shell-side re-read collapse (`hooks_read.ts`
 * `recordReadAsServedOutput` -> `hooks_bash.ts` `maybeCollapseIdenticalRead`).
 *
 * The collapse already knew how to replace a shell read whose lines a prior body already carried,
 * but only Bash ever wrote to the store it consults, so a file first delivered through the Read
 * tool was invisible to it. These tests drive the seam end to end rather than either half alone:
 * a Read, then a shell read of the same lines, asserting the shell body is replaced by a pointer.
 *
 * The seam has a specific way to fail silently. The producer keys the store on
 * `normalizePath(file_path)` and the consumer looks it up under `resolveIndexPath(file, cwd)`;
 * those are two different path producers, and if they disagree on case or separators every test
 * that only asserts "did not collapse" stays green while the feature does nothing at all. Every
 * negative case below is therefore paired with a positive control in the same test, so a total
 * miss cannot pass as a correct decline.
 *
 * Two layers, per this project's injected-seam discipline:
 *   1. In-process, for the decision and the key agreement.
 *   2. Built-bundle e2e in separate processes, which is the authoritative layer: in production the
 *      Read hook and the Bash hook are different processes, so the served body only reaches the
 *      collapse if it is persisted to disk and rehydrated. An in-process test shares module state
 *      between the two and would stay green even if nothing were ever written.
 *
 * Fixture provenance:
 *   - The served text is CAPTURE-grade against the file it claims to be: both the body the Read
 *     stores and the body the shell read returns are read from the real `README.md` on disk at
 *     test time, by the same `decodeSource(readFileSync(...))` path the producer uses. Nothing is
 *     transcribed, so the fixture cannot drift from the file as the file changes. Line ranges are
 *     asserted past the size floor rather than assumed, so a shrinking README fails loudly instead
 *     of turning these into vacuous passes.
 *   - The PostToolUse request payload keys (`hook_event_name`, `session_id`, `cwd`, `tool_name`,
 *     `tool_input`, `tool_response`) and the response shape
 *     (`hookSpecificOutput.{hookEventName,updatedToolOutput}`) are FORMAT-DERIVED from this repo's
 *     own serializer contract in `src/hook_registry.ts::serializeOutput`. That proves agreement
 *     with our serializer, not that a shipped Claude Code build emits it.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { postReadHandler } from '../src/hooks_read.js'
import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { decodeSource, IDENTICAL_READ_MIN_BODY_BYTES } from '../src/util.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { rewrittenBody, rewrittenKeys } from './helpers/updated-tool-output.js'
import { BUNDLE } from './helpers/bundle.js'

// A real, already-present repo file. It must NOT be under a temp directory: the shell read
// extractors deliberately exempt temp scratch paths (`hooks_bash.ts` isTempPath), so a fixture in
// os.tmpdir() is classified as "not a file read" and nothing would ever collapse.
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(REPO, 'README.md')
const LINES = decodeSource(fs.readFileSync(TARGET)).split('\n')

/** The exact bytes `sed -n 'start,endp' README.md` prints, taken from the file itself. */
function slice(start: number, end: number): string {
  return LINES.slice(start - 1, end).join('\n')
}

function readEvent(opts: { offset?: number; limit?: number; truncated?: boolean } = {}) {
  const toolInput: Record<string, unknown> = { file_path: TARGET }
  if (opts.offset !== undefined) toolInput['offset'] = opts.offset
  if (opts.limit !== undefined) toolInput['limit'] = opts.limit
  const content = opts.truncated ? '[Truncated: file too large]\n' + slice(1, 5) : slice(1, 5)
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput,
    raw: { cwd: REPO, tool_name: 'Read', tool_input: toolInput, tool_response: { content } },
  })
}

function shellEvent(command: string, output: string) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    raw: {
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: output, exitCode: 0 },
    },
  })
}

describe('a completed Read is a container for the shell re-read collapse', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('collapses a shell read of lines an unbounded Read already delivered', async () => {
    const body = slice(1, 40)
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(IDENTICAL_READ_MIN_BODY_BYTES)

    postReadHandler(readEvent())
    const out = await postBashHandler(shellEvent("sed -n '1,40p' README.md", body))

    expect(out.hookType).toBe('rewriteOutput')
    if (out.hookType === 'rewriteOutput') {
      expect(out.updatedOutput.length).toBeLessThan(body.length)
      // The dropped bytes stay reachable rather than being destroyed.
      expect(out.updatedOutput).toContain('token-goat bash-output ')
    }
  })

  it('does not collapse a shell read when no Read preceded it', async () => {
    // The discrimination half of the test above: without it, a collapse that fired on every read
    // regardless of what was served would look identical to a working producer.
    const body = slice(1, 40)
    const out = await postBashHandler(shellEvent("sed -n '1,40p' README.md", body))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('covers only the window a bounded Read actually delivered', async () => {
    // A Read carrying offset/limit handed over that window and nothing else. Storing the whole file
    // would let the collapse withhold lines the model was never shown -- the failure mode here is
    // silent data loss, not a missed saving.
    const outside = slice(60, 100)
    expect(Buffer.byteLength(outside, 'utf-8')).toBeGreaterThan(IDENTICAL_READ_MIN_BODY_BYTES)

    postReadHandler(readEvent({ offset: 1, limit: 40 }))

    const beyond = await postBashHandler(shellEvent("sed -n '60,100p' README.md", outside))
    expect(beyond.hookType).not.toBe('rewriteOutput')

    // Positive control, same store, same session: the window that WAS delivered still collapses,
    // so the decline above is a real boundary and not a store that was never written.
    const inside = await postBashHandler(shellEvent("sed -n '1,40p' README.md", slice(1, 40)))
    expect(inside.hookType).toBe('rewriteOutput')
  })

  it('stores nothing for a truncated Read', async () => {
    // A truncated Read delivered less than its own window and there is no way from the hook to know
    // where it stopped, so treating it as a container would withhold lines that never arrived.
    postReadHandler(readEvent({ truncated: true }))
    const out = await postBashHandler(shellEvent("sed -n '1,40p' README.md", slice(1, 40)))
    expect(out.hookType).not.toBe('rewriteOutput')

    // Positive control: the same file, same session, read without the marker, does collapse. It
    // must use a different line range from the declined read above -- that shell call stored its
    // own body Bash-side, so re-running the same range would collapse against that instead and the
    // control would stay green with the producer deleted entirely.
    postReadHandler(readEvent())
    const after = await postBashHandler(shellEvent("sed -n '60,100p' README.md", slice(60, 100)))
    expect(after.hookType).toBe('rewriteOutput')
  })

  it('does not answer a read of one file from another file served identically', async () => {
    // The store is per file. Two files can hold identical text (a vendored copy, a generated
    // duplicate), and a pointer produced from the wrong path would name the wrong recall target.
    const body = slice(1, 40)
    postReadHandler(readEvent())
    const other = await postBashHandler(shellEvent("sed -n '1,40p' CHANGELOG.md", body))
    expect(other.hookType).not.toBe('rewriteOutput')

    // Positive control: the identical bytes, asked for under the path that was actually read.
    const same = await postBashHandler(shellEvent("sed -n '1,40p' README.md", body))
    expect(same.hookType).toBe('rewriteOutput')
  })
})

function runReadHook(sessionId: string, toolInput: Record<string, unknown>, content: string) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: REPO,
    tool_name: 'Read',
    tool_input: toolInput,
    tool_response: { content },
  })
  return spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8' })
}

function runBashHook(sessionId: string, command: string, output: string) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: REPO,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: output, exitCode: 0 },
  })
  return spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8' })
}

describe('built bundle: a Read in one process feeds the collapse in another', () => {
  it('collapses a shell read run after a Read in a separate hook process', () => {
    const body = slice(1, 40)
    const first = runReadHook('e2e-read-producer', { file_path: TARGET }, slice(1, 5))
    expect(first.status).toBe(0)

    const second = runBashHook('e2e-read-producer', "sed -n '1,40p' README.md", body)
    expect(second.status).toBe(0)
    const parsed = JSON.parse(second.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: unknown }
    }
    // The cross-process assertion. If the served body lived only in module state, this second
    // process would see no container and emit `{}`.
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(rewrittenKeys(parsed.hookSpecificOutput?.updatedToolOutput)).toEqual(
      expect.arrayContaining(['stdout', 'exitCode']),
    )
    const replaced = rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput)
    expect(replaced.length).toBeLessThan(body.length)
    expect(replaced).toContain('token-goat bash-output ')
  })

  it('does not carry a served body into a different session', () => {
    // The pointer's claim is that the model is already holding these bytes, which is only true
    // within one conversation. The blob cache on disk outlives a session, so a lookup that ignored
    // the session would replace a fresh conversation's first read with a pointer at a body it never
    // saw -- the content would simply be gone.
    const body = slice(1, 40)
    expect(runReadHook('e2e-read-sess-a', { file_path: TARGET }, slice(1, 5)).status).toBe(0)

    const other = runBashHook('e2e-read-sess-b', "sed -n '1,40p' README.md", body)
    expect(other.status).toBe(0)
    expect(JSON.parse(other.stdout)).toEqual({})

    // Discrimination check: the decline above only means something if the same session does
    // collapse. Without it, a producer that never wrote anything would leave this green.
    expect(runReadHook('e2e-read-sess-a', { file_path: TARGET }, slice(1, 5)).status).toBe(0)
    const same = runBashHook('e2e-read-sess-a', "sed -n '1,40p' README.md", body)
    expect(same.status).toBe(0)
    const parsed = JSON.parse(same.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    expect(rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput)).toContain('token-goat bash-output ')
  })
})
