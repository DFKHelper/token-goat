/**
 * Structural guard on the persist boundary: a function that writes externally-sourced content
 * (shell output, fetched pages, a tool's own error text, indexed file/tool-output evidence) to
 * disk must reach `redactSecrets` before the write, not just before it is shown back to the
 * model. CLAUDE.arch.md's Security Boundaries section names this as the invariant "every path
 * that persists bytes goes through redactSecrets" -- this guard is its regression test.
 *
 * The population is hand-curated from the write funnels swept for this invariant (disk_cache.ts's
 * storeBlob callers, plus the two writers that persist their own plain files rather than routing
 * through storeBlob), not auto-discovered by walking every `writeFileSync` call in src -- most of
 * those persist purely internal state (config, ledgers of our own ids) with nothing externally
 * sourced to redact, and a blind sweep would need an EXEMPT entry for nearly every one of them,
 * diluting the signal to noise this guard exists to catch. Each site here is one this session's
 * sweep confirmed receives content from a shell command, a fetched page, an MCP result, or a
 * failed tool call's own error text.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { functionMap, parseTopLevelFunctions, reaches } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Self-exclusion token so this guard's own source never satisfies its own scan. Never appears in real code: /NOSUCH[X]TOKEN/. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

// `storeBlob(` counts as reaching redaction too: it is disk_cache.ts's funnel for the JSON-envelope
// caches (verified above in storeBlob's own body) and always redacts the full JSON before writing,
// so a caller that hands it a value has already reached redaction even without calling
// redactSecrets itself. `reaches()` only walks same-file calls, so this is how a cross-file
// delegation to that funnel is recognized without building a cross-file call graph.
const REDACT_TERMINALS: readonly string[] = ['redactSecrets(', 'storeBlob(']

/** True when `body` reaches the redaction boundary itself. */
function callsRedact(body: string): boolean {
  return REDACT_TERMINALS.some((terminal) => body.includes(terminal))
}

interface Site {
  readonly file: string
  readonly fn: string
}

/** Every persist-to-disk function this session's sweep confirmed receives externally-sourced content. */
const PERSIST_SITES: readonly Site[] = [
  { file: 'hooks_tool_failure.ts', fn: 'postToolUseFailureHandler' },
  { file: 'web_cache.ts', fn: 'storeWebOutput' },
  { file: 'bash_output_cache.ts', fn: 'storeBashOutputSync' },
  { file: 'mcp_cache.ts', fn: 'storeMcpOutput' },
  { file: 'content_store.ts', fn: 'storeContent' },
  { file: 'evidence_cache.ts', fn: 'recordEvidence' },
  { file: 'skill_cache.ts', fn: 'storeOutput' },
  { file: 'skill_cache.ts', fn: 'storeCompact' },
]

/** True when `fileName::fnName` still exists as a top-level function in src. */
function siteExists(site: Site): boolean {
  const full = path.join(SRC_DIR, site.file)
  if (!fs.existsSync(full)) return false
  const fns = parseTopLevelFunctions(fs.readFileSync(full, 'utf8'))
  return fns.some((f) => f.name === site.fn)
}

describe('every function persisting externally-sourced content reaches redactSecrets before writing it', () => {
  it('finds a real, present population rather than passing on an empty or stale list', () => {
    const present = PERSIST_SITES.filter(siteExists).map((s) => `${s.file}::${s.fn}`)
    pinnedPopulation({
      what: 'persist-to-disk functions known to receive externally-sourced content (shell/web/MCP output, a failed tool call\'s own error text)',
      items: present,
      floor: 6,
      mustInclude: ['hooks_tool_failure.ts::postToolUseFailureHandler'],
    })

    // Symmetric stale-key check: every named site must still exist, so an exemption (or, here, a
    // pinned site) can't silently outlive the function it names.
    const stale = PERSIST_SITES.filter((s) => !siteExists(s)).map((s) => `${s.file}::${s.fn}`)
    expect(stale, `PERSIST_SITES names a function that no longer exists:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('reaches redactSecrets before persisting, per site', () => {
    const unredacted: string[] = []
    for (const site of PERSIST_SITES) {
      const full = path.join(SRC_DIR, site.file)
      const src = fs.readFileSync(full, 'utf8')
      const fns = parseTopLevelFunctions(src)
      const byName = functionMap(fns)
      const fn = fns.find((f) => f.name === site.fn)
      if (fn === undefined) continue // reported as stale by the sibling test above
      const redacted = reaches(fn, byName, callsRedact)
      if (!redacted) unredacted.push(`${site.file}::${site.fn}`)
    }
    expect(
      unredacted,
      'These functions persist externally-sourced content to disk but never reach redactSecrets(...). ' +
        'A credential the source happened to carry (a shell command\'s stderr, a fetch failure, an MCP ' +
        'error) survives the session in plaintext. Route the value through redactSecrets before the write.\n  ' +
        unredacted.join('\n  '),
    ).toEqual([])
  })
})
