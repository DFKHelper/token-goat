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
  // pdf/docx/pptx/xlsx extractors -- a local path the caller named is not the same thing as
  // content the caller wrote. An emailed invoice, a downloaded report, a contract someone else
  // drafted are all third-party text that happens to live on this disk, and the threat model
  // counts them as untrusted precisely BECAUSE the user only named the file rather than
  // authoring it. This surface was missing from the population entirely, so every document
  // command was outside the guard's view while it reported green. Named by the local alias each
  // is imported under in cli.ts, since that is what appears at the call site.
  'runPdfExtractText',
  'runPdfLocate',
  'runPdfOutline',
  'docxText',
  'docxOutline',
  'pptxSlideText',
  'pptxNotesText',
  'pptxTextGrep',
  'pptxOutline',
  'xlsxListSheets',
  'xlsxHeadSheet',
  'xlsxRangeSheet',
  'xlsxQuerySheet',
]
// `getBashOutput`/`getWebOutput`/`getWebOutputRaw` (the existing, already-fenced bash/web/mcp
// recall paths) are deliberately NOT in the population above: those functions are also called
// internally for dedup/hashing/existence-checking, not only to emit third-party text to the
// model, so anchoring the population on them produces call sites this guard cannot tell apart
// from a real violation. Their fencing is proven instead by the dedicated behavioral regression
// tests for `bash-output`/`web-output`/`mcp-output` in tests/cli.test.ts and its neighbors
// (verification requirement #4), which assert the actual fenced output, not just that some
// function reaches the call.

/**
 * The bug shape this file previously could not see, expressed directly: a body that runs the scan
 * and then returns the content unfenced when the scan found nothing.
 *
 * The reachability check below asks whether a fence call is *present* somewhere downstream. It
 * cannot ask whether that call is on a branch an early return skips -- and every conditional site
 * contained the call, on the branch that runs only when the scan hits, so the guard was green on
 * all of them and could not have failed. That is not a missing test run; it is an oracle that
 * measures the wrong thing. Worse, `callsFence` accepts `_applyFiltersAndPrint(..., true, ...)` as
 * proof of fencing, and that helper's own emit closure was itself one of the conditional sites.
 *
 * So this predicate matches the shape rather than the reachability: a zero-length test on the scan
 * result guarding a `return`. `scanForInjectionPatterns` is the only way to produce that result,
 * so a body that never calls it is not in scope here.
 */
/**
 * Every way a body can run the injection scan. `scanAndRecord` is the shared wrapper in
 * src/untrusted_fence.ts; most callers use it rather than `scanForInjectionPatterns` directly.
 * Naming only the raw scanner here would silently narrow the zero-match check below to the two
 * modules that still call it -- which is how this guard measured the wrong thing the first time.
 */
const SCAN_CALLS: readonly string[] = ['scanForInjectionPatterns(', 'scanAndRecord(']

const ZERO_MATCH_BYPASS_RE =/\b\w*[Mm]atches\s*\.\s*length\s*===\s*0\s*\)\s*(?:\{\s*)?return\b/

/**
 * Bodies allowed to keep the conditional shape, each with a stated reason. This is an allowlist of
 * KNOWN EXCEPTIONS, not a list of things to check: an omission here fails the test rather than
 * silently skipping a site, which is the opposite of the hand-maintained-population failure mode
 * the header comment describes. Adding a name here is a deliberate act with a reason attached.
 */
const CONDITIONAL_FENCE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'fenceFileFieldIfMatched',
    'per-field fence for the --json envelopes: a fence around JSON is not JSON, and an ' +
      'unconditional ~125-byte wrapper per sheet name/slide title/heading costs more than the ' +
      'field. Resolving it needs a wire-format change (one sibling `untrusted` field).',
  ],
  [
    'fenceGithubFieldIfMatched',
    'same exception as fenceFileFieldIfMatched, for pr-slice --json.',
  ],
  [
    'fenceSnippetIfMatched',
    'same exception, for recall --json. The printed recall listing is fenced unconditionally as ' +
      'one block by fenceRecallListing.',
  ],
])

