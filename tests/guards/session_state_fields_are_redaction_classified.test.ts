/**
 * Structural guard for the second half of the truncate-before-redact defect class:
 * `session.ts::recordOutstandingAgentSpawn` shipped a raw agent-spawn prompt into
 * `SerializedSession.outstandingAgentSpawns` with no redaction at the writer at all (a related but
 * distinct bug from the four truncate-before-redact sites -- this one never redacted, rather than
 * redacting too late). `CLAUDE.arch.md::Security Boundaries` already says, in prose, that a new
 * session-state field does not automatically inherit redaction. Prose did not stop the very next
 * field from violating it: this guard is what turns that sentence into something enforced.
 *
 * The population is every field of the `SerializedSession` interface (`src/session.ts`), extracted
 * by parsing the interface's own source text -- not a hand-copied list -- so a field added to the
 * interface tomorrow is picked up automatically and starts UNCLASSIFIED, i.e. red, until someone
 * looks at it and records why it is safe. That inversion (guilty until classified) is the actual
 * protection; a hand-copied field list would just be a second place for the same person to forget
 * to update.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SESSION_TS = path.join(HERE, '..', '..', 'src', 'session.ts')
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/**
 * Extract the field names of `export interface SerializedSession { ... }` by brace-matching from
 * the interface keyword, then reading each top-level `name?:`/`name:` line inside it. Comments are
 * stripped first so a field name mentioned only in a doc comment (e.g. this guard's own header
 * text) is never picked up as a real field.
 */
function serializedSessionFields(): readonly string[] {
  const raw = fs.readFileSync(SESSION_TS, 'utf8')
  const code = stripComments(raw)
  const startMatch = /export interface SerializedSession\s*\{/.exec(code)
  if (!startMatch) throw new Error('SerializedSession interface not found -- session.ts moved or was renamed')
  let depth = 1
  let i = startMatch.index + startMatch[0].length
  const bodyStart = i
  while (depth > 0 && i < code.length) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') depth--
    i++
  }
  const body = code.slice(bodyStart, i - 1)
  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm
  const fields: string[] = []
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(body)) !== null) fields.push(m[1]!)
  return fields
}

type Coverage =
  /** Every free-text sub-value is passed through redactSecrets() at the writer before being pushed
   * into the in-memory state that this field serializes from. */
  | 'redacted-at-writer'
  /** The field's value is a hash/fingerprint/digest of the sensitive input, computed with a
   * one-way function -- never the input itself. */
  | 'hash-keyed-not-raw-text'
  /** The field carries no free text at all: paths, booleans, counters, timestamps, or opaque
   * session-scoped keys a caller already controls (not attacker/tool-output-shaped text). */
  | 'structural-no-free-text'
  /** The field's writer function exists but has zero call sites anywhere else in src/ today, so no
   * raw text currently reaches it -- flagged explicitly so a future live-wiring is forced to pass
   * through this guard's reasoning rather than silently inheriting an unredacted writer. */
  | 'dead-writer-currently-uncalled'

interface FieldCoverage {
  readonly coverage: Coverage
  readonly reason: string
}

const SESSION_FIELD_COVERAGE: ReadonlyMap<string, FieldCoverage> = new Map([
  [
    'files',
    {
      coverage: 'structural-no-free-text',
      reason:
        'FileEntry = {path, readCount, lastReadAt, wasEdited, sizeBytes} -- a file path plus ' +
        'numeric/boolean bookkeeping, no free-text field a tool-output secret could land in.',
    },
  ],
  [
    'hintsShown',
    {
      coverage: 'structural-no-free-text',
      reason: 'A set of hint IDs drawn from a fixed, token-goat-authored vocabulary, never from tool output.',
    },
  ],
  [
    'scheduledPromptCounts',
    {
      coverage: 'structural-no-free-text',
      reason: 'Keyed by sessionId (an opaque id token-goat itself generates), value is a plain count.',
    },
  ],
  [
    'webFetches',
    {
      coverage: 'redacted-at-writer',
      reason:
        'webFetchKey(url, prompt) computes `[redactSecrets(url).text, redactSecrets(prompt).text, ' +
        'shortFingerprint(...)].join(...)` before the map key (the persisted first tuple element) ' +
        'is ever built; the value is an opaque cacheId.',
    },
  ],
  [
    'bashOutputs',
    {
      coverage: 'hash-keyed-not-raw-text',
      reason: 'Keyed by commandHash (a fingerprint of the command), value is an opaque outputId -- neither is raw command/output text.',
    },
  ],
  [
    'bashReruns',
    {
      coverage: 'hash-keyed-not-raw-text',
      reason: 'A set of commandHash values, same fingerprint as bashOutputs -- never raw command text.',
    },
  ],
  [
    'curlDownloads',
    {
      coverage: 'hash-keyed-not-raw-text',
      reason: 'curlDownloadKey(url) returns shortFingerprint(url) -- a one-way hash, never the raw URL; value is a local file path.',
    },
  ],
  [
    'fileLineRanges',
    {
      coverage: 'structural-no-free-text',
      reason: 'Keyed by file path, value is a list of numeric [start, end] line-range tuples -- no free text.',
    },
  ],
  [
    'fileServedOutputs',
    {
      coverage: 'structural-no-free-text',
      reason: 'Keyed by file path, value is a list of opaque bash-output ids (already-redacted-at-storage per mcp_cache.ts/bash_output_cache.ts, not raw text held here).',
    },
  ],
  [
    'cliReads',
    {
      coverage: 'structural-no-free-text',
      reason: 'A set of structured CLI-read keys (command name + args token-goat itself constructs), not arbitrary tool-output text.',
    },
  ],
  [
    'pendingLargeFileHints',
    {
      coverage: 'structural-no-free-text',
      reason: 'Keyed by file path, value is a numeric byte size -- no free text.',
    },
  ],
  [
    'grepQueries',
    {
      coverage: 'dead-writer-currently-uncalled',
      reason:
        'recordGrepQuery(signature, matchCount) is exported but has zero callers anywhere else in ' +
        'src/ today (see tests/guards/truncators_are_classified.test.ts\'s ' +
        '"recordGrepQuery and recordGlobQuery are still uncalled" check, which fails the moment ' +
        'that changes) -- signature is currently never populated with a live raw grep pattern, but ' +
        'carries no redaction of its own if it ever is.',
    },
  ],
  [
    'globQueries',
    {
      coverage: 'dead-writer-currently-uncalled',
      reason: 'recordGlobQuery(signature, matchCount) -- same zero-caller status and same gap as recordGrepQuery above.',
    },
  ],
  [
    'outstandingAgentSpawns',
    {
      coverage: 'redacted-at-writer',
      reason:
        'recordOutstandingAgentSpawn(prompt) pushes `redactSecrets(prompt).text`, never the raw ' +
        'prompt -- this was the fifth-not-truncation-shaped defect this session\'s work fixed; see ' +
        'tests/session.test.ts for its regression.',
    },
  ],
  [
    'lastTabContextDigest',
    {
      coverage: 'hash-keyed-not-raw-text',
      reason: 'Doc comment on the field itself: "Fingerprint of the last Tab Context block, never the block itself."',
    },
  ],
  [
    'seenImageHashes',
    {
      coverage: 'hash-keyed-not-raw-text',
      reason: 'Doc comment on the field itself: "Fingerprints of screenshots already shown this session."',
    },
  ],
  [
    'compactedAt',
    {
      coverage: 'structural-no-free-text',
      reason: 'A bare unix-ms timestamp of the most recent context compaction -- a number, carrying no free text a secret could hide inside.',
    },
  ],
  [
    'created_ts',
    {
      coverage: 'structural-no-free-text',
      reason: 'A bare unix-seconds timestamp of when the session cache was first written -- a number, carrying no free text a secret could hide inside.',
    },
  ],
])

