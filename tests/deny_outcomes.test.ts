/**
 * Coverage for the deny-outcome census in src/session_audit.ts: DENY_TEMPLATES (per-kind Read-
 * deny message classification) and the join in auditOneFile that measures what actually happened
 * after each deny (compacted / retried / substituted / unresolved / abandoned).
 *
 * Privacy: every fixture message text below is tagged FORMAT-DERIVED -- copied from the literal
 * template strings in src/hooks_read.ts and src/hints/file_type_handler.ts (cited per fixture),
 * never from a real session transcript. The surrounding JSONL is a synthetic envelope this file
 * constructs itself, in the same hand-written-literal style as tests/session_audit.test.ts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auditSessionCorpus, formatSessionAudit } from '../src/session_audit.js'
import { runBatched, stopBatchCli } from './helpers/batch-cli.js'

const use = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { id: `msg_use_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const COMPACT = '{"type":"system","subtype":"compact_boundary"}'

/**
 * One fixture per DENY_TEMPLATES kind (src/session_audit.ts). `text` is FORMAT-DERIVED: copied
 * from that kind's `denyOutput(` call site in hooks_read.ts (or hints/file_type_handler.ts for
 * file_type_handler_deny), citing the branch each was read from. `expectedWithheldBytes` is
 * hand-computed from the same literal size figure the text embeds (or null where that call site's
 * template never prints one).
 */
