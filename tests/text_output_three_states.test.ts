/**
 * Regression guard for the "empty-or-filtered store renders as populated" defect class: a
 * command's TEXT output must let a caller tell apart (a) the backing store is genuinely empty or
 * never indexed, (b) the store is populated but this filter/query matched nothing, and (c) real
 * results. Found and fixed 10+ separate times (map, dead, refs/callers --exclude-tests,
 * outline/skeleton/types, exports/test-for, skill-list/skill-diff/skill-history/skill-size,
 * call-chain, coverage-gaps, note-list, stats).
 *
 * Same two-list reconciliation pattern as tests/json_envelope_shape.test.ts: two hand-maintained
 * lists whose union must equal the full command registry, so a newly added command fails this
 * test until someone deliberately classifies it, rather than silently defaulting to unaudited.
 *
 * Scope note: unlike the --json envelope guard (which only needs to classify --json-capable
 * commands), this guard classifies the FULL registry, because the three-state distinction is a
 * TEXT-mode concern that applies whether or not a command also supports --json. Most commands are
 * NOT list-over-a-persistent-store commands at all (single scalar reports, per-invocation
 * transforms of caller-supplied input, write/mutation commands) -- those are exempt by
 * construction, not because they were individually re-verified here. Only THREE_STATE_VERIFIED
 * commands claim actual verification; every EXEMPT entry names why the distinction doesn't apply.
 */

import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, flattenCommandNames } from '../src/cli_commands.js'

/**
 * Commands whose TEXT output is a listing over one of token-goat's own persistent,
 * incrementally-built stores (the code index, the notes table, the stats ledger, the skill
 * cache, the session cache) AND has been confirmed -- by reading the source or by a dedicated
 * regression test in this suite -- to distinguish never-indexed/empty, filtered-to-empty, and
 * populated in its text output.
 */
const THREE_STATE_VERIFIED = [
  // Row-list --json commands (tests/json_envelope_shape.test.ts's ENVELOPE_COMMANDS) -- each has
  // an unknown-symbol/never-indexed error path via isIndexEmptyForProject's emptyIndexMessage
  // guard, and a --grep-filtered-to-empty path via grepFilteredToEmptyNotice or the shared
  // envelope, verified in tests/graph_commands.test.ts and tests/read_commands.test.ts.
  'symbol', 'refs', 'outline', 'skeleton', 'types', 'callers', 'dead', 'test-for', 'semantic',
  // Index-backed, verified this cycle or in prior cycles per project memory.
  'call-chain', 'coverage-gaps', 'map', 'exports', 'imports',
  // Notes store, verified this cycle.
  'note-list',
  // Stats ledger, verified this cycle (never-recorded vs --window-days-filtered-to-empty).
  'stats', 'cost',
  // Skill cache, verified in prior cycles per project memory.
  'skill-list', 'skill-diff', 'skill-history', 'skill-size',
  // Session read-count store, verified this cycle. cmdHot fixed to distinguish "no read data
  // recorded at all" from "--project filtered a nonzero total down to zero"; cmdRecent and
  // runScope have no filter argument at all (only a --limit/count cap), so they only ever have
  // two states (empty vs populated) and correctly render both; runArch always renders explicit
  // per-section counts (including "cycles (0 found)") rather than a blanket empty notice, so it
  // is unambiguous with zero tracked files too.
  'hot', 'recent', 'scope', 'arch',
] as const

/**
 * Commands NOT subject to this defect class, with the reason. Reasons are shared across commands
 * in the same category rather than restated per command -- the point is a conscious bucket
 * assignment, not unique prose per command.
 */
