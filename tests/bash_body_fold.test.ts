/**
 * Body folding on the shell read surface (hooks_bash.ts `foldShellReadBodies`).
 *
 * The Read hook has folded first reads for a while; a shell read of the same file got nothing.
 * Measured over 814 session transcripts, 15.61 MB of source arrives through `cat`, `head` and
 * `sed -n` rather than through the Read tool, and it is a first-read surface: the elision beside
 * this rule needs an earlier delivery to withhold against, and a first read has none.
 *
 * The one rule that could not be carried over from the Read path is its safety rule. There, any
 * read carrying offset or limit is declined as already surgical. Here 14.61 MB of that 15.61 MB is
 * a range, so the same exemption would exempt the surface. What makes a range safe instead is
 * `planBodyFolds` requiring a span's declaration to be among the delivered rows -- the case pinned
 * by `window sitting inside one symbol` below, and in isolation by
 * tests/code_fold_window_containment.test.ts.
 *
 * Fixture provenance:
 *   - The folded content is a real repo source file, read from disk and indexed by the real
 *     `indexFileSync`, so the spans are whatever the shipping parser writes rather than a
 *     hand-written span list that would agree with the matcher by construction. Line numbers are
 *     never hardcoded: every window below is computed from `querySymbols` at run time, so the file
 *     can grow without silently turning these into tests of an empty window.
 *   - The PostToolUse payload shape is FORMAT-DERIVED from `src/hook_registry.ts::serializeOutput`,
 *     the same provenance and caveat recorded by `bash_served_line_elision.test.ts`.
 *   - The command names a real repo file because the read extractors deliberately exempt temp paths
 *     (`hooks_bash.ts::isTempPath`), so a fixture under os.tmpdir() is classified as "not a file
 *     read" and every case here would pass by never running the code at all.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler } from '../src/hooks_bash.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { getFileServedOutputs } from '../src/session.js'
import { normalizePath } from '../src/util.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { rewrittenBody } from './helpers/updated-tool-output.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A real source file that reliably holds a function longer than BODY_FOLD_MIN_SPAN. One file, not the whole tree: indexing is the slow part and this rule only ever looks at one file's spans. */
const TARGET_REL = 'src/code_fold.ts'
const TARGET_ABS = normalizePath(path.join(REPO, TARGET_REL))
const SOURCE = readFileSync(TARGET_ABS, 'utf-8')
const LINES = SOURCE.split('\n')

/**
 * The whole file, spelled as a command that reaches this path.
 *
 * `cat src/x.ts` does not. The pre-hook denies a bare source-file `cat` outright (hooks_bash.ts, the `loads the entire file into context` branch), and on the way back MONITORING_COMMAND_PATTERNS claims the same shape and routes it to the recall cache, so it never reaches the read collapse at all. That is the 1.00 MB whole-file slice of the surface and it is already answered upstream; the 14.61 MB this rule is aimed at arrives as `head` and `sed -n`.
 */
const WHOLE_FILE_CMD = `head -n ${LINES.length} ${TARGET_REL}`

/** What `sed -n 'lo,hip' file` prints, computed from the range rather than from the code under test. */
function slice(lo: number, hi: number): string {
  return LINES.slice(lo - 1, hi).join('\n')
}

