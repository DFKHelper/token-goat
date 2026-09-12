/**
 * Structural guard for the truncate-before-redact defect class (four confirmed sites, fixed in
 * mcp_cache.ts::mcpInputPreview, session.ts::recordOutstandingAgentSpawn + session_store.ts's
 * saveSessionState backstop, tool_filters/base.ts::apply(), and mcp_compress_packs.ts's
 * truncateSnapshotLine via hooks_mcp.ts::postMcpHandler). Every one of those bugs had the same
 * shape: a helper that shortens a string ran before -- not after -- the pipeline's redaction
 * pass, so a credential straddling the cut point survived as an unrecognizable fragment.
 *
 * A per-site regression test (see tests/tool_filters.test.ts, tests/mcp_cache.test.ts,
 * tests/session.test.ts, tests/session_store.test.ts, tests/hooks_mcp.test.ts) pins those four
 * sites. It says nothing about a fifth truncator someone adds next month -- which is exactly what
 * this repo's own precedent predicts will happen (`dangerous_sinks_are_named.test.ts`'s own words:
 * "this repo already has eighty-odd structural guards, and every one of them encodes a defect
 * somebody already found").
 *
 * So this guard is keyed on the SHAPE (a function whose job is to shorten a string) rather than on
 * the four known names. It enumerates every such function in `src/` and requires each one to carry
 * an explicit classification: is the text it shortens already guaranteed secret-free by the time it
 * runs, or does it operate somewhere a raw secret could never legitimately reach in the first place?
 * An unclassified truncator is red. That inverts the usual default -- new code is guilty until a
 * human looks at it and says why it's fine -- which is the only way a static scan protects against
 * a shape it has never seen before.
 *
 * WHY A NAME-HEURISTIC SCAN, NOT A DATAFLOW ANALYSIS. A fully general "does redaction dominate
 * every path into this truncator" check needs interprocedural dataflow this suite cannot run
 * offline and fast (see dangerous_sinks_are_named.test.ts's note on why CodeQL, not vitest, owns
 * that half). The fallback the task brief specifies is an explicit registry, so that's what this
 * is: the population is every top-level function whose name reads as a truncator (trunc*, clip*,
 * cap<Word>, elide*, shorten*, *preview*, clamp*), found by scanning comment-stripped source, and
 * the registry is TRUNCATOR_CLASSIFICATION below. A name-based population can miss an anonymously-
 * named shortening helper; it cannot silently miss one that keeps a name in this family, and the
 * four real bugs this guard exists to generalize all had names in exactly this family
 * (mcpInputPreview, capLongLines, clipWideLines, truncateSnapshotLine, truncateMiddleSmart,
 * capBytes, clampKeepingEnds).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface TruncatorSite {
  /** `path/relative/to/src.ts` */
  readonly file: string
  readonly name: string
  readonly line: number
}

/**
 * Name shape shared by every truncator this codebase has ever shipped, including the four that
 * leaked: a `trunc*`/`Trunc*` root, `clip*`/`Clip*`, `cap` immediately followed by an uppercase
 * letter (word-boundary, so `escape`/`capture`/`capabilities` do not match -- case-SENSITIVE on
 * purpose, since a case-insensitive class match makes `cap[A-Z]` match "cape" inside "escape"),
 * `elide*`/`Elide*`, `shorten*`/`Shorten*`, `*preview*`/`*Preview*`, and `clamp*`/`Clamp*`.
 */
const TRUNCATOR_NAME_RE = /function\s+([A-Za-z0-9_]*(?:trunc|Trunc|clip|Clip|cap[A-Z]|Cap[A-Z]|elide|Elide|shorten|Shorten|preview|Preview|clamp|Clamp)[A-Za-z0-9_]*)\s*\(/

function truncatorSites(): readonly TruncatorSite[] {
  const out: TruncatorSite[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      const code = stripComments(fs.readFileSync(p, 'utf8'))
      const lines = code.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = TRUNCATOR_NAME_RE.exec(lines[i]!)
        if (m) out.push({ file: path.relative(SRC_DIR, p).split(path.sep).join('/'), name: m[1]!, line: i + 1 })
      }
    }
  })(SRC_DIR)
  return out
}

