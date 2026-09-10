/**
 * Structural guard on redaction/fencing parity for the third-party content channel.
 *
 * `third_party_content_reaches_fence.test.ts` pins the population of functions that reach a
 * third-party content source (a GitHub PR fetch, a Google Doc fetch, a cross-cache recall read)
 * and asserts each one also reaches the injection fence. Fencing and secret redaction are two
 * independent protections, and nothing before this guard asked whether the SAME population also
 * reaches `redactSecrets`. That gap was real: `pr-slice`'s diff/comments/description text was
 * fenced against prompt injection but never redacted, so a leaked credential pasted into a PR
 * comment, or committed then reverted in a diff, reached the model unredacted -- the exact class
 * already fixed for WebSearch/WebFetch/MCP results (see CLAUDE.arch.md's Security Boundaries
 * section, "Every path that persists bytes goes through redactSecrets").
 *
 * This guard reuses the SAME population and source-module exclusion the fence guard already
 * maintains (imported, not copied) rather than growing a second, divergence-prone list. It differs
 * from the fence guard in one respect: some sources on that list carry no free text a credential
 * could hide in (a bare filename), or are already redacted at a lower layer this guard names and a
 * comment on the source explains -- those get a per-site EXEMPT reason instead of REDACT_TERMINALS,
 * and the reason must be checkable, not just plausible.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { functionMap, parseTopLevelFunctions, reaches } from './reachability.js'
import { THIRD_PARTY_SOURCE_CALLS, SOURCE_MODULE_FILES, srcFiles } from './third_party_content_reaches_fence.test.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Self-exclusion token so this guard's own source (which quotes redactSecrets/EXEMPT reasons in prose) never satisfies its own scan. Never appears in real code: /NOSUCH[X]TOKEN/. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

const REDACT_TERMINALS: readonly string[] = ['redactSecrets(']

/** True when `body` reaches the redaction boundary itself. */
function callsRedact(body: string): boolean {
  return REDACT_TERMINALS.some((terminal) => body.includes(terminal))
}

/**
 * Per-site adjudication for a function that reaches a THIRD_PARTY_SOURCE_CALLS entry but not
 * `redactSecrets` directly. Each reason names a checkable mechanism, not a plausible-sounding
 * exemption -- the class of gap CLAUDE.md's own testing conventions call out as the most-repeated
 * defect generator in this repo.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'cli.ts::cmdGdriveSections',
    'fetchDoc/getDocSections/getSectionContent are always called here with fresh forced to false ' +
      'on the second, display-feeding call, which reads back through web_cache.ts::getWebOutput -- ' +
      'the same in-memory _byId cache storeWebOutput populates with redactSecrets-cleaned text ' +
      'before this function ever runs. Checkable: web_cache.ts::storeWebOutput redacts before ' +
      '_byId.set, and getWebOutput reads _byId first.',
  ],
  [
    'cli_recall.ts::runRecallCommand',
    'searchRecall/listRecentRecall (both branches of this one function) read back the FTS recall ' +
      'index, which indexRecallEntry only ever receives already-redacted text from -- ' +
      'bash_output_cache.ts, web_cache.ts, and mcp_cache.ts all call redactSecrets before calling ' +
      'indexRecallEntry, the same disk_cache.ts-adjacent funnel this repo already treats as the ' +
      'redaction choke point for these three caches.',
  ],
])

interface Site {
  readonly file: string
  readonly fn: string
}

function redactionSites(): Site[] {
  const out: Site[] = []
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
      if (touchesSource) out.push({ file: path.basename(file), fn: fn.name })
    }
  }
  return out
}

describe('every function reaching third-party content is adjudicated for redaction, not just fencing', () => {
  it('finds a real population rather than passing on an empty scan', () => {
    pinnedPopulation({
      what: 'functions reaching a THIRD_PARTY_SOURCE_CALLS entry in src/*.ts (same population the fence guard walks)',
      items: redactionSites().map((s) => `${s.file}::${s.fn}`),
      floor: 10,
      mustInclude: ['read_commands.ts::runPrSlice'],
    })
  })

  it('reaches redactSecrets or carries a checkable exemption, per site', () => {
    const sites = redactionSites()
    const unadjudicated: string[] = []
    for (const site of sites) {
      const key = `${site.file}::${site.fn}`
      if (EXEMPT.has(key)) continue
      const src = fs.readFileSync(path.join(SRC_DIR, site.file), 'utf8')
      const fns = parseTopLevelFunctions(src)
      const byName = functionMap(fns)
      const fn = fns.find((f) => f.name === site.fn)
      if (fn === undefined) continue
      const redacted = reaches(fn, byName, callsRedact)
      if (!redacted) unadjudicated.push(key)
    }
    expect(
      unadjudicated,
      'These functions read a third-party content source (see THIRD_PARTY_SOURCE_CALLS in ' +
        'third_party_content_reaches_fence.test.ts) but never reach redactSecrets(...) and carry no ' +
        'exemption in this file\'s EXEMPT map. Read each one: if the value can hold a credential, ' +
        'route it through redactSecrets before formatting/fencing; if it structurally cannot ' +
        '(a filename, an already-redacted cache read), add a checkable reason to EXEMPT.\n  ' +
        unadjudicated.join('\n  '),
    ).toEqual([])

    const stale = [...EXEMPT.keys()].filter((k) => !sites.some((s) => `${s.file}::${s.fn}` === k))
    expect(stale, `EXEMPT names a site that no longer reaches a third-party source:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('runPrSlice reaches redactSecrets on the diff/comments/description branches', () => {
    // Mechanism check, not prose: confirms the actual fix (redactSecrets calls added to the diff, comments, and description cases) stays present rather than being silently dropped by a future edit.
    const src = fs.readFileSync(path.join(SRC_DIR, 'read_commands.ts'), 'utf8')
    expect(src).toContain('const fileDiff = redactSecrets(rawFileDiff).text')
    expect(src).toContain('body: redactSecrets(c.body).text')
    expect(src).toContain('title: redactSecrets(rawDesc.title).text')
  })
})