/**
 * Every way a body can reach the fence boundary. `fenceUntrusted`/`fenceWithMatches` (the shared
 * decision point in src/untrusted_fence.ts) and `fenceUntrustedOcrText` (OCR's own notice) all end
 * at `fenceUntrustedContent`, but they live in a different module than their callers, so the
 * per-file call graph below cannot walk into them -- they have to be named here as terminals or a
 * correctly-fenced caller reads as a violation.
 */
const FENCE_TERMINALS: readonly string[] = [
  'fenceUntrustedContent(',
  'fenceUntrusted(',
  'fenceWithMatches(',
  'fenceUntrustedOcrText(',
]

/** True when `body` reaches the fence boundary itself. */
function callsFence(body: string): boolean {
  if (FENCE_TERMINALS.some((terminal) => body.includes(terminal))) return true
  // cli.ts's shared boundary: `_applyFiltersAndPrint(text, opts, true, ...)` runs the scan and
  // fence internally when its third argument (`fenceByProvenance`) is `true`.
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
const SOURCE_MODULE_FILES: ReadonlySet<string> = new Set([
  'pr_slice.ts',
  'gdrive.ts',
  'recall_index.ts',
  // Same reasoning for the document extractors: they return text to a caller and never print.
  'pdf_extract.ts',
  'docx_extract.ts',
  'pptx_extract.ts',
  'xlsx_extract.ts',
  'ooxml_extract.ts',
  // Extracts document text for the embedding index (parser.ts::indexFileEmbeddings) and returns
  // it to that indexer; it never prints. Residual, named rather than left implicit: text indexed
  // this way can later reach the model through `semantic`, whose output is not fenced today. That
  // is a separate surface with a separate cost question -- `semantic` returns mostly the user's
  // own source -- and fencing it is not in scope for this guard, which follows what a command
  // PRINTS. Tracked so the next reader does not have to re-derive it from a green test.
  'doc_embed_extract.ts',
])

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

  it('has no fence that a zero-match early return can skip', () => {
    const offenders: string[] = []
    for (const file of srcFiles()) {
      const src = fs.readFileSync(file, 'utf8')
      if (!SCAN_CALLS.some((call) => src.includes(call))) continue
      for (const fn of parseTopLevelFunctions(src)) {
        if (!SCAN_CALLS.some((call) => fn.body.includes(call))) continue
        if (!ZERO_MATCH_BYPASS_RE.test(fn.body)) continue
        if (CONDITIONAL_FENCE_EXCEPTIONS.has(fn.name)) continue
        offenders.push(`${path.relative(SRC_DIR, file)}::${fn.name}`)
      }
    }
    expect(
      offenders,
      'these functions scan for injection patterns and then return the content UNFENCED when the ' +
        'scan found nothing, which gates a fence on a heuristic hit -- the shape CLAUDE.arch.md\'s ' +
        'Security Boundaries prohibits, because a payload the eight deliberately-narrow patterns ' +
        'miss then costs the whole protection rather than just the label. Fence on provenance and ' +
        'let the scan decide only what the notice says. If a site genuinely needs the conditional ' +
        'shape, add it to CONDITIONAL_FENCE_EXCEPTIONS with the reason: ' +
        offenders.join(', '),
    ).toEqual([])
  })

  // Guards the guard: an exception that no longer matches any real body is dead weight that makes
  // the allowlist look more load-bearing than it is, and hides that a site was fixed or renamed.
  it('has no stale entry in the conditional-fence exception list', () => {
    const bodies = new Map<string, string>()
    for (const file of srcFiles()) {
      for (const fn of parseTopLevelFunctions(fs.readFileSync(file, 'utf8'))) bodies.set(fn.name, fn.body)
    }
    const stale = [...CONDITIONAL_FENCE_EXCEPTIONS.keys()].filter((name) => {
      const body = bodies.get(name)
      return body === undefined || !ZERO_MATCH_BYPASS_RE.test(body)
    })
    expect(
      stale,
      `these CONDITIONAL_FENCE_EXCEPTIONS entries no longer name a function with the conditional ` +
        `shape -- remove them so the allowlist keeps meaning what it says: ${stale.join(', ')}`,
    ).toEqual([])
  })

  // Guards the guard, for the zero-match check specifically. That check selects the functions it
  // examines by scan-call NAME, so its population has a second failure mode beyond a wrong oracle:
  // it can silently empty. This is not hypothetical -- it happened here. The gate read
  // `scanForInjectionPatterns(` only, and centralizing the fence into untrusted_fence.ts meant no
  // cli.ts function calls that name any more, so the check applied to zero functions and stayed
  // green while a deliberately re-broken fenceFileText shipped the exact defect it exists to catch.
  // Nothing errored and the pass count did not move. Requiring every name to have a live call site
  // pins the set the same way the sibling check below does, so a rename fails here by name instead
  // of quietly shrinking the population to nothing.
  it('actually examines the known conditional sites, so a renamed scan call cannot narrow it away', () => {
    // Selected by exactly the same two gates the zero-match check uses, so this measures that
    // check's real population rather than a restatement of the source tree.
    const examined = new Set(
      srcFiles().flatMap((file) => {
        const src = fs.readFileSync(file, 'utf8')
        if (!SCAN_CALLS.some((call) => src.includes(call))) return []
        return parseTopLevelFunctions(src)
          .filter((fn) => SCAN_CALLS.some((call) => fn.body.includes(call)))
          .map((fn) => fn.name)
      }),
    )

    expect(
      examined.size,
      'the zero-match bypass check examined no functions at all, so it can only ever pass -- ' +
        'the scan call it selects on has been renamed, or src/ parsing returned nothing',
    ).toBeGreaterThan(0)

    // The allowlisted exceptions are the one set known to have the conditional shape on purpose,
    // which makes them the sharpest available probe: if any of them stops being visible to the
    // gates above, the gates narrowed, and every site that is NOT allowlisted narrowed out with
    // them -- silently, since a smaller population produces fewer violations, never an error.
    const invisible = [...CONDITIONAL_FENCE_EXCEPTIONS.keys()].filter((name) => !examined.has(name))
    expect(
      invisible,
      `these CONDITIONAL_FENCE_EXCEPTIONS functions are no longer visible to the zero-match bypass ` +
        `check's own selection, so that check has quietly narrowed and would pass on sites it used ` +
        `to catch -- add the scan call they now use to SCAN_CALLS: ${invisible.join(', ')}`,
    ).toEqual([])
  })

  // Guards the guard: if source-tree parsing ever silently returned nothing (a moved src/
  // directory, a broken glob), the check above would pass vacuously.
  it('actually finds a call site in src/ for every named third-party content source', () => {
    // Counted by CALL SITE, not by definition: several entries are imported under a local alias
    // (`headSheet as xlsxHeadSheet`), so no function in src/ is *defined* under that name, and a
    // definition-counting check would have to be loosened to a floor -- which is exactly the
    // aggregate-floor shape that hides the loss of an individual entry. Requiring every single
    // name to appear at a call site pins the set instead: an entry that stops being called (a
    // command deleted, an import renamed) fails here by name rather than shrinking a total.
    const allSrc = srcFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    const missing = THIRD_PARTY_SOURCE_CALLS.filter((call) => !new RegExp(`\\b${call}\\s*\\(`).test(allSrc))
    expect(
      missing,
      `these THIRD_PARTY_SOURCE_CALLS entries are never called anywhere in src/, so they guard ` +
        `nothing -- either the name is stale (renamed/removed) or the import alias changed: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