type Bucket =
  /** Redacts the input itself, in the same function, before shortening it. */
  | 'redacts-before-truncating'
  /** Never sees raw content: every caller in its pipeline already redacted upstream (Step 1.5 of
   * tool_filters/base.ts::apply(), or an equivalent early pass) before this function runs. */
  | 'operates-on-already-redacted-input'
  /** The function it shortens can never legitimately contain a secret string at all: it caps the
   * NUMBER of items in an array/rows (not a string's characters), or shortens a value that is
   * itself already a hash/fingerprint/digest/counter, never free text. */
  | 'shortens-a-count-or-a-digest-not-free-text'
  /** Its caller already refused to touch the input at all (returned the original untouched, with
   * no token-goat substitution) whenever `redactSecrets(input).count > 0`, so this function only
   * ever runs on text proven to contain zero secret-shaped fragments. */
  | 'caller-refuses-any-secret-shaped-input-before-reaching-here'
  /** Operates on the user's own project source (a Read-tool-shaped file, or a token-goat CLI's own
   * index of it), or on the model's own prior transcript -- a trust boundary this repo's redaction
   * invariant (CLAUDE.arch.md Security Boundaries) never covered, because that content was never
   * mediated through token-goat's tool-output/session-state pipeline in the first place. */
  | 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary'
  /** Shortens an operator-supplied value (a URL from the user's own config.toml) for a CLI error
   * message, not a model-driven tool-output value; the threat model this guard protects against is
   * a credential a TOOL CALL surfaced, not one the operator typed into their own config. */
  | 'operator-supplied-value-cli-error-path'
  /** Exported but never imported anywhere outside its own module -- dead code, unreachable from any
   * hook/CLI entry point, verified by grepping every `from '.../<module>.js'` import in src/. */
  | 'dead-code-unreachable-from-any-entry-point'

interface Classification {
  readonly bucket: Bucket
  readonly reason: string
}

/**
 * The contract. Every name {@link truncatorSites} finds must appear here -- an unclassified
 * truncator fails the "every discovered truncator is classified" test below, deliberately, so a
 * new one is red until someone puts a real answer next to it.
 */
