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
 *   2. A built-bundle e2e that pipes two real `PostToolUse` payloads through
 *      `dist/token-goat.mjs hook post_tool_use` in two separate processes. This layer is the
 *      authoritative one and is not redundant with layer 1: in production every hook invocation is
 *      its own process, so the collapse only works if the prior body is recoverable from the
 *      on-disk cache rather than from module state. An in-process test shares `_byId` between the
 *      two calls and would stay green even if nothing were ever persisted.
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

function postEvent(command: string, output: string, exitCode = 0) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's',
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
    // answer. Guarded by isPureFileRead.
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

describe('built bundle: identical file-read collapse survives across processes', () => {
  it('collapses on the second of two separate hook processes', () => {
    const cmd = "sed -n '17,56p' README.md"
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-identical',
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command: cmd },
      tool_response: { stdout: BODY, exitCode: 0 },
    })

    const run = () => spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8' })

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
})
