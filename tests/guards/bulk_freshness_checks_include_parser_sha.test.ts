/**
 * Structural guard for the "freshness gate keyed on one of two inputs" defect class.
 *
 * `reconcile.ts::reconcileProject`'s drift sweep used to compare only a file's content hash
 * (`files.sha`) against a fresh disk read, and treat a match as "nothing to do" -- skipping the
 * file entirely, forever, unless something later happened to edit it. That misses the case a
 * parser fix or a new parser version creates: a file nobody touched afterward still holds
 * symbol/reference rows written by the OLD extractor, recorded in `files.parser_sha`. Content and
 * parser version are two independent freshness keys (see `fold_delivery.ts::resolveFoldSpans`'s own
 * doc comment: "measured on a real index, 37 of 237 source files disagreed with what the current
 * parser produced while their content sha still matched"), and a function that reads `files.sha`
 * to decide whether to skip re-deriving a file's rows has to check both or it is wrong in exactly
 * this shape.
 *
 * A per-site regression test (tests/reconcile_parser_stale.test.ts) pins reconcile.ts's own fix. It
 * says nothing about the next bulk sweep someone writes that makes the same content-only mistake --
 * this repo's cmdIndex, worker.ts's dirty-drain, and fold_delivery.ts's fold-span resolver all read
 * `files.sha` for the same kind of decision, and a new one is exactly as easy to get wrong as
 * reconcile.ts's was.
 *
 * So this guard enumerates every top-level function in `src/` whose body calls `fingerprintFile(`
 * (the disk-hash primitive every one of these checks uses) and requires an explicit classification:
 * does it gate a skip/reuse decision on BOTH `files.sha` and `files.parser_sha`/`PARSER_FINGERPRINT`,
 * does it only ever WRITE the current parser fingerprint (not gate a skip on it), or does it operate
 * on one file the caller named explicitly rather than running a background bulk sweep that could
 * silently skip a parser-stale file forever? An unclassified function is red.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { parseTopLevelFunctions } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface Site {
  readonly file: string
  readonly name: string
}

function sites(): readonly Site[] {
  const out: Site[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      const src = fs.readFileSync(p, 'utf8')
      for (const fn of parseTopLevelFunctions(src)) {
        if (/fingerprintFile\s*\(/.test(fn.body)) {
          out.push({ file: path.relative(SRC_DIR, p).split(path.sep).join('/'), name: fn.name })
        }
      }
    }
  })(SRC_DIR)
  return out
}

type Bucket =
  /** Compares files.sha AND files.parser_sha/PARSER_FINGERPRINT before treating a row as reusable. */
  | 'gates-a-skip-decision-on-both-freshness-keys'
  /** Always stamps the CURRENT parser fingerprint on write; nothing here reuses an old row based on
   * a sha match, so there is no skip decision to key on parser_sha in the first place. */
  | 'always-writes-current-parser-sha-does-not-gate-a-skip'
  /** Runs against one file the caller (or an explicit dirty-queue entry) already named, not a
   * background bulk sweep that could silently skip a parser-stale file forever -- a parser upgrade
   * affecting this file is caught by reconcile.ts's own sweep instead. */
  | 'explicit-single-file-path-not-a-bulk-skip-sweep'

interface Classification {
  readonly bucket: Bucket
  readonly reason: string
}