const TRUNCATOR_CLASSIFICATION: ReadonlyMap<string, Classification> = new Map([
  [
    'mcpInputPreview',
    {
      bucket: 'redacts-before-truncating',
      reason:
        'Calls redactSecrets(JSON.stringify(toolInput)).text.slice(0, 120) -- redacts the full ' +
        'string before ever slicing it, so only placeholder text can be cut. This is defect 26; ' +
        'see tests/mcp_cache.test.ts for the straddling-key regression.',
    },
  ],
  [
    'truncateSnapshotLine',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'hooks_mcp.ts::postMcpHandler computes redactedResult = redactSecrets(resultText) before ' +
        'every early return, then feeds redactedResult.text (never raw resultText) into ' +
        'compressMcpResultWithPacks, which is truncateSnapshotLine\'s only caller. This is defect ' +
        '26c; see tests/hooks_mcp.test.ts for the straddling-key regression.',
    },
  ],
  [
    'clipWideLines',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'Called from tool_filters/base.ts::apply() at Step 2b, after Step 1.5 unconditionally ' +
        'redacts stdout/stderr. This is defect 26b\'s pipeline; see tests/tool_filters.test.ts.',
    },
  ],
  [
    'clampKeepingEnds',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'Called from apply() at Step 2, after Step 1.5\'s unconditional redaction pass.',
    },
  ],
  [
    'capLongLines',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'Called from apply() at Step 7.5, after Step 1.5\'s redaction. This is the truncator the ' +
        'capLongLines-straddle regression in tests/tool_filters.test.ts targets directly.',
    },
  ],
  [
    'truncateMiddleSmart',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'Called from apply() at Step 8, after Step 1.5\'s redaction pass on the same body.',
    },
  ],
  [
    'truncateMiddle',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'truncateMiddleSmart\'s single-call helper; inherits its caller\'s already-redacted input.',
    },
  ],
  [
    'capBytes',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'Called from apply() at Step 9 (backstop byte cap), after Step 1.5\'s redaction pass.',
    },
  ],
  [
    'fallbackTruncate',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'Called from apply() on the already-redacted normOut/normErr streams, both on the runaway-log ' +
        'fallback branch and on the per-tool-filter exception fallback branch.',
    },
  ],
  [
    'truncateTableRows',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'A per-tool compress() helper; every compress() call in apply() runs after Step 1.5.',
    },
  ],
  [
    'clipLongMatchLine',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'Grep-filter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    'clipGrepLines',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'Grep-filter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    'truncateForWarning',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'hooks_agent_spawn.ts truncates only entry.prompt read back from getOutstandingAgentSpawns(), ' +
        'and recordOutstandingAgentSpawn (session.ts) redacts a prompt before it is ever pushed into ' +
        'that store -- this is defect 26a\'s fix; see tests/session.test.ts.',
    },
  ],
  [
    '_capPatchLinesInBlock',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'GitFilter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    '_capStatLinesInBlock',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'GitFilter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    '_capHunksByDensity',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'GitFilter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    '_truncateListing',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'GitFilter compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    '_scoreAndCapHunks',
    {
      bucket: 'operates-on-already-redacted-input',
      reason: 'shell_file.ts compress() helper; compress() always runs after apply()\'s Step 1.5 redaction.',
    },
  ],
  [
    'previewLines',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason:
        'read_commands.ts backs `token-goat read`/`symbol`/`section`, which serve the user\'s own ' +
        'indexed project source -- a Read-tool-equivalent boundary token-goat has never redacted, ' +
        'not model-driven tool-output content.',
    },
  ],
  [
    'clipDocSummary',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Same read_commands.ts doc-summary surface as previewLines: indexed project source, not tool output.',
    },
  ],
  [
    'truncationFooter',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Formats a row-count footer string (numbers only) for the same read_commands.ts surface.',
    },
  ],
  [
    'truncationNotice',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Formats a row-count notice string (numbers only) for the same read_commands.ts surface.',
    },
  ],
  [
    'truncatedReadDenyMessage',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'hooks_read.ts deny-message builder for the Read-tool truncation-tracking surface, not tool output.',
    },
  ],
  [
    'isTruncatedReadDelivery',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Boolean predicate over Read-tool delivery metadata; touches no free text at all.',
    },
  ],
  [
    'estimateTruncatedLineCount',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Returns a line count for the Read-tool truncation-tracking surface; touches no free text.',
    },
  ],
  [
    'elideAlreadyServedLines',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Elides lines of a file the Read tool already served this session -- source file content, not tool output.',
    },
  ],
  [
    'elideServedShellLines',
    {
      bucket: 'caller-refuses-any-secret-shaped-input-before-reaching-here',
      reason:
        'maybeElideServedGenericOutput, its only caller, does `if (redactSecrets(output).count > 0) ' +
        'return null` before ever calling this -- a secret-bearing output is left completely ' +
        'untouched (no substitution at all) rather than partially reassembled.',
    },
  ],
  [
    'capLeadIn',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'fold_structure.ts caps FoldRow rows built from Read-tool/cat file-content folding, not tool output.',
    },
  ],
  [
    'clipToDeliveryCap',
    {
      bucket: 'caller-refuses-any-secret-shaped-input-before-reaching-here',
      reason:
        'Both call sites in hooks_bash.ts sit inside functions that already returned null on ' +
        '`redactSecrets(output).count > 0` earlier in the same function body, so this only ever ' +
        'clips text already proven to carry no secret-shaped fragment.',
    },
  ],
  [
    'capManifestChars',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason:
        'Shortens the pre-compact session manifest, built from file paths/symbol names/git status ' +
        'lines/hint ids -- structured session bookkeeping, not raw tool-output text a credential ' +
        'could be pasted into.',
    },
  ],
  [
    'truncateUrl',
    {
      bucket: 'operator-supplied-value-cli-error-path',
      reason:
        'Used only inside webfetch.ts\'s own thrown Error messages (SSRF/timeout/invalid-URL) for ' +
        'performHttpFetch, whose two production callers (config_commands.ts, gdrive.ts) pass a URL ' +
        'the operator configured, not one a tool call surfaced.',
    },
  ],
  [
    'previewUnavailable',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason: 'Boolean predicate ("is a preview unavailable for this content length"), not a string-shortening function at all.',
    },
  ],
  [
    'markFileTruncated',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason: 'Records a file PATH into a Set of "was truncated" flags; shortens nothing, carries no free text.',
    },
  ],
  [
    'wasFileTruncatedThisSession',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason: 'Boolean lookup against the same Set as markFileTruncated; shortens nothing.',
    },
  ],
  [
    'truncate',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason:
        'session_read.ts previews the model\'s own prior JSONL transcript (Claude Code\'s native ' +
        'session log, written with no token-goat mediation at all) for `token-goat session` ' +
        'commands -- content already outside token-goat\'s redaction boundary before this ever ' +
        'runs, and re-emitted only through the same Bash-output pipeline apply() already redacts.',
    },
  ],
  [
    'previewForBlocks',
    {
      bucket: 'read-tool-or-transcript-content-not-in-scope-of-the-tool-output-redaction-boundary',
      reason: 'Calls session_read.ts\'s own truncate() above on the same native-transcript content.',
    },
  ],
  [
    'truncateLine',
    {
      bucket: 'dead-code-unreachable-from-any-entry-point',
      reason:
        'bash_compress.ts::compressOutput (this function\'s only caller) is never imported outside ' +
        'bash_compress.ts itself -- every real importer of this module (overflow_guard.ts, ' +
        'tool_filters/helpers.ts, tool_filters/shell_file.ts) takes only stripAnsiCodes from it.',
    },
  ],
  [
    'truncateLines',
    {
      bucket: 'dead-code-unreachable-from-any-entry-point',
      reason: 'Same bash_compress.ts::compressOutput dead path as truncateLine.',
    },
  ],
  [
    'bashOutputCapBytes',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason:
        'delivery_cap.ts returns a harness-specific numeric byte-cap CONSTANT ' +
        '(`harness === "claudecode" ? CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES : null`) -- it shortens no ' +
        'string at all, it only looks up a number a real capping function elsewhere then uses.',
    },
  ],
  [
    'maybeElideServedGenericOutput',
    {
      bucket: 'caller-refuses-any-secret-shaped-input-before-reaching-here',
      reason:
        'Does `if (redactSecrets(output).count > 0) return null` before ever composing a rewrite ' +
        '-- a secret-bearing output is left completely untouched (Claude Code serves its own ' +
        'original tool_response) rather than partially reassembled. This is elideServedShellLines\'s ' +
        'own caller and carries the same refusal-gate rationale.',
    },
  ],
  [
    'fanOutElidesBodies',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason:
        'parser.ts boolean predicate (`(nameCount, declarationChars) => boolean`) deciding whether ' +
        'a fan-out summary elides declaration bodies; matches the truncator name heuristic\'s ' +
        '"elide" keyword but shortens nothing itself -- it is a policy switch a real elider reads.',
    },
  ],
  [
    'capFiles',
    {
      bucket: 'shortens-a-count-or-a-digest-not-free-text',
      reason:
        'session_store.ts caps the NUMBER of FileEntry rows kept (drops the oldest by lastReadAt), ' +
        'not the length of any string; FileEntry (path, readCount, lastReadAt, wasEdited, ' +
        'sizeBytes) carries no free-text field for a secret to hide in.',
    },
  ],
  [
    'capTokens',
    {
      bucket: 'operates-on-already-redacted-input',
      reason:
        'bash_runner.ts calls this on `delivered`, deliverCompressed\'s own return value -- always ' +
        'redacted since the dispatch.ts::deliverCompressed fix -- before appending the savings ' +
        'marker; its other three callers (generic.ts, languages.ts, package_managers.ts) are ' +
        'compress() helpers that run after apply()\'s Step 1.5 redaction pass, same as every other ' +
        'compress()-helper entry above.',
    },
  ],
])