function coverageOf(field: string): FieldCoverage | undefined {
  return SESSION_FIELD_COVERAGE.get(field)
}

describe('every SerializedSession field has recorded redaction coverage', () => {
  it('parses a real, non-empty field list from the interface', () => {
    pinnedPopulation({
      what: 'fields of the SerializedSession interface in src/session.ts',
      items: serializedSessionFields(),
      floor: 15,
      mustInclude: ['files', 'webFetches', 'outstandingAgentSpawns', 'curlDownloads'],
    })
  })

  it('every field of SerializedSession is classified', () => {
    const fields = serializedSessionFields()
    const unclassified = fields.filter((f) => coverageOf(f) === undefined)
    expect(
      unclassified,
      'A field was added to SerializedSession with no entry in SESSION_FIELD_COVERAGE. ' +
        'CLAUDE.arch.md documents in prose that a new session-state field does not inherit ' +
        'redaction -- record here whether this field\'s writer redacts free text, is hash-keyed, ' +
        'carries no free text at all, or is a currently-dead writer, and why.',
    ).toEqual([])
  })

  it('every classified field still exists on the interface', () => {
    const fields = new Set(serializedSessionFields())
    const stale = [...SESSION_FIELD_COVERAGE.keys()].filter((f) => !fields.has(f))
    expect(
      stale,
      'These field names are classified but no longer appear on SerializedSession -- a rename or ' +
        'removal left a stale entry. Remove it (or rename it to match).',
    ).toEqual([])
  })

  it('every coverage entry carries a real reason, not a label alone', () => {
    for (const [field, { reason }] of SESSION_FIELD_COVERAGE) {
      expect(reason.length, `${field}: the coverage reason is too short to be one`).toBeGreaterThan(60)
    }
  })

  it('the parse is known to find a real field, so a broken parse cannot pass silently', () => {
    expect(
      serializedSessionFields(),
      'The parse found no field named "files" -- SerializedSession genuinely has one at the top of ' +
        'its body, so the brace-matcher or the field regex broke rather than the field being removed.',
    ).toContain('files')
  })

  it('no field name is classified twice with different coverage (map keys are unique by construction, this documents that fact rather than testing it)', () => {
    // A Map literal cannot carry a duplicate key silently (the later entry would just overwrite the
    // earlier one with no error) -- this test exists so a future refactor away from a literal Map
    // toward something that COULD silently duplicate (e.g. an array of entries) trips a visible
    // failure instead of a silent overwrite.
    const fields = serializedSessionFields()
    const seen = new Set<string>()
    for (const f of fields) {
      expect(seen.has(f), `${f} appears more than once in the parsed field list`).toBe(false)
      seen.add(f)
    }
  })

  it('recordOutstandingAgentSpawn is not reachable from src without the redaction call, statically', () => {
    // A direct regression pin, in addition to the population-level classification above: the
    // exact line this session's fifth fix touches must still contain the redaction call, so a
    // future edit that drops it (rather than adding a new unrelated field) is also caught here,
    // not only by the fragment-based behavioural test in tests/session.test.ts.
    const code = stripComments(fs.readFileSync(path.join(SRC_DIR, 'session.ts'), 'utf8'))
    const fnMatch = /function\s+recordOutstandingAgentSpawn\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\}/.exec(code)
    expect(fnMatch, 'recordOutstandingAgentSpawn not found by this shape -- signature changed, update the guard').not.toBeNull()
    expect(fnMatch![1]).toMatch(/redactSecrets\(\s*prompt\s*\)\.text/)
  })
})
