/**
 * Structural guard on "untrusted content is fenced by provenance"
 * (CLAUDE.arch.md's Security Boundaries).
 *
 * `token-goat recall`, `pr-slice`, and `gdrive-sections` all shipped emitting third-party-
 * authored text (a recalled cache snippet, a GitHub PR's title/body/comments/diff, a Google Doc's
 * text) straight to stdout with no call anywhere near `scanForInjectionPatterns`/
 * `fenceUntrustedContent`. All three reached that state the same way: nothing forced whoever
 * wrote the command to notice that its content came from outside token-goat. A hand-maintained
 * list of command names to double-check has exactly that failure mode -- an omission from the
 * list is invisible, which is how these three shipped in the first place.
 *
 * So this test does not enumerate commands. It enumerates *functions*, by parsing the actual
 * source of every file in `src/`, and asks a mechanical question of each one: does this function
 * (directly, or by calling another function defined in the same file, transitively) call one of
 * the handful of primitives through which third-party text actually enters token-goat -- a GitHub
 * PR fetch (`pr_slice.ts`, via `gh`), a Google Doc fetch (`gdrive.ts`), or the cross-cache recall
 * index reading back previously-cached bash/web/mcp output (`recall_index.ts`)? If so, that same
 * function (or something it calls, same-file, transitively) must also reach
 * `fenceUntrustedContent(` -- directly, or via `_applyFiltersAndPrint(..., true, ...)`, the
 * existing fence-gated boundary in `cli.ts`.
 *
 * A brand new command that calls `fetchPrFiles`/`fetchDoc`/`searchRecall`/etc. (the only realistic
 * way to pull third-party text into token-goat today, short of a wholly new fetch primitive --
 * see the disclosed gap below) enters this guard's population automatically, the same turn it is
 * written, with nobody needing to remember to add it anywhere.
 *
 * Deliberate scope limit, disclosed rather than silently accepted: the population is anchored on
 * the *content-retrieval* functions themselves (`fetchPrFiles`, `fetchDoc`, `searchRecall`, ...),
 * not on the lower-level HTTP primitive they and other, non-text consumers share
 * (`performHttpFetch` in webfetch.ts, also called by `hooks_fetch.ts` and by `fetch-image`, which
 * downloads an image and has no injection surface to fence). Anchoring on `performHttpFetch`
 * itself would need every image-only caller special-cased to avoid a false positive; anchoring
 * one level up avoids that at the cost of not catching a wholly new fetch/read primitive that
 * bypasses every function named below. That primitive-level gap is real and is the honest edge
 * of what this guard can see; a genuinely new third-party ingestion mechanism still needs a human
 * to add its entry point to THIRD_PARTY_SOURCE_CALLS below, the same way a new *kind* of
 * lock-worthy config setting still needs a human decision in
 * `project_config_lock_coverage.test.ts`'s REVIEWED_OVERRIDABLE. What is automatic is every
 * *caller* of an already-named entry point, in any file, present or future.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/**
 * The functions through which third-party-authored text actually enters token-goat's own output,
 * as opposed to text token-goat generates itself or reads from a file the user named locally.
 * See this file's header comment for what anchoring here does and does not catch.
 */
const THIRD_PARTY_SOURCE_CALLS: readonly string[] = [
  // pr_slice.ts -- a GitHub PR's files/diff/comments/description, authorable by anyone who opens a PR.
  'fetchPrFiles',
  'fetchPrDiff',
  'fetchPrComments',
  'fetchPrDescription',
  // gdrive.ts -- a Google Doc's text, authorable by anyone who can edit a shared doc.
  'fetchDoc',
  'getSectionContent',
  'getDocSections',
  // recall_index.ts -- previously cached bash/web/mcp output, read back out of the cross-cache index.
  'searchRecall',
  'listRecentRecall',
]
// `getBashOutput`/`getWebOutput`/`getWebOutputRaw` (the existing, already-fenced bash/web/mcp
// recall paths) are deliberately NOT in the population above: those functions are also called
// internally for dedup/hashing/existence-checking, not only to emit third-party text to the
// model, so anchoring the population on them produces call sites this guard cannot tell apart
// from a real violation. Their fencing is proven instead by the dedicated behavioral regression
// tests for `bash-output`/`web-output`/`mcp-output` in tests/cli.test.ts and its neighbors
// (verification requirement #4), which assert the actual fenced output, not just that some
// function reaches the call.

