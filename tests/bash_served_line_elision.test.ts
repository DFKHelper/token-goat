/**
 * Per-stretch elision of already-served lines on the shell surface (hooks_bash.ts `elideServedShellLines`).
 *
 * The containment collapse next to it is all-or-nothing: it fires only when a whole output appears
 * verbatim inside one earlier body. Two shell reads of one file usually overlap without nesting --
 * `sed -n '100,140p'` after `sed -n '120,160p'` is contained in nothing, yet half of it has already
 * been shown -- and that shape used to ship every already-seen line again. These tests pin the
 * narrower rule: withhold the stretches that were served, keep everything else, and refuse to
 * annotate a read whose line numbers the command does not determine.
 *
 * Fixture provenance:
 *   - `LINES`, the stand-in file content, is HAND-DERIVED: one distinguishable line per file line,
 *     sized past IDENTICAL_READ_MIN_BODY_BYTES so the floor is never what a test is measuring.
 *     Nothing about the elision logic is baked into it -- the slices below are computed from the
 *     command's own ranges, the way a real `sed` would compute them, not read off the matcher.
 *   - The PostToolUse payload shape is FORMAT-DERIVED from `src/hook_registry.ts::serializeOutput`,
 *     the same provenance and the same caveat as `bash_identical_read_collapse.test.ts` records.
 *   - The commands name real repo files because the read extractors deliberately exempt temp paths
 *     (`hooks_bash.ts::isTempPath`), so a fixture under os.tmpdir() is classified as "not a file
 *     read" and every case here would pass by never running the code at all.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** File line N, one-indexed, distinguishable from every other and long enough that a modest slice clears the 512-byte floor. */
function fileLine(n: number): string {
  return `line ${n}: ${'x'.repeat(60)}`
}

/** What `sed -n 'lo,hip' file` would print, computed from the range rather than from the code under test. */
function slice(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(fileLine(n))
  return out.join('\n')
}

function postEvent(command: string, output: string, sessionId = 's') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } },
  })
}

/** The body the model is handed: the rewrite when one was emitted, otherwise the untouched output. */
function delivered(out: Awaited<ReturnType<typeof postBashHandler>>, fallback: string): string {
  return out.hookType === 'rewriteOutput' ? out.updatedOutput : fallback
}

describe('postBashHandler: per-stretch elision of already-served shell lines', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('withholds only the overlapping stretch of a read that is contained in nothing', async () => {
    // The measured shape, and the one the containment collapse cannot see: neither read contains the
    // other, so `containsLineRun` says no and the whole 41 lines used to ship.
    const first = await postBashHandler(postEvent("sed -n '120,160p' README.md", slice(120, 160)))
    expect(first.hookType).not.toBe('rewriteOutput')

    const second = slice(100, 140)
    const out = await postBashHandler(postEvent("sed -n '100,140p' README.md", second))
    expect(out.hookType).toBe('rewriteOutput')
    const body = delivered(out, second)
    // Everything below 120 was never shown and must arrive.
    expect(body).toContain(fileLine(100))
    expect(body).toContain(fileLine(119))
    // 120 through 140 were shown, as whole lines, and must not.
    expect(body).not.toContain(fileLine(120))
    expect(body).not.toContain(fileLine(140))
    expect(body.length).toBeLessThan(second.length)
    expect(body).toContain('token-goat bash-output ')
  })

  it('names the withheld stretch by its line numbers in the file, not by its position in the output', async () => {
    // The withheld run starts at output row 20 and at file line 120. Quoting the row index would be a
    // lie the reader cannot detect, since both are plausible small numbers.
    await postBashHandler(postEvent("sed -n '120,160p' README.md", slice(120, 160)))
    const second = slice(100, 140)
    const out = await postBashHandler(postEvent("sed -n '100,140p' README.md", second))
    expect(delivered(out, second)).toContain('lines 120-140 were already served')
  })

  it('numbers a multi-range read across the gap in its ranges', async () => {
    // `sed -n '10,20p;50,60p'` delivers 22 contiguous output rows spanning two disjoint file
    // stretches. Counting rows would number the second stretch 12-22; only the command's own ranges
    // give 50-60.
    const wide = slice(50, 60)
    await postBashHandler(postEvent("sed -n '50,60p' README.md", wide + '\n' + 'z'.repeat(600)))
    const second = slice(10, 20) + '\n' + slice(50, 60)
    const out = await postBashHandler(postEvent("sed -n '10,20p;50,60p' README.md", second))
    const body = delivered(out, second)
    expect(body).toContain(fileLine(10))
    expect(body).toContain('lines 50-60 were already served')
    expect(body).not.toContain(fileLine(55))
  })

  it('leaves a tail read whole, because the command does not say where its window starts', async () => {
    // `tail -n 20` names no line numbers: where its window begins depends on how long the file is,
    // which the command does not state. A notice here would have to guess, so there is none -- the
    // read passes through even though its lines were served.
    // Overlapping, not nested, so the containment collapse next door does not fire either and what
    // happens here is this rule's decision alone.
    await postBashHandler(postEvent("sed -n '1,40p' CHANGELOG.md", slice(1, 40)))
    const again = slice(31, 50)
    const out = await postBashHandler(postEvent('tail -n 20 CHANGELOG.md', again))
    expect(delivered(out, again)).toContain(fileLine(35))

    // Calibration: the identical overlap under a command that does name its lines is elided, so the
    // case above passes because of the tail, not because nothing was eligible.
    const ranged = await postBashHandler(postEvent("sed -n '31,50p' CHANGELOG.md", again))
    expect(delivered(ranged, again)).not.toContain(fileLine(35))
  })

  it('caches what the model was shown, not what the command printed', async () => {
    // The store answers "has this been served"; filling it from the command's output would let a
    // later read be told a stretch was already shown when only a notice about it was.
    await postBashHandler(postEvent("sed -n '120,160p' CHANGELOG.md", slice(120, 160)))
    const second = slice(100, 140)
    const elided = await postBashHandler(postEvent("sed -n '100,140p' CHANGELOG.md", second))
    expect(elided.hookType).toBe('rewriteOutput')

    // A third read of a stretch that only ever appeared behind that notice. It is still withheld,
    // but the id it points at must be the read that actually showed those lines.
    const third = slice(125, 135)
    const out = await postBashHandler(postEvent("sed -n '125,135p' CHANGELOG.md", third + '\n' + 'q'.repeat(600)))
    const body = delivered(out, third)
    expect(body).not.toContain(fileLine(130))
  })

  it('leaves a read whose lines are all new completely alone', async () => {
    // The calibration for every case above: without it they only prove that something was rewritten,
    // not that overlap is what drives it.
    await postBashHandler(postEvent("sed -n '1,40p' README.md", slice(1, 40)))
    const fresh = slice(200, 240)
    const out = await postBashHandler(postEvent("sed -n '200,240p' README.md", fresh))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

})

// Session scoping is deliberately not asserted here. It cannot be: in-process these two calls share
// module state, so a test of it would stay green whatever the code did -- the same reason
// bash_identical_read_collapse.test.ts puts its cross-session case in the built-bundle layer, where
// each hook invocation is its own process. This rule reads the same per-file served store that
// path already scopes and guards there, and adds no store of its own.
