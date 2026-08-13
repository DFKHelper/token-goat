/**
 * Regression guard for the `{items, truncated, totalCount}` --json envelope convention.
 *
 * Two halves, deliberately kept separate because they fail for different reasons:
 *
 * 1. **Shape** — every row-list `--json` command emits the envelope unconditionally, whether or
 *    not truncation occurred, so a script consuming `--json` never has to branch on shape.
 *    Each assertion is paired with a negative control on a row-level field (`kind`, `caller`,
 *    `testFile`, ...) so a payload that grew the wrapper but lost its rows still fails here.
 *
 * 2. **Classification** — the CLI has ~96 `--json`-capable commands and only nine of them are
 *    row-list commands; the rest legitimately emit bespoke object payloads (`doctor` →
 *    `{status, message}`, `tokens` → `{total_tokens}`, `deps` → `{file, internal, external}`).
 *    Blanket-asserting the envelope across all 96 would be a wrong-oracle test, so the guard is
 *    narrowed explicitly: two hand-maintained lists whose union must equal the command
 *    registry's own `--json`-capable set. A newly added `--json` command therefore fails this
 *    test until someone classifies it into one list or the other — which is the tripwire, not
 *    the list itself.
 */

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, type CommandManifestEntry } from '../src/cli_commands.js'
import { runSymbol, runRefs, runOutline, runSkeleton, runSemantic } from '../src/read_commands.js'
import { runTypes, runCallers, runDead, runTestFor } from '../src/graph_commands.js'
import { captureStdout } from './helpers/capture-stdout.js'

/** Commands whose `--json` payload is a row list and MUST carry the shared envelope. */
const ENVELOPE_COMMANDS = [
  'symbol',
  'refs',
  'outline',
  'skeleton',
  'types',
  'callers',
  'dead',
  'test-for',
  'semantic',
] as const

/**
 * Commands that support `--json` but legitimately emit a non-row-list payload (a scalar report,
 * a keyed object, a per-file map). Listed by name rather than detected, because "is this payload
 * conceptually a list of rows?" is a design decision, not something derivable from the manifest.
 */
const NON_ENVELOPE_JSON_COMMANDS = [
  'read', 'brief', 'section', 'map', 'bridges-status', 'commands', 'stats', 'doctor',
  'context-stats', 'bootstrap-audit', 'waste', 'session-outline', 'session-slice', 'mcp-audit',
  'recall', 'hint-stats', 'statusline', 'exports', 'imports', 'find', 'grep', 'skill-list',
  'skill-history', 'call-chain', 'impact', 'deps', 'scope', 'similar', 'context-for',
  'coverage-gaps', 'arch', 'blame', 'ask', 'tokens', 'budget', 'failures', 'todo', 'trace',
  'logfold', 'lockdeps', 'dep-docs', 'note', 'hot', 'recent', 'ignores', 'bash-history',
  'web-history', 'mcp-history', 'reclaim-index', 'clean-cache', 'prune-cache', 'cache-audit',
  'resume', 'compact-hint', 'session-summary', 'cost', 'baseline', 'config', 'project',
  'compact-doc', 'fetch-image', 'history', 'changed', 'diff', 'log', 'pdf-outline', 'pdf-meta',
  'image-meta', 'image-text',
  'xlsx-sheets', 'pptx-outline', 'docx-outline', 'transcript-outline', 'csv-query',
  'json-outline', 'json-query', 'yaml-outline', 'yaml-query', 'openapi-outline', 'openapi-op',
  'zip-list', 'zip-read', 'pr-slice', 'sqlite-schema', 'sqlite-query', 'coverage-report-gaps',
  'conflicts', 'note-get', 'note-list',
] as const

/** Every `--json`-capable command name in the built Commander tree, subcommands included. */
function jsonCapableCommandNames(): string[] {
  const names: string[] = []
  const walk = (entry: CommandManifestEntry, prefix: string): void => {
    const full = prefix === '' ? entry.name : `${prefix} ${entry.name}`
    if (entry.options.some((o) => o.flags.includes('--json'))) names.push(full)
    for (const sub of entry.subcommands) walk(sub, full)
  }
  for (const entry of buildCommandManifest(buildProgram())) walk(entry, '')
  return names
}