const DENY_FIXTURES: Array<{ kind: string; text: string; expectedWithheldBytes: number | null }> = [
  // FORMAT-DERIVED: hooks_read.ts, denyOutput, node_modules branch
  { kind: 'node_modules_deny', text: 'node_modules is typically noise; use npm ls, npm outdated, or npm audit instead for dependency info. To force access, use: token-goat read node_modules/package/file.js::symbol-name or token-goat section node_modules/package/file.js::heading', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, denyOutput, lock-file branch
  { kind: 'lock_file_deny', text: 'Lock files are rarely useful to read in full. Use `token-goat section "package-lock.json::<section>"` to extract a specific dependency, or read the relevant manifest instead.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, denyOutput, .tsbuildinfo branch
  { kind: 'tsbuildinfo_deny', text: "This is a TypeScript incremental build cache file. You don't need to read it directly.", expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, denyOutput, generated/build branch
  { kind: 'generated_build_deny', text: 'Generated/build artifact — read the source file instead.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, compact-sidecar serve branch
  { kind: 'compact_sidecar_served', text: 'Serving the extractive compact sidecar in place of the full file (source unchanged since the last `compact-doc` build):\n\nSIDECAR BODY\n\nUse `token-goat compact-doc "doc.md" --force` to rebuild it, or `token-goat compact-doc "doc.md" --show` to view it directly. To edit it anyway, use `token-goat replace "doc.md" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, notebook-sidecar serve branch
  { kind: 'notebook_sidecar_served', text: 'Serving the output-stripped notebook in place of the full file (code-cell outputs and execution counts removed; source and metadata preserved):\n\nNOTEBOOK BODY\n\nTo edit it anyway, use `token-goat replace "nb.ipynb" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts markdown heading-tree branch + hints/markdown_hints.ts formatHeadingTree's opening line
  { kind: 'markdown_heading_tree_deny', text: 'Large markdown file (5 headings). Use token-goat section to read a specific section:\n  token-goat section "README.md::Heading Name"\n  Tip: an unambiguous heading prefix also resolves.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, Item 8 (MEMORY.md re-read) branch, isMainMemory case
  { kind: 'memory_md_reread_deny', text: "MEMORY.md was read this session. Its content is in the compact manifest as 'session memory'.", expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, Item 5 (.improve-state-*.json re-read) branch + sessionArtifactRecall()
  { kind: 'improve_state_reread_deny', text: 'Orchestrator state already read this session. Use `token-goat bash-output --file ".improve-state-x.json" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, .env re-read branch
  { kind: 'env_reread_deny', text: '.env was already read this session. Environment files rarely change mid-session. Use `token-goat config-get .env KEY_NAME` to extract a specific variable.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, session-artifact truncated branch + sessionArtifactRecall()
  { kind: 'session_artifact_truncated_deny', text: 'File was truncated on last read. Use `token-goat bash-output --file "tasks/abc.output" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, session-artifact unchanged branch + sessionArtifactRecall()
  { kind: 'session_artifact_unchanged_deny', text: 'abc.output is unchanged since last read. Use `token-goat bash-output --file "tasks/abc.output" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, session-artifact diff branch + sessionArtifactRecall()
  { kind: 'session_artifact_diff_deny', text: 'Content changed since last read of abc.output. Here is what changed:\n\nDIFF BODY\n\nUse `token-goat bash-output --file "tasks/abc.output" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, session-artifact large branch (toKB, util.ts) + sessionArtifactRecall()
  { kind: 'session_artifact_large_deny', text: 'Session transcript is large (500KB). Use `token-goat bash-output --file "tasks/abc.output" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: 500 * 1024 },
  // FORMAT-DERIVED: hooks_read.ts, session-artifact generic re-read branch + sessionArtifactRecall()
  { kind: 'session_artifact_generic_reread_deny', text: 'tasks/abc.output was already read this session. Use `token-goat bash-output --file "tasks/abc.output" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts truncatedReadDenyMessage() + editAnywayHint()
  { kind: 'truncated_read_deny', text: 'File was truncated on last read (>33K tokens). Use `token-goat skeleton "big.ts"` for structure or `token-goat read "big.ts::SymbolName"` for one function. To edit it anyway, use `token-goat replace "big.ts" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, doc-diffable unchanged branch + surgicalHint()
  { kind: 'doc_unchanged_deny', text: 'README.md is unchanged since last read. Use `token-goat section "README.md::HeadingName"` to extract a part.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, doc-diffable diff branch + surgicalHint()
  { kind: 'doc_diff_deny', text: 'Content changed since last read of README.md. Here is what changed:\n\nDIFF BODY\n\nUse `token-goat section "README.md::HeadingName"` to extract a part.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, read_served_deny branch + editAnywayHint()
  { kind: 'read_served_deny', text: 'Every line of foo.ts this read would return was already served in this session, byte for byte. Recall it with `token-goat bash-output abc123`, or pull just the part you need with `token-goat read "foo.ts::Symbol"`. To edit it anyway, use `token-goat replace "foo.ts" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, Item 2 (markdown already-read) branch + editAnywayHint()
  { kind: 'markdown_already_read_deny', text: 'Markdown file already read this session. Use `token-goat section "README.md::HeadingName"` to read one section. To edit it anyway, use `token-goat replace "README.md" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, count-based (3rd+ read) deny branch + editAnywayHint()
  { kind: 'read_count_deny', text: 'Read this file 3 times already — use `token-goat read "foo.ts::Symbol"`, `token-goat skeleton foo.ts`, or `token-goat outline foo.ts` to pull just the part you need. To edit it anyway, use `token-goat replace "foo.ts" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts, generic reread_deny branch + editAnywayHint()
  { kind: 'generic_reread_deny', text: 'foo.ts was already read this session (2 reads). Use token-goat read/section/symbol to re-read surgically. To edit it anyway, use `token-goat replace "foo.ts" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: null },
  // FORMAT-DERIVED: hooks_read.ts large-file deny branch (toKB, util.ts) + describeSliceAdvice() + editAnywayHint()
  { kind: 'large_file_deny', text: 'big.ts is very large (523KB). Use token-goat read/section/symbol to re-read surgically. Use Read with offset/limit to sample specific sections. To edit it anyway, use `token-goat replace "big.ts" --old-b64 <base64> --new-b64 <base64>`.', expectedWithheldBytes: 523 * 1024 },
  // FORMAT-DERIVED: hints/file_type_handler.ts, generic large-file branch (formatBytes)
  { kind: 'file_type_handler_deny', text: 'Large file (523.0 KB). Use Read with offset and limit parameters to read specific line ranges rather than loading the entire file.', expectedWithheldBytes: Math.round(523.0 * 1024) },
]

let kindsDir = ''

beforeAll(() => {
  kindsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-kinds-'))
  DENY_FIXTURES.forEach((fx, i) => {
    const projectDir = path.join(kindsDir, `p${i}`)
    fs.mkdirSync(projectDir)
    const lines = [use('d', 'Read', { file_path: `x/target-${i}.ts` }), result('d', fx.text)]
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n')
  })
})

afterAll(() => {
  stopBatchCli()
  fs.rmSync(kindsDir, { recursive: true, force: true })
})

describe('DENY_TEMPLATES classification', () => {
  it('classifies every one of the 24 kinds to its own row, with no cross-kind collisions', async () => {
    const s = await auditSessionCorpus({ dir: kindsDir })
    expect(s.denyOutcomes.length).toBe(DENY_FIXTURES.length)
    const byKind = new Map(s.denyOutcomes.map((r) => [r.kind, r]))
    for (const fx of DENY_FIXTURES) {
      const row = byKind.get(fx.kind)
      expect(row, `missing row for kind ${fx.kind}`).toBeDefined()
      expect(row!.count).toBe(1)
      // 0 tool calls follow the deny in each isolated fixture file, so every kind here resolves
      // to 'unresolved' -- this also proves the row was reached at all (a misclassified fixture
      // would either produce no row for its kind, or an extra row nobody expected).
      expect(row!.unresolvedRate).toBe(1)
      expect(row!.medianWithheldBytes).toBe(fx.expectedWithheldBytes)
      expect(row!.withheldBytesUnknownFraction).toBe(fx.expectedWithheldBytes === null ? 1 : 0)
    }
  })

  it('renders a per-kind row in the text report and a matching denyOutcomes array over --json', async () => {
    const s = await auditSessionCorpus({ dir: kindsDir })
    const text = formatSessionAudit(s)
    expect(text).toContain('## Deny outcomes (what actually happened after a token-goat Read deny; raw tokens, not billed units)')
    expect(text).toContain('large_file_deny')
    const res = await runBatched(['session-audit', '--dir', kindsDir, '--json'])
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { denyOutcomes: unknown }
    expect(parsed.denyOutcomes).toEqual(s.denyOutcomes)
  })
})

/** DENY text shared by every partition-proof scenario below: FORMAT-DERIVED, same as the large_file_deny fixture above. Kept identical across scenarios so all five land in one aggregated kind row (count 5), letting that row's outcome rates double as the partition proof. */
const LARGE_DENY_TEXT = 'big.ts is very large (523KB). Use token-goat read/section/symbol to re-read surgically. Use Read with offset/limit to sample specific sections. To edit it anyway, use `token-goat replace "big.ts" --old-b64 <base64> --new-b64 <base64>`.'

let partitionDir = ''

beforeAll(() => {
  partitionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-partition-'))

  // compacted: a compact_boundary fires before the window closes -- must never fall through to 'retried'.
  writeScenario('compacted', [
    use('d1', 'Read', { file_path: 'src/big.ts' }),
    result('d1', LARGE_DENY_TEXT),
    COMPACT,
    use('f1', 'Bash', { command: 'ls' }),
    result('f1', 'ok'),
  ])

  // retried: a plain Read of the exact same path within the 3-call window.
  writeScenario('retried', [
    use('d2', 'Read', { file_path: 'src/big2.ts' }),
    result('d2', LARGE_DENY_TEXT),
    use('d2r', 'Read', { file_path: 'src/big2.ts' }),
    result('d2r', 'retry content'),
  ])

  // substituted: a Bash surgical command against the denied path's basename within the window.
  writeScenario('substituted', [
    use('d3', 'Read', { file_path: 'src/widget.ts' }),
    result('d3', LARGE_DENY_TEXT),
    use('s3', 'Bash', { command: 'token-goat read "src/widget.ts::Foo"' }),
    result('s3', 'ok'),
  ])

  // unresolved: the file ends with fewer than 3 tool calls after the deny (here: zero).
  writeScenario('unresolved', [
    use('d4', 'Read', { file_path: 'src/lonely.ts' }),
    result('d4', LARGE_DENY_TEXT),
  ])

  // abandoned: 3 tool calls follow, none a same-path retry/substitution, no compaction.
  writeScenario('abandoned', [
    use('d5', 'Read', { file_path: 'src/other.ts' }),
    result('d5', LARGE_DENY_TEXT),
    use('a1', 'Bash', { command: 'ls' }),
    result('a1', 'ok'),
    use('a2', 'Bash', { command: 'git status' }),
    result('a2', 'ok'),
    use('a3', 'Read', { file_path: 'src/unrelated.ts' }),
    result('a3', 'ok'),
  ])

  function writeScenario(name: string, lines: string[]): void {
    const projectDir = path.join(partitionDir, name)
    fs.mkdirSync(projectDir)
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n')
  }
})

afterAll(() => {
  fs.rmSync(partitionDir, { recursive: true, force: true })
})

describe('outcome partition', () => {
  it('lands every deny in exactly one of the five buckets, including compaction and session-ended', async () => {
    const s = await auditSessionCorpus({ dir: partitionDir })
    const row = s.denyOutcomes.find((r) => r.kind === 'large_file_deny')
    expect(row).toBeDefined()
    expect(row!.count).toBe(5)
    // One deny per bucket: each rate is exactly 1/5, and they sum to exactly 1 -- a true
    // partition, not an overlapping classification where two rates could both be nonzero
    // for the same deny or the rates could sum to more/less than the whole population.
    expect(row!.compactedRate).toBeCloseTo(0.2, 10)
    expect(row!.retriedRate).toBeCloseTo(0.2, 10)
    expect(row!.substitutedRate).toBeCloseTo(0.2, 10)
    expect(row!.unresolvedRate).toBeCloseTo(0.2, 10)
    expect(row!.abandonedRate).toBeCloseTo(0.2, 10)
    const sum = row!.compactedRate + row!.retriedRate + row!.substitutedRate + row!.unresolvedRate + row!.abandonedRate
    expect(sum).toBeCloseTo(1, 10)
    // The same fixtures double as the withheldBytes/median check: all five denies print the
    // identical "(523KB)" figure, so the kind-wide median must reproduce it exactly.
    expect(row!.medianWithheldBytes).toBe(523 * 1024)
    expect(row!.withheldBytesUnknownFraction).toBe(0)
  })
})

let within10Dir = ''

beforeAll(() => {
  within10Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-within10-'))
  const lines = [
    use('d6', 'Read', { file_path: 'x/state.json' }),
    // FORMAT-DERIVED, same improve_state_reread_deny text as the classification fixture above.
    result('d6', 'Orchestrator state already read this session. Use `token-goat bash-output --file "x/state.json" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.'),
    use('u1', 'Bash', { command: 'ls' }),
    result('u1', 'ok'),
    use('u2', 'Bash', { command: 'ls' }),
    result('u2', 'ok'),
    use('u3', 'Bash', { command: 'ls' }),
    result('u3', 'ok'),
    use('u4', 'Bash', { command: 'ls' }),
    result('u4', 'ok'),
    // The 5th tool call after the deny: a plain re-read of the same path, outside the 3-call
    // outcome window but inside the 10-call retriedWithin10 window.
    use('d6r', 'Read', { file_path: 'x/state.json' }),
    result('d6r', 'retry content'),
  ]
  const projectDir = path.join(within10Dir, 'p')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n')
})

afterAll(() => {
  fs.rmSync(within10Dir, { recursive: true, force: true })
})

describe('retriedWithin10 vs the 3-call outcome window', () => {
  it('outcome misses a retry outside the first 3 calls (abandoned), but retriedWithin10 still sees it inside the 10-call window', async () => {
    const s = await auditSessionCorpus({ dir: within10Dir })
    const row = s.denyOutcomes.find((r) => r.kind === 'improve_state_reread_deny')
    expect(row).toBeDefined()
    expect(row!.count).toBe(1)
    expect(row!.abandonedRate).toBe(1)
    expect(row!.retriedRate).toBe(0)
    expect(row!.retriedWithin10Rate).toBe(1)
  })
})
