/**
 * Identical shell file-read collapse (hooks_bash.ts `maybeCollapseIdenticalRead`).
 *
 * A pure file read re-run with byte-identical output hands the model bytes it already holds. The
 * post-hook replaces that duplicate body with a pointer at the cached copy.
 *
 * Two layers, per this project's injected-seam discipline:
 *   1. In-process tests of `postBashHandler` for the decision itself: first run stores and passes,
 *      identical re-run collapses, changed content does not, a non-read command does not, a failed
 *      read does not, and a body under the floor does not.
 *   2. Built-bundle e2e tests that pipe real `PostToolUse` payloads through
 *      `dist/token-goat.mjs hook post_tool_use` in separate processes. This layer is the
 *      authoritative one and is not redundant with layer 1: in production every hook invocation is
 *      its own process, so the collapse only works if the prior body is recoverable from the
 *      on-disk cache rather than from module state. An in-process test shares `_byId` between the
 *      two calls and would stay green even if nothing were ever persisted. Session scoping can
 *      only be tested here too, for the reason spelled out on that test.
 *
 * Fixture provenance:
 *   - `BODY`, the stand-in read output, is HAND-DERIVED: generated line text sized past
 *     IDENTICAL_READ_MIN_BODY_BYTES. Nothing about the product's own logic is baked into it; it
 *     only has to be stable across the two runs and large enough to clear the floor. The commands
 *     name real repo files because the extractors exempt temp paths (see the REPO note below).
 *   - The PostToolUse request payload keys (`hook_event_name`, `session_id`, `cwd`, `tool_name`,
 *     `tool_input.command`, `tool_response`) and the response shape
 *     (`hookSpecificOutput.{hookEventName,updatedToolOutput}`) are FORMAT-DERIVED from this repo's
 *     own serializer contract in `src/hook_registry.ts::serializeOutput` and its docblock. That is
 *     weaker than a CAPTURE: it proves agreement with our serializer, not that a shipped Claude
 *     Code build accepts it. The wire shape is pinned here so a silent change to it is loud.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler } from '../src/hooks_bash.js'
import { commandHash, getBashOutput } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { BUNDLE } from './helpers/bundle.js'

// Comfortably past IDENTICAL_READ_MIN_BODY_BYTES (512) so the floor is never what a test is
// accidentally measuring.
const BODY = Array.from({ length: 40 }, (_, i) => `line ${i}: ${'x'.repeat(60)}`).join('\n')

// Real, already-present repo files. They must NOT be under a temp directory: the read extractors
// deliberately exempt temp scratch paths (hooks_bash.ts `isTempPath`), so a fixture in os.tmpdir()
// is classified as "not a file read" and nothing would ever collapse -- the first version of this
// test made exactly that mistake and its four negative cases all passed anyway.
// Each case uses a distinct line range so the commands hash to distinct cache keys and cannot
// contaminate one another.
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function postEvent(command: string, output: string, exitCode = 0, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: {
      // `cwd` matters: the handler keys the cache on commandHash(cmd, getCwd(event)), so a test
      // that omits it stores under a different key than one that asserts with REPO, and any
      // cache-entry assertion below would read null no matter what the code did.
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: output, exitCode },
    },
  })
}

describe('postBashHandler: identical file-read collapse', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes the first run through untouched, then collapses a byte-identical re-run', async () => {
    const cmd = "sed -n '1,40p' README.md"
    const first = await postBashHandler(postEvent(cmd, BODY))
    expect(first.hookType).not.toBe('rewriteOutput')

    const second = await postBashHandler(postEvent(cmd, BODY))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      // The whole point: the replacement is far smaller than the body it replaced, and it names the
      // recall command so the dropped bytes stay reachable rather than being destroyed.
      expect(second.updatedOutput.length).toBeLessThan(BODY.length)
      expect(second.updatedOutput).toContain('token-goat bash-output ')
    }
  })

  it('does not collapse when the file content changed between runs', async () => {
    const cmd = "sed -n '5,44p' README.md"
    await postBashHandler(postEvent(cmd, BODY))
    // A single character differs. The collapse is byte-identity only, so this must pass through
    // with the new body intact -- collapsing here would delete a real change.
    const changed = BODY.replace('line 7:', 'line 7!')
    const second = await postBashHandler(postEvent(cmd, changed))
    expect(second.hookType).not.toBe('rewriteOutput')
  })

  it('does not collapse a command that is not a pure file read', async () => {
    // Identical output from a test run is the finding, not redundancy: `npm test` printing the same
    // thing twice means the suite is still green, and replacing that with a pointer deletes the
    // answer. Guarded by pureFileReadPath returning null.
    const cmd = 'npm test'
    await postBashHandler(postEvent(cmd, BODY))
    const second = await postBashHandler(postEvent(cmd, BODY))
    expect(second.hookType).not.toBe('rewriteOutput')
  })

  it('does not collapse when the read failed', async () => {
    const cmd = "sed -n '9,48p' README.md"
    await postBashHandler(postEvent(cmd, BODY, 1))
    const second = await postBashHandler(postEvent(cmd, BODY, 1))
    expect(second.hookType).not.toBe('rewriteOutput')
  })

  it('collapses a narrower read of a file already read wider, under a different command', async () => {
    // The measured case, from a real transcript: `head -40 CHANGELOG.md` followed by
    // `sed -n '1,30p' CHANGELOG.md`. Different commands, different hashes, different bytes -- so
    // the identical-run check never fires -- yet every line the second returns was in the first.
    const wide = await postBashHandler(postEvent('head -40 CHANGELOG.md', BODY))
    expect(wide.hookType).not.toBe('rewriteOutput')

    const narrowBody = BODY.split('\n').slice(0, 30).join('\n')
    const narrow = await postBashHandler(postEvent("sed -n '1,30p' CHANGELOG.md", narrowBody))
    expect(narrow.hookType).toBe('rewriteOutput')
    if (narrow.hookType === 'rewriteOutput') {
      expect(narrow.updatedOutput.length).toBeLessThan(narrowBody.length)
      expect(narrow.updatedOutput).toContain('token-goat bash-output ')
      // Distinct wording from the identical case: this body was not a repeat of the same command,
      // it was part of a wider one, and the recall id points at that wider output.
      expect(narrow.updatedOutput).toContain('wider read')
    }
  })

  it('does not collapse a read that reaches past everything already served', async () => {
    // The reverse order of the case above. The narrow read comes first, so the wider one carries
    // lines never shown; withholding it would delete them. Containment is one-directional and this
    // is the direction that must not fire.
    const narrowBody = BODY.split('\n').slice(0, 30).join('\n')
    await postBashHandler(postEvent("sed -n '1,30p' CHANGELOG.md", narrowBody))
    const wide = await postBashHandler(postEvent('head -40 CHANGELOG.md', BODY))
    expect(wide.hookType).not.toBe('rewriteOutput')
  })

  it('does not collapse against a body served for a different file', async () => {
    // Two files can hold identical text -- a vendored copy, a generated duplicate, a lockfile. The
    // index is per file, so a read of one must never be answered from the other, whose recall id
    // would point at the wrong path.
    await postBashHandler(postEvent('head -40 CHANGELOG.md', BODY))
    const other = await postBashHandler(postEvent('head -40 README.md', BODY))
    expect(other.hookType).not.toBe('rewriteOutput')
  })

  it('does not collapse on a substring that is not line-aligned', async () => {
    // A plain substring test would match here and withhold lines the model was never shown as
    // lines. The prior body's text contains every character of the new output, but the new
    // output's first and last lines are fragments of the prior body's lines, not whole ones.
    const priorBody = Array.from({ length: 40 }, (_, i) => `prefix-line ${i}: ${'y'.repeat(60)}-suffix`).join('\n')
    await postBashHandler(postEvent('head -40 CHANGELOG.md', priorBody))
    const fragment = priorBody.slice(priorBody.indexOf('line 0'), priorBody.indexOf('-suffix', priorBody.indexOf('line 20')))
    expect(priorBody).toContain(fragment)
    expect(Buffer.byteLength(fragment, 'utf-8')).toBeGreaterThan(512)
    const partial = await postBashHandler(postEvent("sed -n '1,21p' CHANGELOG.md", fragment))
    expect(partial.hookType).not.toBe('rewriteOutput')
  })

  it('does no cache work at all for a body below the size floor', async () => {
    // Two independent gates keep a tiny body from collapsing: IDENTICAL_READ_MIN_BODY_BYTES, and
    // the shared isRewriteWorthwhile net-benefit check (a ~150-byte pointer can never be smaller
    // than a 7-byte body). Asserting only "did not collapse" therefore proves nothing about the
    // floor -- deleting the floor leaves that assertion green, which a mutation run confirmed.
    //
    // So assert the floor's actual job instead: it returns *before* hashing the command and
    // touching the on-disk cache, so a below-floor read must leave no cache entry behind. Remove
    // the floor and the first run falls through to storeBashOutput, turning this red.
    const cmd = "sed -n '13,14p' README.md"
    const tiny = 'one\ntwo'
    await postBashHandler(postEvent(cmd, tiny))
    const second = await postBashHandler(postEvent(cmd, tiny))
    expect(second.hookType).not.toBe('rewriteOutput')
    expect(getBashOutput(await commandHash(cmd, REPO))).toBeNull()
  })
})

function runHook(cmd: string, sessionId: string) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd: REPO,
    tool_name: 'Bash',
    tool_input: { command: cmd },
    tool_response: { stdout: BODY, exitCode: 0 },
  })
  return spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8' })
}

describe('built bundle: identical file-read collapse survives across processes', () => {
  it('collapses on the second of two separate hook processes', () => {
    const cmd = "sed -n '17,56p' README.md"
    const run = () => runHook(cmd, 'e2e-identical')

    const first = run()
    expect(first.status).toBe(0)

    const second = run()
    expect(second.status).toBe(0)
    const parsed = JSON.parse(second.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: string }
    }
    // The cross-process assertion. If the prior body were held only in module state, this second
    // process would see no baseline and emit `{}`.
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeDefined()
    const replaced = parsed.hookSpecificOutput?.updatedToolOutput ?? ''
    expect(replaced.length).toBeLessThan(BODY.length)
    expect(replaced).toContain('token-goat bash-output ')
  })

  it('does not collapse against an identical run from a different session', () => {
    // The pointer's claim is that the model already holds these bytes, which is only true when the
    // earlier run happened in the same conversation. The blob cache behind storeBashOutput is on
    // disk and outlives a session, so a lookup keyed on the command hash alone would replace a
    // *first* read in a fresh session with a pointer at a body that session never saw -- the
    // content would simply be gone. The lookup goes through the session's own bashOutputs map,
    // which each hook process hydrates from its own session id, so a new session finds nothing.
    //
    // This has to live at the e2e layer: in-process, `postBashHandler` never hydrates session state
    // (relay.ts does that once per hook process), so two in-process calls share one `_bashOutputs`
    // map no matter what session id their events carry, and the distinction is invisible.
    const cmd = "sed -n '21,60p' README.md"
    expect(runHook(cmd, 'e2e-session-a').status).toBe(0)

    // Same command, same bytes, same on-disk blob -- different conversation.
    const other = runHook(cmd, 'e2e-session-b')
    expect(other.status).toBe(0)
    expect(JSON.parse(other.stdout)).toEqual({})

    // Discrimination check: the assertion above only means something if a same-session repeat does
    // collapse. Without it, a bug that disabled the collapse outright would leave this test green.
    const repeat = runHook(cmd, 'e2e-session-b')
    expect(repeat.status).toBe(0)
    const parsed = JSON.parse(repeat.stdout) as { hookSpecificOutput?: { updatedToolOutput?: string } }
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toContain('token-goat bash-output ')
  })
})
