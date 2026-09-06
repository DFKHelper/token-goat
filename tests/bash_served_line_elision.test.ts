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
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { BUNDLE } from './helpers/bundle.js'
import { rewrittenBody } from './helpers/updated-tool-output.js'

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

  it('sees through a `cd` on its own line above the read', async () => {
    // The commonest spelling in a multi-line block, and the one nothing used to strip: only `cd X &&`
    // was handled, so every interceptor saw `cd` rather than the read underneath it. Measured over
    // 201 sessions this shape alone carries 1.26 MB of already-served lines.
    await postBashHandler(postEvent("sed -n '120,160p' README.md", slice(120, 160)))
    const second = slice(100, 140)
    // `cd .` so the file is the same one the earlier read served: what is under test here is whether
    // the read below the prefix is found at all, not path resolution, which the case after this owns.
    const out = await postBashHandler(postEvent("cd .\nsed -n '100,140p' README.md", second))
    const body = delivered(out, second)
    expect(body).toContain(fileLine(100))
    expect(body).not.toContain(fileLine(130))
  })

  it('resolves the read against the directory the `cd` moves to, not the hook cwd', async () => {
    // The trap in the line above: stripping the prefix and naming the directory it moved to are two
    // regexes, and one widened without the other silently resolves `README.md` against the hook's own
    // cwd. Two files can hold identical text, so the only thing keeping this honest is the path.
    await postBashHandler(postEvent("sed -n '1,40p' README.md", slice(1, 40)))
    const same = slice(1, 40)
    const out = await postBashHandler(postEvent('cd docs\nsed -n \'1,40p\' README.md', same))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('withholds inside a compound read of one file, and counts the lines rather than naming them', async () => {
    // Paging a file is normally written as several ranges of it in one command with an `echo` between
    // them. That whole shape used to be invisible to the collapse. It is worth 0.64 MB of already-served
    // lines over 201 sessions, on top of the single-command form.
    await postBashHandler(postEvent("sed -n '120,160p' README.md", slice(120, 160)))
    const second = slice(100, 140) + '\n---\n' + slice(150, 170)
    const out = await postBashHandler(postEvent("sed -n '100,140p' README.md\necho ---\nsed -n '150,170p' README.md", second))
    const body = delivered(out, second)
    expect(body).toContain(fileLine(100))
    expect(body).toContain(fileLine(170))
    expect(body).not.toContain(fileLine(130))
    // An `echo` between the ranges can print any number of lines, so no row here can be tied to a file
    // line. Naming one anyway would read exactly like a correct one.
    expect(body).toContain('lines here were already served')
    expect(body).not.toMatch(/lines \d+-\d+ were already served/)
  })

  it('refuses a compound read that spans two files', async () => {
    // The record of what has been shown is per file, so a two-file read has no single entry to be
    // filed under. Merging them under either would let a read of one answer for the other.
    await postBashHandler(postEvent("sed -n '120,160p' README.md", slice(120, 160)))
    const second = slice(120, 160) + '\n---\n' + slice(1, 20)
    const out = await postBashHandler(postEvent("sed -n '120,160p' README.md\necho ---\nsed -n '1,20p' CHANGELOG.md", second))
    expect(delivered(out, second)).toContain(fileLine(130))
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

function runHook(command: string, output: string, sessionId: string) {
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

describe('built bundle: compound same-file elision survives across processes', () => {
  it('withholds the already-served stretch of a compound read in a separate hook process', () => {
    // The in-process cases above prove the rule; this proves the rule is in the shipped artifact and
    // reachable through the real hook entrypoint. A tree-shaken helper or an admission path that only
    // exists in source would leave every test above green and this one emitting `{}`.
    const first = runHook("sed -n '120,160p' README.md", slice(120, 160), 'e2e-compound')
    expect(first.status).toBe(0)

    const second = slice(100, 140) + '\n---\n' + slice(150, 170)
    const out = runHook("sed -n '100,140p' README.md\necho ---\nsed -n '150,170p' README.md", second, 'e2e-compound')
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeDefined()

    const body = rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput)
    expect(body).toContain(fileLine(100))
    expect(body).toContain(fileLine(170))
    expect(body).not.toContain(fileLine(130))
    expect(body).toContain('lines here were already served')
    expect(body).not.toMatch(/lines \d+-\d+ were already served/)
  })
})

// Session scoping is deliberately not asserted here. It cannot be: in-process these two calls share
// module state, so a test of it would stay green whatever the code did -- the same reason
// bash_identical_read_collapse.test.ts puts its cross-session case in the built-bundle layer, where
// each hook invocation is its own process. This rule reads the same per-file served store that
// path already scopes and guards there, and adds no store of its own.
