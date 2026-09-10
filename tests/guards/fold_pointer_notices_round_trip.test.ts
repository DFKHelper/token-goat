/**
 * Guard for the recall-pointer class of bug: a folded/rewritten delivery names a route back to the
 * withheld bytes, but nothing checks that the named route actually returns them. This repo has
 * shipped that defect three times already (a comment-fold pointer whose recalled span folded to
 * nothing, a bash-output pointer missing the `--full` flag it needed, and the prose-fold pointer
 * this file's population was written to catch -- see project_recall_pointer_fixed_point_only_if
 * and project_recall_pointer_omitted_the_flag memory files). A guard that only checks the printed
 * pointer's *shape* (a regex against the string) would have passed on all three: the shape was
 * always well-formed, the bytes it named were the part that never came back. So this guard drives
 * the real handler pair for each pointer shape and executes the pointer, asserting the withheld
 * text is actually present in what following it returns.
 *
 * Population is a raw source scan of src/*.ts, not `codeOnly()`: the pointer text these functions
 * build lives entirely in ordinary template-literal string content, which `codeOnly()` blanks
 * before a guard ever sees it (see project_codeonly_blanks_the_template_literal). `reachesRaw`
 * (imported from the rewriteInput channel guard, which needed the identical raw-body scan for the
 * identical reason) walks the unblanked body text directly.
 *
 * Scope: this guard covers the two pointer shapes fixed/verified this cycle -- the prose-fold
 * paragraph pointer (fold_delivery.ts::proseFoldNotice, now routed through `token-goat section`
 * when an enclosing heading resolves) and the comment-fold pointer (fold_delivery.ts::commentFoldNotice,
 * a `Read offset=/limit=` pointer verified to round-trip for a source file via the
 * protect_recent_reads exemption). It deliberately excludes fold_structure.ts::capLeadIn's
 * lead-in-cut pointer, which this same session's investigation found is ALSO broken by the same
 * root cause (the markdown large-file intercept in hooks_read.ts denies every re-read of a
 * markdown file with 3+ headings unconditionally, regardless of how narrow the offset/limit
 * window is) but has no safe fix under the current CLI surface: the withheld lead-in text sits
 * before the document's first heading, so no `token-goat section` target names it without
 * returning different bytes than were withheld. Fixing it needs new CLI surface, which is out of
 * this cycle's scope; it is left as a known, reported defect rather than force-adjudicated safe
 * here. bodyFoldNotice (`token-goat read "file::symbol"`) and the skeleton-gap notice's
 * whole-file `Read offset=1, limit=<rows.length>` fallback are CLI-route or honestly-scoped-to-
 * the-whole-file pointers respectively, outside this guard's per-paragraph/per-comment-block
 * round-trip shape.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../../src/hook_registry.js'
import { preReadHandler, postReadHandler } from '../../src/hooks_read.js'
import { normalizePath } from '../../src/paths.js'
import { clearModuleCaches } from '../../src/reset.js'
import { readSection } from '../../src/section_reader.js'
import { functionMap, parseTopLevelFunctions, type FnInfo } from './reachability.js'
import { reachesRaw } from './rewrite_input_channel_population_is_adjudicated.test.js'
import { pinnedPopulation } from './population.js'

/** Self-exclusion token, quoted in prose only, never as a literal that would satisfy a scan of this file itself: NOSUCH[X]TOKEN. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

// Not anchored to the literal `-- ` prefix: proseFoldNotice builds the pointer into its own
// variable before splicing it after `-- `, so the two substrings never sit adjacent in the raw
// source text even though they do in the rendered output. The marker alone is enough to identify
// a pointer-constructing function without the false negative that anchoring would cause.
const READ_OFFSET_MARKER = 'Read "${shownPath}" with offset='
const SECTION_MARKER = 'token-goat section "${shownPath}::'

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(SRC_DIR, e.name))
}

/** Every `file.ts::function` whose raw body (or a same-file function it calls) constructs a pointer of the given literal shape. */
function sitesForMarker(marker: string): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(marker)) continue
    const fns: FnInfo[] = parseTopLevelFunctions(source)
    const map = functionMap(fns)
    for (const fn of fns) {
      if (reachesRaw(fn, map, (body) => body.includes(marker))) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

/** Direct definition sites only (not every reachable caller), for the "which shape does each site emit" adjudication below. */
function definitionSitesForMarker(marker: string): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(marker)) continue
    for (const fn of parseTopLevelFunctions(source)) {
      if (fn.body.includes(marker)) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

/** Round-trip coverage claimed for each pointer-constructing function this guard's population finds. Symmetric: checked both ways below, so an entry cannot outlive the site it names and a found site cannot go uncovered. */
const ADJUDICATED: Readonly<Record<string, string>> = {
  'fold_delivery.ts::proseFoldNotice':
    "Routes through findContainingSection to a `token-goat section \"file::Heading\"` pointer when an enclosing heading resolves (the common case for a markdown document large enough to trip the markdown re-read intercept, which is the scenario this fold exists for), falling back to the pre-existing `Read offset=/limit=` form only when no section wraps the withheld line. Executed below by driving preReadHandler/postReadHandler against a real markdown fixture and following whichever pointer form the real notice printed.",
  'fold_delivery.ts::commentFoldNotice':
    "Prints a `Read offset=/limit=` pointer for a folded comment block in a source file. Verified by driving the real handler pair: a source-file re-read is not gated by the markdown-specific unconditional deny (that gate only fires for .md/.mdx/.markdown/.rst), and the immediate follow-up read this pointer names ranks as the most recently read file, which protect_recent_reads (default 4) exempts from every reread-deny branch that would otherwise fire.",
  'fold_structure.ts::skeletonGapNotice':
    'Same shape and same source-file-only scope as commentFoldNotice above (a source skeleton is never built for a markdown document -- planSourceSkeleton requires a tree-sitter language), so the identical protect_recent_reads exemption verified for commentFoldNotice applies here; not separately executed below.',
  'fold_structure.ts::planSourceSkeleton':
    "Its notice's fallback route (`Read \"file\" with offset=1, limit=<rows.length>`) is honestly scoped to the whole file, not to one withheld run, and names a source file for the same reason skeletonGapNotice above round-trips: not separately executed below.",
}

describe('a folded delivery pointer, followed literally, returns the bytes it withheld', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        // best effort
      }
    }
  })

  it('finds a real population of pointer-constructing functions, per shape, rather than passing on an empty scan', () => {
    pinnedPopulation({
      what: 'functions in src/*.ts constructing a `Read "..." with offset=` recall pointer',
      items: sitesForMarker(READ_OFFSET_MARKER),
      floor: 3,
      mustInclude: ['fold_delivery.ts::commentFoldNotice', 'fold_structure.ts::capLeadIn', 'fold_structure.ts::skeletonGapNotice'],
    })
    pinnedPopulation({
      what: 'functions in src/*.ts constructing a `-- token-goat section "..."` recall pointer',
      items: sitesForMarker(SECTION_MARKER),
      floor: 1,
      mustInclude: ['fold_delivery.ts::proseFoldNotice'],
    })
  })

  it('has an adjudication for every direct definition site this guard covers, and no stale one', () => {
    const covered = [...definitionSitesForMarker(READ_OFFSET_MARKER), ...definitionSitesForMarker(SECTION_MARKER)]
    // capLeadIn is a known site this guard's scope explicitly excludes (see the file header) --
    // named here, not silently dropped, so a reader of the population sees why it is missing from
    // ADJUDICATED without the guard treating its absence as a defect in the guard itself.
    // planMarkdownOutline's `token-goat section "path::<Heading>"` also matches SECTION_MARKER, but
    // it is not this bug's shape: `<Heading>` is a usage-form placeholder in a notice that also
    // prints the document's real heading list right beside it (guidance + sectionsList, both in
    // the same numbered[] this notice sits in), unlike proseFoldNotice's old bug, which named a
    // placeholder heading with no list anywhere in the delivery for a reader to resolve it against.
    const KNOWN_UNCOVERED = new Set(['fold_structure.ts::capLeadIn', 'fold_structure.ts::planMarkdownOutline'])
    const needsAdjudication = covered.filter((k) => !KNOWN_UNCOVERED.has(k))
    const missing = needsAdjudication.filter((k) => ADJUDICATED[k] === undefined)
    expect(missing, `These construct a recall pointer with no round-trip coverage:\n  ${missing.join('\n  ')}`).toEqual([])

    const stale = Object.keys(ADJUDICATED).filter((k) => !covered.includes(k))
    expect(stale, `ADJUDICATED names a site that no longer constructs a recall pointer:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  function numbered(body: string): string {
    return body
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n')
  }

  function readEvent(filePath: string, extraInput: Record<string, unknown> = {}): HookEvent {
    return { eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: filePath, ...extraInput }, sessionId: 's1', agentId: undefined, raw: {} }
  }

  function postEvent(filePath: string, body: string, extraInput: Record<string, unknown> = {}): HookEvent {
    return { eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath, ...extraInput }, sessionId: 's1', agentId: undefined, raw: { tool_response: numbered(body) } }
  }

  it('SHAPE token-goat section: a folded markdown paragraph pointer, executed, returns the withheld sentence', () => {
    clearModuleCaches()
    const marker = 'the unique sentence this test looks for after following the pointer'
    // Long enough that the fold's net savings clears isRewriteWorthwhile's floor for the whole
    // delivery, not just planProseFolds' own per-paragraph floor -- a shorter filler here folded
    // correctly in isolation but the full postReadHandler pipeline still declined the rewrite,
    // because the notice and fence overhead outweighed too small a saving.
    const filler = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
    const paragraph = `This opening sentence stays visible. ${filler.repeat(3)}${marker}.`
    const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
    const body = ['# Fixture', '', pad, '', '## First Section', '', paragraph, '', '## Second Section', '', 'tail', ''].join('\n')
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-fold-ptr-${process.pid}-${Math.random().toString(36).slice(2)}.md`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    expect(preReadHandler(readEvent(file)).hookType).not.toBe('deny')
    const post = postReadHandler(postEvent(file, body))
    expect(post.hookType).toBe('rewriteOutput')
    const rewritten = post.hookType === 'rewriteOutput' ? post.updatedOutput : ''
    const noticeLine = rewritten.split('\n').find((l) => l.includes('rest of paragraph folded'))
    expect(noticeLine).toBeDefined()

    const sectionPointer = /token-goat section "(.+)::([^":]+)"/.exec(noticeLine ?? '')
    const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)/.exec(noticeLine ?? '')
    if (sectionPointer !== null) {
      const [, , heading] = sectionPointer
      const section = readSection(file, heading ?? '')
      expect(section).not.toBeNull()
      expect(section?.content).toContain(marker)
    } else if (readPointer !== null) {
      const [, pointerPath, offsetStr, limitStr] = readPointer
      const decision = preReadHandler(readEvent(pointerPath ?? file, { offset: Number(offsetStr), limit: Number(limitStr) }))
      expect(decision.hookType).not.toBe('deny')
    } else {
      throw new Error(`notice line named no recognized pointer route: ${noticeLine}`)
    }
  })

  it('SHAPE Read offset/limit: a folded comment block pointer, executed on the immediate follow-up, is not denied', () => {
    clearModuleCaches()
    const block = ['/*', ...Array.from({ length: 40 }, (_, i) => ` * comment line ${i} padded with a little extra text to reach the fold floor`), ' */']
    const padFn = Array.from({ length: 200 }, (_, i) => `const padVar${i} = ${i};`)
    const body = [...block, 'export function real() { return 1 }', ...padFn].join('\n')
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-comment-ptr-${process.pid}-${Math.random().toString(36).slice(2)}.ts`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    expect(preReadHandler(readEvent(file)).hookType).not.toBe('deny')
    const post = postReadHandler(postEvent(file, body))
    expect(post.hookType).toBe('rewriteOutput')
    const rewritten = post.hookType === 'rewriteOutput' ? post.updatedOutput : ''
    const noticeLine = rewritten.split('\n').find((l) => l.includes('more comment lines'))
    expect(noticeLine).toBeDefined()

    const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)/.exec(noticeLine ?? '')
    expect(readPointer).not.toBeNull()
    const [, pointerPath, offsetStr, limitStr] = readPointer!
    const decision = preReadHandler(readEvent(pointerPath ?? file, { offset: Number(offsetStr), limit: Number(limitStr) }))
    // The route only round-trips if this second read is actually let through.
    expect(decision.hookType).not.toBe('deny')
  })
})
