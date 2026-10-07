/** Guard for the recall-pointer class of bug: a folded/rewritten delivery names a route back to the withheld bytes, but nothing checks that the named route actually returns them. This repo has shipped that defect three times already (a comment-fold pointer whose recalled span folded to nothing, a bash-output pointer missing the `--full` flag it needed, and the prose-fold pointer this file's population was written to catch -- see project_recall_pointer_fixed_point_only_if and project_recall_pointer_omitted_the_flag memory files). A guard that only checks the printed pointer's *shape* (a regex against the string) would have passed on all three: the shape was always well-formed, the bytes it named were the part that never came back. So this guard drives the real handler pair for each pointer shape and executes the pointer, asserting the withheld text is actually present in what following it returns. Population is a raw source scan of src/*.ts, not `codeOnly()`: the pointer text these functions build lives entirely in ordinary template-literal string content, which `codeOnly()` blanks before a guard ever sees it (see project_codeonly_blanks_the_template_literal). `reachesRaw` (imported from the rewriteInput channel guard, which needed the identical raw-body scan for the identical reason) walks the unblanked body text directly. Scope: this guard covers the two pointer shapes fixed/verified this cycle -- the prose-fold paragraph pointer (fold_delivery.ts::proseFoldNotice, routed through `token-goat section` when an enclosing heading resolves, and folding NOTHING at all when it does not, rather than naming a `Read offset=/limit=` fallback the markdown large-file intercept in hooks_read.ts could refuse unconditionally) and the comment-fold pointer (fold_delivery.ts::commentFoldNotice, a `Read offset=/limit=` pointer verified to round-trip for a source file via the protect_recent_reads exemption). fold_structure.ts::capLeadIn's former lead-in-cut pointer had the identical root cause and no safe fix under the current CLI surface (the withheld lead-in text sits before the document's first heading, so no `token-goat section` target names it), so it no longer cuts or names a pointer at all: the full lead-in is delivered uncapped, and the whole-replacement ratio floor in isStructuralRewriteAccepted is what rejects an oversized one. bodyFoldNotice (`token-goat read "file::symbol"`) and the skeleton-gap notice's whole-file `Read offset=1, limit=<rows.length>` fallback are CLI-route or honestly-scoped-to-the-whole-file pointers respectively, outside this guard's per-paragraph/per-comment-block round-trip shape. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../../src/hook_registry.js'
import { preBashHandler } from '../../src/hooks_bash.js'
import { postBashHandler } from '../../src/hooks_bash_post.js'
import { preReadHandler } from '../../src/hooks_read.js'
import { postReadHandler } from '../../src/hooks_read_post.js'
import { normalizePath } from '../../src/paths.js'
import { clearModuleCaches } from '../../src/reset.js'
import { readSection } from '../../src/section_reader.js'
import { loadSessionState, saveSessionState } from '../../src/session_store.js'
import type { HookOutput } from '../../src/types.js'
import { functionMap, parseTopLevelFunctions, type FnInfo } from './reachability.js'
import { reachesRaw } from './rewrite_input_channel_population_is_adjudicated.test.js'
import { pinnedPopulation } from './population.js'

/** Self-exclusion token, quoted in prose only, never as a literal that would satisfy a scan of this file itself: NOSUCH[X]TOKEN. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

// Not anchored to the literal `-- ` prefix: proseFoldNotice builds the pointer into its own variable before splicing it after `-- `, so the two substrings never sit adjacent in the raw source text even though they do in the rendered output. The marker alone is enough to identify a pointer-constructing function without the false negative that anchoring would cause.
// The Read pointer is for the harness Read tool, which takes the path literally and runs no shell, so the path sits in plain double quotes with displaySafeText inside; quotedArg is shell quoting and turns a path holding `$` and an apostrophe into a placeholder.
const READ_OFFSET_MARKER = ['Read "${displaySafeText(shownPath)}" with offset=']
// A pointer whose heading comes from the document goes through quotedArg (src/hint_suggestion_guard.ts), which single-quotes a heading holding `$`; one with a fixed placeholder keeps its literal double quotes.
const SECTION_MARKER = ['token-goat section "${shownPath}::', 'token-goat section ${quotedArg(`${shownPath}::']

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(SRC_DIR, e.name))
}

/** Every `file.ts::function` whose raw body (or a same-file function it calls) constructs a pointer of the given literal shape. */
function sitesForMarker(markers: readonly string[]): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!markers.some((m) => source.includes(m))) continue
    const fns: FnInfo[] = parseTopLevelFunctions(source)
    const map = functionMap(fns)
    for (const fn of fns) {
      if (reachesRaw(fn, map, (body) => markers.some((m) => body.includes(m)))) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

/** Direct definition sites only (not every reachable caller), for the "which shape does each site emit" adjudication below. */
function definitionSitesForMarker(markers: readonly string[]): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!markers.some((m) => source.includes(m))) continue
    for (const fn of parseTopLevelFunctions(source)) {
      if (markers.some((m) => fn.body.includes(m))) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

/** Round-trip coverage claimed for each pointer-constructing function this guard's population finds. Symmetric: checked both ways below, so an entry cannot outlive the site it names and a found site cannot go uncovered. */
const ADJUDICATED: Readonly<Record<string, string>> = {
  'fold_delivery.ts::proseFoldNotice':
    "Routes through findContainingSection to a `token-goat section \"file::Heading\"` pointer when an enclosing heading resolves (the common case for a markdown document large enough to trip the markdown re-read intercept, which is the scenario this fold exists for), and returns null (the caller must not fold, and delivers the paragraph whole) when no section wraps the withheld line, rather than naming the old `Read offset=/limit=` fallback that named a re-read the same intercept could refuse unconditionally. Both outcomes executed below by driving preReadHandler/postReadHandler against real markdown fixtures.",
  'fold_delivery.ts::commentFoldNotice':
    "Prints a `Read offset=/limit=` pointer for a folded comment block in a source file. Verified by driving the real handler pair: a source-file re-read is not gated by the markdown-specific unconditional deny (that gate only fires for .md/.mdx/.markdown/.rst), and the immediate follow-up read this pointer names ranks as the most recently read file, which protect_recent_reads (default 4) exempts from the count-based reread denies. The range re-read deny takes no such exemption, so a fold from a ranged delivery also has to take back the line range that delivery went on record under: hooks_read_post.ts::forgetFoldedWindow for a ranged Read, and the reset in hooks_bash_post.ts::maybeCollapseIdenticalRead for a `sed` or `head` read. Both doors executed below, each hook call loading and saving session state as relay.ts does.",
  'fold_structure.ts::skeletonGapNotice':
    'Same shape and same source-file-only scope as commentFoldNotice above (a source skeleton is never built for a markdown document -- planSourceSkeleton requires a tree-sitter language), so the identical protect_recent_reads exemption verified for commentFoldNotice applies here; not separately executed below.',
  'fold_structure.ts::planOutlineAlignedRows':
    "Prints a `token-goat section \"file::Heading\"` pointer for each run of a markdown outline laid over a harness-numbered Read, naming the section findContainingSection resolves the run to -- the same resolver `token-goat section` itself uses to answer a plain spec, so an unlisted H4 or a case-differing heading sharing text with a listed one gets the ordinal resolveHeaderPos would actually assign rather than a count kept locally over the capped, case-sensitive heading list -- and delivering the run whole whenever no section resolves or its heading cannot be named, never a ranged-Read fallback, which the markdown intercept refuses on a file already read in full. Executed in tests/read_rewrite_line_numbers.test.ts ('markdown outline: every pointer, followed literally after the read it came from, returns the lines it withheld'): every pointer is followed with readSection, or with preReadHandler if it names a Read, and must return every withheld line.",
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
      mustInclude: ['fold_delivery.ts::commentFoldNotice', 'fold_structure.ts::skeletonGapNotice'],
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
    // capLeadIn no longer constructs any pointer at all (it delivers the full lead-in uncapped instead of cutting it), so it no longer appears in `covered` and needs no entry here. planMarkdownOutline's `token-goat section "path::<Heading>"` also matches SECTION_MARKER, but it is not this bug's shape: `<Heading>` is a usage-form placeholder in a notice that also prints the document's real heading list right beside it (guidance + sectionsList, both in the same numbered[] this notice sits in), unlike proseFoldNotice's old bug, which named a placeholder heading with no list anywhere in the delivery for a reader to resolve it against.
    const KNOWN_UNCOVERED = new Set(['fold_structure.ts::planMarkdownOutline'])
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
    // Long enough that the fold's net savings clears isRewriteWorthwhile's floor for the whole delivery, not just planProseFolds' own per-paragraph floor -- a shorter filler here folded correctly in isolation but the full postReadHandler pipeline still declined the rewrite, because the notice and fence overhead outweighed too small a saving.
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

  /** A ranged Read as Claude Code delivers it. Fixture provenance: CAPTURE, the envelope tests/code_fold.test.ts's `rangedEvent` documents from 798 ranged Read results in real session transcripts: `file.content` holds only the window, un-numbered, `startLine` is the requested offset, and `totalLines` still describes the whole file. */
  function rangedPostEvent(filePath: string, body: string, offset: number, limit: number, sessionId: string): HookEvent {
    const all = body.split('\n')
    const window = all.slice(offset - 1, offset - 1 + limit)
    return { eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset, limit }, sessionId, agentId: undefined, raw: { tool_response: { type: 'text', file: { filePath, content: window.join('\n'), numLines: window.length, startLine: offset, totalLines: all.length } } } }
  }

  // The windowed twin of the case above, which a whole-file first read cannot reach: a ranged Read's window is recorded as served before the post hook folds anything, and the range re-read deny trusts that record without the protect_recent_reads exemption, so the pointer's own Read was refused as "Lines 3..30 ... was already read this session" for lines the model was never shown. CAPTURE of the defect: a Claude Code Read of tests/install_hook_matcher.test.ts at offset=1, limit=32 on 2026-09-27 folded "28 more comment lines (3-30)", and the Read that notice named was refused with exactly that message. The fixture below is HAND-DERIVED to the same shape: a leading 30-row doc block inside a 40-line window.
  it('SHAPE Read offset/limit, windowed first read: the pointer is not refused as lines already read', () => {
    clearModuleCaches()
    const block = ['/**', ...Array.from({ length: 28 }, (_, i) => ` * comment line ${i} padded with a little extra text to reach the fold floor`), ' */']
    const code = Array.from({ length: 40 }, (_, i) => `export const padVar${i} = ${i}`)
    const body = [...block, ...code].join('\n')
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-comment-ptr-window-${process.pid}-${Math.random().toString(36).slice(2)}.ts`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    const sid = `s-window-${process.pid}-${Math.random().toString(36).slice(2)}`
    // Each hook call is its own load, handle and save, as relay.ts runs it, so the range the pre hook records is on disk before the post hook runs and has to be taken back through session_store.ts's merge rather than only out of this process's memory.
    const asHook = <T>(handle: () => T): T => {
      loadSessionState(sid)
      try {
        return handle()
      } finally {
        saveSessionState(sid)
      }
    }
    const pre = (offset: number, limit: number): HookOutput => asHook(() => preReadHandler({ ...readEvent(file, { offset, limit }), sessionId: sid }))

    expect(pre(1, 40).hookType).not.toBe('deny')
    const post = asHook(() => postReadHandler(rangedPostEvent(file, body, 1, 40, sid)))
    expect(post.hookType).toBe('rewriteOutput')
    const rewritten = post.hookType === 'rewriteOutput' ? post.updatedOutput : ''
    const noticeLine = rewritten.split('\n').find((l) => l.includes('more comment lines'))
    expect(noticeLine).toBeDefined()

    const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)/.exec(noticeLine ?? '')
    expect(readPointer).not.toBeNull()
    const [, pointerPath, offsetStr, limitStr] = readPointer!
    expect(pointerPath).toBe(file)
    // The span the notice names is the one the block occupies below its two kept rows, so a pointer that drifted off it cannot pass by pointing somewhere the range record never covered.
    expect([Number(offsetStr), Number(limitStr)]).toEqual([3, 28])
    const decision = pre(3, 28)
    expect(decision.hookType === 'deny' ? decision.message : '').toBe('')

    // Positive control: the recall delivers its window whole, so that window is on record as served and a repeat of it is still refused. Without this, a fix that simply stopped recording ranges would pass the assertion above.
    const recalled = asHook(() => postReadHandler(rangedPostEvent(file, body, 3, 28, sid)))
    expect(recalled.hookType === 'rewriteOutput' ? recalled.updatedOutput : '').not.toContain('more comment lines')
    expect(pre(3, 28).hookType).toBe('deny')
  })

  // The shell door's twin: the pre-Bash hook records a `sed -n` range as served before the command runs, the post-Bash hook records a `head` read as lines 1..n before it picks a rewrite, and either way it then folds the same comment run through the same foldDelivery, printing the same `Read offset/limit` pointer. Once the file has been through Read at all, which is what sends the pre-read hook into its re-read checks, that pointer met the same refusal. The fixture is HAND-DERIVED, the same shape as the case above; the earlier Read is a code-only window the planner has nothing to fold in. The Bash response is the `{ stdout, stderr, interrupted, isImage, noOutputExpected }` shape tests/hooks_real_harness_payload_shape.test.ts records from real harness traffic.
  it.each([
    ['sed range', (base: string): string => `sed -n '1,40p' ${base}`],
    ['head', (base: string): string => `head -n 40 ${base}`],
  ])('SHAPE Read offset/limit, after a folded %s read: the pointer is not refused as lines already read', async (_shape, commandFor) => {
    clearModuleCaches()
    const block = ['/**', ...Array.from({ length: 28 }, (_, i) => ` * comment line ${i} padded with a little extra text to reach the fold floor`), ' */']
    const code = Array.from({ length: 40 }, (_, i) => `export const padVar${i} = ${i}`)
    const lines = [...block, ...code]
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-comment-ptr-shell-${process.pid}-${Math.random().toString(36).slice(2)}.ts`))
    fs.writeFileSync(file, lines.join('\n'))
    tmpFiles.push(file)
    const dir = path.dirname(file)
    const command = commandFor(path.basename(file))

    const sid = `s-sed-${process.pid}-${Math.random().toString(36).slice(2)}`
    // One load, handle and save per hook call, as relay.ts runs it; see the windowed Read case above for why.
    const asHook = async <T>(handle: () => T | Promise<T>): Promise<T> => {
      loadSessionState(sid)
      try {
        return await handle()
      } finally {
        saveSessionState(sid)
      }
    }
    const bashEvent = (eventName: 'pre_tool_use' | 'post_tool_use', raw: Record<string, unknown>): HookEvent => ({ eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw: { cwd: dir, tool_name: 'Bash', tool_input: { command }, ...raw } })

    expect((await asHook(() => preReadHandler({ ...readEvent(file, { offset: 50, limit: 15 }), sessionId: sid }))).hookType).not.toBe('deny')
    await asHook(() => postReadHandler(rangedPostEvent(file, lines.join('\n'), 50, 15, sid)))
    expect((await asHook(() => preBashHandler(bashEvent('pre_tool_use', {})))).hookType).not.toBe('deny')
    const stdout = lines.slice(0, 40).join('\n')
    const post = await asHook(() => postBashHandler(bashEvent('post_tool_use', { tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })))
    expect(post.hookType).toBe('rewriteOutput')
    const noticeLine = (post.hookType === 'rewriteOutput' ? post.updatedOutput : '').split('\n').find((l) => l.includes('more comment lines'))
    expect(noticeLine).toBeDefined()

    const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)/.exec(noticeLine ?? '')
    expect(readPointer).not.toBeNull()
    const [, pointerPath, offsetStr, limitStr] = readPointer!
    expect([Number(offsetStr), Number(limitStr)]).toEqual([3, 28])
    const decision = await asHook(() => preReadHandler({ ...readEvent(pointerPath ?? file, { offset: Number(offsetStr), limit: Number(limitStr) }), sessionId: sid }))
    expect(decision.hookType === 'deny' ? decision.message : '').toBe('')
  })

  it('SHAPE no pointer: a paragraph before the first heading is delivered whole, not folded behind a dead pointer', () => {
    clearModuleCaches()
    const marker = 'the unique sentence proving an unsectioned lead-in paragraph now survives whole'
    const filler = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold would otherwise remove from the delivered output. '
    const paragraph = `This opening sentence stays visible. ${filler.repeat(3)}${marker}.`
    // Sits on the very first line, before any heading, so findContainingSection has nothing to resolve -- the case this fix targets.
    const body = [paragraph, '', '## Only Section', '', 'tail content after the only heading.', ''].join('\n')
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-lead-in-para-${process.pid}-${Math.random().toString(36).slice(2)}.md`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    expect(preReadHandler(readEvent(file)).hookType).not.toBe('deny')
    const post = postReadHandler(postEvent(file, body))
    const delivered = post.hookType === 'rewriteOutput' ? post.updatedOutput : numbered(body)
    expect(delivered).not.toMatch(/rest of paragraph folded/)
    expect(delivered).toContain(marker)
  })

  it('SHAPE no pointer: an oversized markdown lead-in is delivered uncapped, not cut behind a dead pointer', () => {
    clearModuleCaches()
    const leadInLines = Array.from({ length: 55 }, (_, i) => `Lead-in filler line ${i} padded to add bulk to this introduction before the first heading.`)
    const marker = 'MARKER_LEADIN_TAIL sits at the very end of the lead-in, past where the old byte cap used to cut it.'
    const sectionBody = 'Section body text repeated to carry this document past the byte floor the heading tree requires before it will replace anything. '.repeat(12)
    const headings = ['Introduction', 'Installation', 'Configuration', 'Commands', 'Troubleshooting', 'Contributing', 'Licence']
    const body = ['# Fixture Title', '', ...leadInLines, marker, '', ...headings.map((h) => `## ${h}\n\n${sectionBody}\n`)].join('\n')

    // Comfortably past OUTLINE_LEADIN_MAX_BYTES (4,225) -- the cap this used to trip -- and past the outline replacement's own 8,000 B / 6-heading floors, which together are the gate this case exists to reach.
    expect(Buffer.byteLength([...leadInLines, marker].join('\n'), 'utf-8')).toBeGreaterThan(4_225)
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8_000)

    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-leadin-cap-${process.pid}-${Math.random().toString(36).slice(2)}.md`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    expect(preReadHandler(readEvent(file)).hookType).not.toBe('deny')
    const post = postReadHandler(postEvent(file, body))
    expect(post.hookType).toBe('rewriteOutput')
    const rewritten = post.hookType === 'rewriteOutput' ? post.updatedOutput : ''
    // Must-not-drop: the marker sits well past the old cap, so finding it proves the lead-in survived uncapped.
    expect(rewritten).toContain(marker)
    expect(rewritten).not.toMatch(/lead-in line.*cut at the/)
  })

  it('SHAPE token-goat section, duplicate heading text: the pointer resolves to the occurrence that actually contains the withheld line, not the first one sharing its heading text', () => {
    clearModuleCaches()
    const marker = 'the unique sentence living only in the second Fixed section of this duplicate-heading document'
    const filler = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
    const paragraph = `This opening sentence stays visible. ${filler.repeat(3)}${marker}.`
    const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
    const firstOccurrenceBody = 'first-occurrence tail text, distinct from the withheld paragraph and never the intended recall target.'
    // Two headings sharing the exact same text, exactly the shape resolveHeaderPos disambiguates by ordinal but findContainingSection's plain `header.heading` pointer does not carry.
    const body = [
      '# Fixture',
      '',
      pad,
      '',
      '## Fixed',
      '',
      firstOccurrenceBody,
      '',
      '## Unrelated',
      '',
      'unrelated tail',
      '',
      '## Fixed',
      '',
      paragraph,
      '',
      '## Trailing',
      '',
      'trailing tail',
      '',
    ].join('\n')
    const file = normalizePath(path.join(os.tmpdir(), `tg-guard-dup-heading-ptr-${process.pid}-${Math.random().toString(36).slice(2)}.md`))
    fs.writeFileSync(file, body)
    tmpFiles.push(file)

    expect(preReadHandler(readEvent(file)).hookType).not.toBe('deny')
    const post = postReadHandler(postEvent(file, body))
    expect(post.hookType).toBe('rewriteOutput')
    const rewritten = post.hookType === 'rewriteOutput' ? post.updatedOutput : ''
    const noticeLine = rewritten.split('\n').find((l) => l.includes('rest of paragraph folded'))
    expect(noticeLine).toBeDefined()

    const sectionPointer = /token-goat section "(.+)::([^":]+)"/.exec(noticeLine ?? '')
    expect(sectionPointer, `expected a section pointer, got: ${noticeLine}`).not.toBeNull()
    const [, , heading] = sectionPointer!
    const section = readSection(file, heading ?? '')
    expect(section).not.toBeNull()
    // The withheld bytes, not merely a section that happens to share the pointer's heading text.
    expect(section?.content).toContain(marker)
    expect(section?.content).not.toContain(firstOccurrenceBody)
  })
})