/** Assert the shared envelope on `raw`, then hand back `items` for row-level checks. */
function expectEnvelope(raw: string, label: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} --json did not emit valid JSON: ${raw.slice(0, 200)}`)
  }
  expect(Array.isArray(parsed), `${label} --json must be an envelope object, not a bare array`).toBe(false)
  const obj = parsed as Record<string, unknown>
  expect(Object.keys(obj), `${label} --json must carry items/truncated/totalCount`).toEqual(
    expect.arrayContaining(['items', 'truncated', 'totalCount']),
  )
  expect(Array.isArray(obj.items), `${label} --json items must be an array`).toBe(true)
  expect(typeof obj.truncated, `${label} --json truncated must be a boolean`).toBe('boolean')
  expect(typeof obj.totalCount, `${label} --json totalCount must be a number`).toBe('number')
  return obj.items as unknown[]
}

// Same precondition (and same reason) as tests/graph_commands.test.ts: these cases query the
// ambient global.db, which is an isolated per-run temp DB under tests/setup/isolate-home.ts, so
// it is empty until something seeds it. Seed the repo's own src tree plus one test file, so
// `test-for` has a referencing test file to find rather than depending on ambient index state.
// Explicit per-hook timeout: this hook tree-sitter-parses the repo's whole src tree (213 files, ~4.2MB) from scratch, which measures 20-32s even on a fast many-core machine and roughly doubles on a 4-vCPU CI runner -- past the 30s global hookTimeout, which is sized for ordinary hooks. Scoped here rather than raising that global bound, so every other hook keeps the tighter hang detection.
const WHOLE_SRC_INDEX_TIMEOUT_MS = 120_000

beforeAll(() => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const child = join(dir, e.name)
      if (e.isDirectory()) return walk(child)
      return child.endsWith('.ts') && !child.endsWith('.d.ts') ? [child] : []
    })
  for (const file of walk(resolve('src'))) indexFileSync(normalizePath(file))
  indexFileSync(normalizePath(resolve('tests', 'graph_commands.test.ts')))
}, WHOLE_SRC_INDEX_TIMEOUT_MS)

describe('--json envelope shape', () => {
  it('symbol emits the envelope with row-level fields intact', () => {
    const { text } = runSymbol({ name: 'runTypes', json: true })
    const items = expectEnvelope(text, 'symbol')
    // Negative control: the wrapper must not have replaced the rows it wraps.
    expect((items[0] as { name?: string }).name).toBe('runTypes')
  })

  it('refs emits the envelope with row-level fields intact', () => {
    const out = captureStdout(() => { runRefs({ spec: 'querySymbols', json: true }) })
    const items = expectEnvelope(out, 'refs')
    expect(typeof (items[0] as { filePath?: string }).filePath).toBe('string')
  })

  it('outline emits the envelope with row-level fields intact', () => {
    const { text } = runOutline({ file: 'src/graph_commands.ts', json: true })
    const items = expectEnvelope(text, 'outline')
    expect(typeof (items[0] as { name?: string }).name).toBe('string')
  })

  it('skeleton emits the envelope with row-level fields intact', () => {
    const { text } = runSkeleton({ file: 'src/graph_commands.ts', json: true })
    const items = expectEnvelope(text, 'skeleton')
    expect(typeof (items[0] as { name?: string }).name).toBe('string')
  })

  it('types emits the envelope with row-level fields intact', () => {
    const out = captureStdout(() => { runTypes({ json: true }) })
    const items = expectEnvelope(out, 'types')
    const row = items[0] as { name?: string; kind?: string; filePath?: string }
    expect(typeof row.name).toBe('string')
    expect(typeof row.kind).toBe('string')
    expect(typeof row.filePath).toBe('string')
  })

  it('callers emits the envelope with row-level fields intact', () => {
    const out = captureStdout(() => { runCallers({ symbol: 'querySymbols', json: true }) })
    const items = expectEnvelope(out, 'callers')
    const row = items[0] as { caller?: string; kind?: string; file?: string; line?: number }
    expect(typeof row.caller).toBe('string')
    expect(typeof row.kind).toBe('string')
    expect(typeof row.file).toBe('string')
    expect(typeof row.line).toBe('number')
  })

  it('dead emits the envelope with row-level fields intact', () => {
    const out = captureStdout(() => { runDead({ json: true, top: 20 }) })
    const items = expectEnvelope(out, 'dead')
    const row = items[0] as { name?: string; kind?: string; file?: string; line?: number }
    expect(typeof row.name).toBe('string')
    expect(typeof row.kind).toBe('string')
    expect(typeof row.file).toBe('string')
    expect(typeof row.line).toBe('number')
  })

  it('test-for emits the envelope with row-level fields intact', () => {
    const out = captureStdout(() => { runTestFor({ file: 'src/graph_commands.ts', json: true }) })
    const items = expectEnvelope(out, 'test-for')
    const row = items[0] as { testFile?: string; testFunctions?: string[] }
    expect(typeof row.testFile).toBe('string')
    expect(Array.isArray(row.testFunctions)).toBe(true)
  })

  // A --grep that matches nothing is the "filtered store renders as populated" trap's JSON twin:
  // the text-mode branch emits a prose notice naming the filter, which is right for humans and
  // is NOT valid JSON for a caller that passed --json. Exit code is 0 in both cases (the store
  // is non-empty, the filter just matched none of it), so a consumer gets a success status and
  // an unparseable body.
  it('types --grep matching nothing still emits a well-formed empty envelope', () => {
    const out = captureStdout(() => { expect(runTypes({ json: true, grep: 'zzzNoSuchTypeXyz' })).toBe(0) })
    expect(expectEnvelope(out, 'types --grep')).toEqual([])
    expect((JSON.parse(out) as { totalCount: number }).totalCount).toBe(0)
  })

  it('dead --grep matching nothing still emits a well-formed empty envelope', () => {
    const out = captureStdout(() => { expect(runDead({ json: true, top: 500, grep: 'zzzNoSuchDeadXyz' })).toBe(0) })
    expect(expectEnvelope(out, 'dead --grep')).toEqual([])
    expect((JSON.parse(out) as { totalCount: number }).totalCount).toBe(0)
  })

  it('callers --grep matching nothing still emits a well-formed empty envelope', () => {
    const out = captureStdout(() => { expect(runCallers({ symbol: 'querySymbols', json: true, grep: 'zzzNoSuchCallerXyz' })).toBe(0) })
    expect(expectEnvelope(out, 'callers --grep')).toEqual([])
    expect((JSON.parse(out) as { totalCount: number }).totalCount).toBe(0)
  })

  it('semantic emits the envelope and keeps its payload-level source field', async () => {
    const { text } = await runSemantic('resolve callers of a symbol', { json: true })
    const items = expectEnvelope(text, 'semantic')
    // `source` is payload-level, alongside items/truncated/totalCount — never in place of them.
    expect(['embeddings', 'fts']).toContain((JSON.parse(text) as { source: string }).source)
    expect(typeof (items[0] as { filePath?: string }).filePath).toBe('string')
  })
})

describe('--json envelope classification is exhaustive', () => {
  it('every --json-capable command is classified as envelope or explicitly exempt', () => {
    const registry = jsonCapableCommandNames().sort()
    const classified = [...ENVELOPE_COMMANDS, ...NON_ENVELOPE_JSON_COMMANDS].sort()
    // Equality (not superset) in both directions: a new --json command fails here until it is
    // classified, and a removed one fails until it is dropped from the list it lived in.
    expect(classified).toEqual(registry)
    // Guards the lists against silently collapsing to empty if the manifest walk ever breaks.
    expect(registry.length).toBeGreaterThan(50)
  })
})