const CLASSIFICATION: ReadonlyMap<string, Classification> = new Map([
  [
    'reconcileProject',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'reconcile.ts checks entry.parserSha !== PARSER_FINGERPRINT before the mtime/sha shortcut ' +
        'and counts it as parserStale -- this is the C1 fix; see tests/reconcile_parser_stale.test.ts.',
    },
  ],
  [
    'cmdIndex',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'cli.ts\'s bulk `token-goat index` walk compares fingerprintFile against the stored sha AND ' +
        'checks the parser fingerprint before skipping a file as already-current.',
    },
  ],
  [
    'resolveFoldSpans',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'fold_delivery.ts only reuses indexed spans when entry.sha matches AND entry.parserSha === ' +
        'PARSER_FINGERPRINT; a miss on either falls through to a fresh disk-based fold and enqueues ' +
        'a reindex. Its own doc comment cites the 37/237 measurement this guard generalizes.',
    },
  ],
  [
    'writeParseResult',
    {
      bucket: 'always-writes-current-parser-sha-does-not-gate-a-skip',
      reason:
        'parser.ts always writes PARSER_FINGERPRINT as the row\'s new parser_sha on every parse -- ' +
        'it never reuses an old row based on a sha match, so there is no skip decision here for ' +
        'parser_sha to gate. (Separately, it now carries embed_sha forward on unchanged content -- ' +
        'the C2 fix -- which is a different freshness key again.)',
    },
  ],
  [
    'staleWarning',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'read_commands.ts checks one file the caller\'s spec already named against a fresh disk read ' +
        '-- detecting content drift for that one file, not scanning the whole project and silently ' +
        'skipping ones that look unchanged. A parser-stale-but-content-unchanged file here is caught ' +
        'by reconcile.ts\'s own sweep, not by this function.',
    },
  ],
  [
    'healStaleIndex',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason: 'staleWarning\'s companion self-heal; same single-named-file scope, not a bulk sweep.',
    },
  ],
  [
    'processDirtyBatch',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'worker.ts drains an explicit dirty-queue entry list -- every path here was already queued ' +
        'for reindexing by something else, so there is no "looks unchanged, skip it forever" ' +
        'decision being made; fingerprintFile here detects content drift for the requeue/log path, ' +
        'not a parser-freshness gate.',
    },
  ],
])

describe('every bulk-vs-single freshness check on fingerprintFile is classified for parser_sha (freshness-gate defect class)', () => {
  it('scans a real, non-empty population', () => {
    const found = sites().map((s) => s.name)
    pinnedPopulation({
      what: 'top-level functions in src/**/*.ts that call fingerprintFile(',
      items: found,
      floor: 6,
      mustInclude: ['reconcileProject', 'writeParseResult'],
    })
  })

  it('every discovered site is classified', () => {
    const unclassified = sites().filter((s) => !CLASSIFICATION.has(s.name))
    expect(
      unclassified.map((s) => `${s.file}::${s.name}`),
      'These functions call fingerprintFile() but carry no entry in CLASSIFICATION. Decide whether ' +
        'they gate a skip/reuse decision on BOTH files.sha and files.parser_sha, only ever write the ' +
        'current parser fingerprint, or run against one explicitly-named file rather than a bulk ' +
        'sweep -- and classify them here, or fix them if a bulk sweep is keying on content alone.',
    ).toEqual([])
  })

  it('every classification is still a real function in src', () => {
    const found = new Set(sites().map((s) => s.name))
    const stale = [...CLASSIFICATION.keys()].filter((n) => !found.has(n))
    expect(stale, 'these names are classified but the scan no longer finds them').toEqual([])
  })

  it('every gates-a-skip-decision function actually references parser_sha/PARSER_FINGERPRINT', () => {
    const byName = new Map<string, Site>()
    for (const s of sites()) byName.set(s.name, s)
    for (const [name, c] of CLASSIFICATION) {
      if (c.bucket !== 'gates-a-skip-decision-on-both-freshness-keys') continue
      const site = byName.get(name)
      expect(site, `${name} was classified but not found by the scan`).toBeDefined()
      const abs = path.join(SRC_DIR, site!.file)
      const src = fs.readFileSync(abs, 'utf8')
      const fn = parseTopLevelFunctions(src).find((f) => f.name === name)
      expect(fn, `could not re-locate ${name} in ${site!.file}`).toBeDefined()
      expect(
        /parserSha|parser_sha|PARSER_FINGERPRINT/.test(fn!.body),
        `${name} is classified as gating on parser_sha but its body no longer mentions ` +
          'parserSha/parser_sha/PARSER_FINGERPRINT at all -- the classification is stale.',
      ).toBe(true)
    }
  })
})