/** The longest indexed function span in the target, chosen at run time so a moved or renamed symbol cannot silently empty these windows. */
function longestSpan(): { name: string; lineStart: number; lineEnd: number } {
  const spans = querySymbols({ filePath: TARGET_ABS, limit: 10000 })
    .filter((s) => s.kind === 'function' && s.lineEnd - s.lineStart + 1 >= 40)
    .sort((a, b) => b.lineEnd - b.lineStart - (a.lineEnd - a.lineStart))
  const best = spans[0]
  if (best === undefined) throw new Error(`no function span of 40+ lines indexed in ${TARGET_REL}; fixture assumption broken`)
  return { name: best.name, lineStart: best.lineStart, lineEnd: best.lineEnd }
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

const PREV_FLAG = process.env['TOKEN_GOAT_FOLD_CODE_BODIES']

beforeAll(() => {
  indexFileSync(TARGET_ABS)
})

afterAll(() => {
  if (PREV_FLAG === undefined) delete process.env['TOKEN_GOAT_FOLD_CODE_BODIES']
  else process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = PREV_FLAG
})

describe('postBashHandler: body folding on a shell read', () => {
  beforeEach(() => {
    // The fold ships opt-in, the same as on the Read surface. Setting it per test rather than once keeps clearModuleCaches from reloading a config that no longer has it.
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '1'
    clearModuleCaches()
  })

  it('folds long bodies out of a whole-file read and names the command that returns them', async () => {
    const out = await postBashHandler(postEvent(WHOLE_FILE_CMD, SOURCE, 'whole'))
    expect(out.hookType).toBe('rewriteOutput')
    const body = delivered(out, SOURCE)

    const span = longestSpan()
    // The notice has to be actionable as printed: the symbol it names is one the index really holds, and the path is the repo-relative one a reader can paste back.
    expect(body).toContain(`folded -- token-goat read "${TARGET_REL}::${span.name}"`)
    // Declaration kept, deep body gone. Both matter: keeping the first lines is the whole difference between this and a skeleton.
    expect(body).toContain(LINES[span.lineStart - 1] ?? '')
    expect(body).not.toContain(LINES[span.lineEnd - 2] ?? '')
    expect(body.length).toBeLessThan(SOURCE.length)
  })

  it('folds a range whose delivered rows include the declaration', async () => {
    const span = longestSpan()
    const cmd = `sed -n '${span.lineStart},${span.lineEnd}p' ${TARGET_REL}`
    const text = slice(span.lineStart, span.lineEnd)
    const out = await postBashHandler(postEvent(cmd, text, 'ranged-from-decl'))
    expect(out.hookType).toBe('rewriteOutput')
    const body = delivered(out, text)
    expect(body).toContain(`folded -- token-goat read "${TARGET_REL}::${span.name}"`)
    // The window starts at the declaration, so it survives; the notice replaces only what follows it.
    expect(body.split('\n')[0]).toBe(LINES[span.lineStart - 1])
  })

  it('leaves a window sitting inside one symbol whole, because its declaration was never delivered', async () => {
    // The failure this guards against empties the read entirely: every delivered row is body, the clip to delivered rows removes nothing, and the whole window collapses to a notice pointing at a declaration the caller never saw. Ranged shell reads are 14.61 MB of the 15.61 MB surface, so this is the common shape, not the corner.
    const span = longestSpan()
    const lo = span.lineStart + 4
    const hi = span.lineEnd - 1
    const cmd = `sed -n '${lo},${hi}p' ${TARGET_REL}`
    const text = slice(lo, hi)
    const out = await postBashHandler(postEvent(cmd, text, 'ranged-inside'))
    const body = delivered(out, text)
    expect(body).not.toContain(`folded -- token-goat read "${TARGET_REL}::${span.name}"`)
    // Every line the caller asked for is still there, in order. A comment fold inside the window would be legitimate, so this asserts the body lines specifically rather than byte equality.
    expect(body).toContain(LINES[lo - 1] ?? '')
    expect(body).toContain(LINES[hi - 1] ?? '')
  })

  it('does not fold a read whose line numbers the command does not determine', async () => {
    // `tail` has no fixed first line. Folding it would cut at a guessed line and then print that guess inside a notice, where it reads exactly like a real answer.
    const text = slice(LINES.length - 199, LINES.length)
    const out = await postBashHandler(postEvent(`tail -n 200 ${TARGET_REL}`, text, 'tail'))
    expect(delivered(out, text)).toBe(text)
  })

  it('does not fold a compound read, whose rows cannot be tied to file lines', async () => {
    const span = longestSpan()
    const text = slice(span.lineStart, span.lineEnd) + '\n---\n' + slice(1, 20)
    const cmd = `sed -n '${span.lineStart},${span.lineEnd}p' ${TARGET_REL}\necho ---\nsed -n '1,20p' ${TARGET_REL}`
    const out = await postBashHandler(postEvent(cmd, text, 'compound'))
    expect(delivered(out, text)).toBe(text)
  })

  it('declines to fold output carrying a secret rather than handing it back redacted', async () => {
    const poisoned = SOURCE.replace('\n', '\nconst AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"\n')
    const out = await postBashHandler(postEvent(WHOLE_FILE_CMD, poisoned, 'secret'))
    expect(delivered(out, poisoned)).toBe(poisoned)
  })

  it('records the folded text as what was served, not what the command printed', async () => {
    // A later read of this file is matched against this copy. Storing the full output here would let the elision withhold lines the reader never received; storing a rewrite that the net-benefit gate declined would do the reverse.
    const out = await postBashHandler(postEvent(WHOLE_FILE_CMD, SOURCE, 'served-store'))
    expect(out.hookType).toBe('rewriteOutput')
    const body = delivered(out, SOURCE)
    const ids = getFileServedOutputs(TARGET_ABS)
    const last = ids[ids.length - 1]
    expect(last).toBeDefined()
    expect(getBashOutput(last as string)?.output).toBe(body)
  })
})

describe('built bundle: shell body folding survives across processes', () => {
  it('folds a whole-file read in a separate hook process', () => {
    // The in-process cases prove the rule; this proves the rule is in the shipped artifact and reachable through the real hook entrypoint. A tree-shaken helper or a path that only exists in source would leave every test above green and this one emitting `{}`.
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-body-fold',
      cwd: REPO,
      tool_name: 'Bash',
      tool_input: { command: WHOLE_FILE_CMD },
      tool_response: { stdout: SOURCE, exitCode: 0 },
    })
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8', env: { ...process.env, TOKEN_GOAT_FOLD_CODE_BODIES: '1' } })
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeDefined()
    const body = rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput)
    expect(body).toContain(`folded -- token-goat read "${TARGET_REL}::`)
    expect(body.length).toBeLessThan(SOURCE.length)
  })
})