const EXEMPT_COMMANDS: Record<string, string> = (() => {
  const reasons: Record<string, string[]> = {
    'operates on a caller-supplied file/input given fresh each invocation, not a token-goat-maintained persistent store -- there is no "was this ever indexed" state to distinguish':
      ['csv-profile', 'csv-query', 'pdf-extract', 'pdf-meta', 'pdf-outline', 'image-meta', 'image-text', 'xlsx-head',
        'xlsx-query', 'xlsx-range', 'xlsx-sheets', 'pptx-notes', 'pptx-outline', 'pptx-slide',
        'pptx-text', 'docx-outline', 'docx-text', 'zip-list', 'zip-read', 'json-outline',
        'json-query', 'yaml-outline', 'yaml-query', 'openapi-op', 'openapi-outline',
        'sqlite-query', 'sqlite-schema', 'coverage-report-gaps', 'transcript',
        'transcript-outline', 'video-chapters', 'logfold', 'trace', 'todo', 'lockdeps',
        'gdrive-sections', 'dep-docs', 'compress', 'compress-text', 'pack'],
    'parent command with no output of its own -- every leaf is a subcommand classified separately':
      ['note'],
    'emits a single scalar/report payload (status, counts, one number), not a listing that can be filtered to empty':
      ['doctor', 'tokens', 'budget', 'bridges-status', 'commands', 'project', 'version', 'config',
        'config-get', 'statusline', 'hint-stats', 'mcp-audit', 'mcp-status', 'waste', 'bootstrap-audit',
        'context-stats', 'baseline', 'cache-audit', 'memory'],
    'write/mutation command, not a listing': ['note-add', 'note-get', 'insert-section', 'replace',
      'install', 'uninstall', 'worker', 'worker start', 'worker status', 'worker stop', 'hook',
      'index', 'write-file', 'sharepoint-resolve', 'retrieve', 'handoff-create',
      'handoff-resolve', 'screenshot', 'fetch-image', 'prune-cache', 'reclaim-index',
      'clean-cache', 'mcp-serve'],
    'reads a per-invocation session/transcript/cache slice scoped to one caller-named session or ID, not a shared filterable store':
      ['session-outline', 'session-slice', 'session-summary', 'bash-history', 'web-history',
        'mcp-history', 'recall', 'resume', 'mcp-output', 'bash-output', 'web-output', 'pr-slice',
        'history'],
    'reads or extracts a single named item (one symbol, one file, one section), not a filterable listing':
      ['read', 'section', 'brief', 'skill-body', 'skill-compact', 'skill-section', 'blame',
        'changed', 'diff', 'log', 'find', 'grep', 'conflicts', 'compact-doc', 'compact-hint'],
    'not yet individually classified into THREE_STATE_VERIFIED -- listing-shaped over the index/embeddings but this cycle only closed the residual gaps named in the project memory (call-chain, coverage-gaps, note-list, stats/cost, types, plus hot/recent/scope/arch this cycle)':
      ['ignores', 'ask', 'context-for', 'similar', 'impact', 'deps', 'failures'],
  }
  const out: Record<string, string> = {}
  for (const [reason, names] of Object.entries(reasons)) {
    for (const name of names) out[name] = reason
  }
  return out
})()

describe('text-output three-state classification is exhaustive', () => {
  it('every command in the registry is classified as verified or explicitly exempt (with a reason)', () => {
    const registry = flattenCommandNames(buildCommandManifest(buildProgram())).sort()
    const classified = [...THREE_STATE_VERIFIED, ...Object.keys(EXEMPT_COMMANDS)].sort()
    // Equality (not superset) in both directions: a new command fails here until it is
    // classified, and a removed one fails until it is dropped from the list it lived in.
    expect(classified).toEqual(registry)
    // Guards the lists against silently collapsing to empty if the manifest walk ever breaks.
    expect(registry.length).toBeGreaterThan(100)
  })

  it('no command name appears in both THREE_STATE_VERIFIED and EXEMPT_COMMANDS', () => {
    const overlap = THREE_STATE_VERIFIED.filter((name) => name in EXEMPT_COMMANDS)
    expect(overlap).toEqual([])
  })
})