/** True when `body` reaches the fence boundary itself. */
function callsFence(body: string): boolean {
  if (body.includes('fenceUntrustedContent(')) return true
  // cli.ts's shared boundary: `_applyFiltersAndPrint(text, opts, true, ...)` runs the scan and
  // fence internally when its third argument (`fenceUntrusted`) is `true`.
  if (/_applyFiltersAndPrint\([^;]*?,\s*true\b/.test(body)) return true
  return false
}

interface FnInfo {
  readonly name: string
  readonly body: string
}

/**
 * Every top-level `function name(...) { ... }` / `async function name(...) { ... }` declaration
 * in `src`, keyed by file, with each function's full body text (brace-matched, so a `}` inside a
 * string or a nested block never ends it early).
 */
function parseTopLevelFunctions(src: string): FnInfo[] {
  const out: FnInfo[] = []
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*>)?\s*\(/gm
  let m: RegExpExecArray | null
  while ((m = declRe.exec(src)) !== null) {
    const name = m[1]!
    const parenStart = m.index + m[0].length - 1 // the '(' the regex ended on
    let depth = 0
    let seenParams = false
    let open = -1
    for (let i = parenStart; i < src.length; i++) {
      const c = src[i]
      if (c === '(') {
        depth++
        seenParams = true
      } else if (c === ')') {
        depth--
      } else if (c === '{' && seenParams && depth === 0) {
        open = i
        break
      }
    }
    if (open === -1) continue
    let braceDepth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') braceDepth++
      else if (src[i] === '}' && --braceDepth === 0) {
        close = i
        break
      }
    }
    if (close === -1) continue
    out.push({ name, body: src.slice(open, close + 1) })
  }
  return out
}

/** A file's function bodies, keyed by name, for same-file transitive-call resolution. */
function functionMap(fns: readonly FnInfo[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const fn of fns) m.set(fn.name, fn.body)
  return m
}

/** Direct callee names referenced in `body` (a superset of real calls -- good enough for BFS,
 * since a false-positive edge can only make `reaches()` MORE permissive, matching this guard's
 * conservative-toward-not-flagging design given its stated scope limit above). */
function calleeNames(body: string): string[] {
  const names: string[] = []
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(body)) !== null) names.push(m[1]!)
  return names
}

/** True when `fn`'s body, or any locally-defined function reachable from it by same-file calls,
 * satisfies `predicate`. */
function reaches(fn: FnInfo, byName: Map<string, string>, predicate: (body: string) => boolean): boolean {
  const visited = new Set<string>()
  const stack: string[] = [fn.name]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (visited.has(name)) continue
    visited.add(name)
    const body = byName.get(name)
    if (body === undefined) continue
    if (predicate(body)) return true
    for (const callee of calleeNames(body)) {
      if (!visited.has(callee) && byName.has(callee)) stack.push(callee)
    }
  }
  return false
}

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(SRC_DIR, f))
}

/**
 * The modules that themselves define the functions in THIRD_PARTY_SOURCE_CALLS. Their own
 * internal wrapper functions (e.g. `gdrive.ts`'s `getSectionContent` calling its own `fetchDoc`)
 * return structured data to a caller -- they never emit to stdout themselves, so fencing belongs
 * at the consumer that actually prints, not here. Excluding a source module from its own
 * population is what keeps this guard pointed at *consumers*, matching the real bug shape (three
 * command handlers, not the fetch modules they called).
 */
const SOURCE_MODULE_FILES: ReadonlySet<string> = new Set(['pr_slice.ts', 'gdrive.ts', 'recall_index.ts'])

interface Violation {
  readonly file: string
  readonly fn: string
}

function findViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of srcFiles()) {
    if (SOURCE_MODULE_FILES.has(path.basename(file))) continue
    const src = fs.readFileSync(file, 'utf8')
    const fns = parseTopLevelFunctions(src)
    if (fns.length === 0) continue
    const byName = functionMap(fns)
    for (const fn of fns) {
      const touchesSource = reaches(fn, byName, (body) =>
        THIRD_PARTY_SOURCE_CALLS.some((call) => new RegExp(`\\b${call}\\s*\\(`).test(body)),
      )
      if (!touchesSource) continue
      const fenced = reaches(fn, byName, callsFence)
      if (!fenced) violations.push({ file: path.relative(SRC_DIR, file), fn: fn.name })
    }
  }
  return violations
}

describe('every function that reaches third-party content also reaches the fence', () => {
  it('has no function that calls a third-party content source without fencing what it reads', () => {
    const violations = findViolations()
    expect(
      violations,
      'these functions call a third-party content source (see THIRD_PARTY_SOURCE_CALLS) but ' +
        'never reach fenceUntrustedContent(...) or _applyFiltersAndPrint(..., true, ...), so ' +
        'attacker-authored text they read reaches the model unfenced: ' +
        violations.map((v) => `${v.file}::${v.fn}`).join(', '),
    ).toEqual([])
  })

  // Guards the guard: if source-tree parsing ever silently returned nothing (a moved src/
  // directory, a broken glob), the check above would pass vacuously.
  it('actually finds source-defined third-party-content functions to check against', () => {
    let found = 0
    for (const file of srcFiles()) {
      const fns = parseTopLevelFunctions(fs.readFileSync(file, 'utf8'))
      found += fns.filter((fn) => THIRD_PARTY_SOURCE_CALLS.includes(fn.name)).length
    }
    expect(found).toBeGreaterThanOrEqual(THIRD_PARTY_SOURCE_CALLS.length)
  })
})