function classify(name: string): Classification | undefined {
  return TRUNCATOR_CLASSIFICATION.get(name)
}

describe('every truncation/shortening helper is classified (redaction-precedes-truncation defect class)', () => {
  it('scans a real, non-empty population of truncator-shaped functions', () => {
    const sites = truncatorSites()
    const names = sites.map((s) => s.name)
    pinnedPopulation({
      what: 'top-level functions in src/**/*.ts whose name reads as a truncator',
      items: names,
      floor: 30,
      mustInclude: ['mcpInputPreview', 'truncateSnapshotLine', 'capLongLines', 'clipWideLines'],
    })
  })

  it('every discovered truncator-shaped function is classified', () => {
    const sites = truncatorSites()
    const unclassified = sites.filter((s) => classify(s.name) === undefined)
    expect(
      unclassified.map((s) => `${s.file}:${s.line} ${s.name}`),
      'These functions shorten a string but carry no entry in TRUNCATOR_CLASSIFICATION. The ' +
        'truncate-before-redact defect class (four confirmed sites, see this file\'s header) is ' +
        'exactly "a new truncator that nobody checked against redaction ordering" -- classify each ' +
        'one here with which bucket it satisfies and why, or fix it if it does not satisfy any of them.',
    ).toEqual([])
  })

  it('every classification is still a real function in src', () => {
    const sites = truncatorSites()
    const foundNames = new Set(sites.map((s) => s.name))
    const stale = [...TRUNCATOR_CLASSIFICATION.keys()].filter((n) => !foundNames.has(n))
    expect(
      stale,
      'These names are classified but the scan no longer finds them -- a rename or deletion left a ' +
        'stale entry that hides behind the others while covering nothing. Remove the entry (or, if ' +
        'it was renamed, rename the entry to match).',
    ).toEqual([])
  })

  it('every classification carries a real reason, not a name alone', () => {
    for (const [name, { reason }] of TRUNCATOR_CLASSIFICATION) {
      expect(reason.length, `${name}: the classification reason is too short to be one`).toBeGreaterThan(60)
    }
  })

  it('the scan is known to find a real truncator, so an empty scan cannot pass silently', () => {
    const names = truncatorSites().map((s) => s.name)
    expect(
      names,
      'The scan found no function named mcpInputPreview. There is exactly one, in mcp_cache.ts, so ' +
        'the scan broke (comment-stripping, directory walk, or the name regex) rather than the ' +
        'function being removed.',
    ).toContain('mcpInputPreview')
  })

  it('recordGrepQuery and recordGlobQuery are still uncalled outside session.ts', () => {
    // Neither grepQueries nor globQueries (SerializedSession fields) has a live writer today --
    // recordGrepQuery/recordGlobQuery are exported but never called from anywhere else in src, so
    // the raw grep/glob pattern text they would store never actually reaches disk. That is an
    // absence of exercise, not a redaction guarantee: the moment a caller appears, a raw grep
    // pattern (which can itself be a credential someone searched for) would persist unredacted.
    // This assertion is what turns "currently unused" into an enforced fact rather than a belief:
    // if it goes red, the new caller needs redaction added at the writer (see
    // recordOutstandingAgentSpawn for the pattern) before this test's failure is resolved by
    // widening it rather than fixing it.
    const srcFiles: string[] = []
    ;(function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) srcFiles.push(p)
      }
    })(SRC_DIR)
    for (const fn of ['recordGrepQuery', 'recordGlobQuery']) {
      const callers = srcFiles.filter((p) => {
        if (path.basename(p) === 'session.ts') return false // the declaration itself
        const code = stripComments(fs.readFileSync(p, 'utf8'))
        return new RegExp(`\\b${fn}\\s*\\(`).test(code)
      })
      expect(
        callers,
        `${fn} now has a caller outside session.ts (${callers.join(', ')}). Its argument is raw ` +
          'pattern text with no redaction at the writer -- add a redactSecrets() call at the push ' +
          'site (mirroring recordOutstandingAgentSpawn) before wiring this live, then update this ' +
          'guard\'s comment.',
      ).toEqual([])
    }
  })
})
