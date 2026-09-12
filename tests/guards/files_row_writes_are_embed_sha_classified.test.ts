/**
 * Structural guard for the "reparse drops embed_sha" defect class.
 *
 * `parser.ts::writeParseResult` used to re-insert a file's `files` row on every reparse (a parser-
 * fingerprint bump, a touched mtime, `--force-refresh`) with no `embed_sha` column at all, so the
 * next embedding pass always saw "no embedding on record" and recomputed one for content that
 * already had a correct, unchanged embedding -- content and embedding freshness are independent
 * keys, and a writer that drops one of them on every write forces full re-embedding for free.
 *
 * A per-site regression test (tests/parser_embed_sha_preserved_on_reparse.test.ts) pins that one
 * function's fix. It says nothing about the next `files`-table writer someone adds -- this repo
 * already has 6 other `INSERT INTO files`/`UPDATE files SET` sites across db.ts, embeddings.ts, and
 * worker.ts, each of which either has to carry `embed_sha` forward, deliberately clear it, write a
 * freshly computed one, or not touch the column at all -- and a new one is exactly as easy to get
 * silently wrong (an unconditional re-insert with no embed_sha column) as writeParseResult's was.
 *
 * So this guard enumerates every literal `INSERT INTO files`/`UPDATE files SET` SQL statement found
 * in `src/` and requires an explicit classification for each. An unclassified write site is red.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface WriteSite {
  readonly file: string
  readonly line: number
  /** The SQL statement's own text (trimmed), used as the classification key so a line-number
   * shift from unrelated edits nearby does not itself invalidate a classification. */
  readonly sql: string
}

const SQL_RE = /(INSERT (?:OR REPLACE )?INTO files\b(?:(?!\$\{)[^'"`])*|UPDATE files SET\b(?:(?!\$\{)[^'"`])*)/

function writeSites(): readonly WriteSite[] {
  const out: WriteSite[] = []
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
        const m = SQL_RE.exec(lines[i]!)
        if (m) {
          out.push({
            file: path.relative(SRC_DIR, p).split(path.sep).join('/'),
            line: i + 1,
            sql: m[1]!.trim(),
          })
        }
      }
    }
  })(SRC_DIR)
  return out
}

type Bucket =
  /** A fresh row write that carries the PRIOR embed_sha forward when content is unchanged, and
   * resets it (to a fresh value or null) when content changed -- the C2 fix's own shape. */
  | 'carries-embed-sha-forward-on-unchanged-content'
  /** Writes a freshly computed embed_sha after a real embedding just succeeded for this content. */
  | 'writes-a-freshly-computed-embed-sha'
  /** Deliberately invalidates embed_sha (sets it NULL) because the chunks/vectors it described were
   * just removed or are about to be recomputed -- an intentional reset, not an accidental drop. */
  | 'deliberately-clears-embed-sha'
  /** Touches only unrelated columns (retry_count, mtime bookkeeping); embed_sha is not part of this
   * statement's column list at all, so there is nothing to carry forward or drop. */
  | 'does-not-touch-the-embed-sha-column'

interface Classification {
  readonly bucket: Bucket
  readonly reason: string
}

/** Keyed on file + a stable, whitespace-normalized prefix of the SQL text, not line number (which
 * shifts under the block-comment collapse `stripComments` performs) and not the trailing
 * whitespace an `[^'"`]*` capture can pick up right before a template-literal `${...}` splice. */
function key(site: WriteSite): string {
  return `${site.file}::${site.sql.replace(/\s+/g, ' ').trim().slice(0, 50)}`
}

const CLASSIFICATION: ReadonlyMap<string, Classification> = new Map([
  [
    'parser.ts::INSERT INTO files (path, sha, mtime, language, ind',
    {
      bucket: 'carries-embed-sha-forward-on-unchanged-content',
      reason:
        'writeParseResult computes embedShaToCarry = (priorRow.sha === sha) ? priorRow.embed_sha : ' +
        'null before this INSERT, and passes it as the embed_sha param -- the C2 fix. See ' +
        'tests/parser_embed_sha_preserved_on_reparse.test.ts.',
    },
  ],
  [
    'parser.ts::UPDATE files SET embed_sha = ? WHERE',
    {
      bucket: 'writes-a-freshly-computed-embed-sha',
      reason: 'Runs immediately after indexFileEmbeddings successfully embeds this content, stamping the sha it just embedded, gated on sha = ? so a reparse racing ahead of a slow embed cannot overwrite a newer row with a stale stamp.',
    },
  ],
  [
    'db.ts::UPDATE files SET embed_sha = NULL WHERE path = ?',
    {
      bucket: 'deliberately-clears-embed-sha',
      reason: 'Runs in the same removal pass that deletes this file\'s chunks/chunk_vectors rows -- the embed_sha it described no longer describes anything, so clearing it (rather than leaving a stamp for content that no longer has vectors) is correct.',
    },
  ],
  [
    'embeddings.ts::UPDATE files SET embed_sha = NULL WHERE',
    {
      bucket: 'deliberately-clears-embed-sha',
      reason: 'clearEmbedSha explicitly invalidates the stamp before this file\'s content is re-chunked/re-embedded from scratch, so a crash between the clear and the next successful embed leaves the row correctly marked stale rather than falsely current.',
    },
  ],
  [
    'worker.ts::UPDATE files SET retry_count = ? WHERE',
    {
      bucket: 'does-not-touch-the-embed-sha-column',
      reason: 'Bumps only the transient-read-failure retry counter; embed_sha is not in this statement\'s column list.',
    },
  ],
  [
    'worker.ts::INSERT INTO files (path, retry_count) VALUES (?, 1',
    {
      bucket: 'does-not-touch-the-embed-sha-column',
      reason: 'First-failure bookkeeping row for a path with no files row yet; only path/retry_count are written, embed_sha is left at its column default (NULL), which is correct for a file that has never been parsed or embedded.',
    },
  ],
  [
    'worker.ts::UPDATE files SET retry_count = 0 WHERE',
    {
      bucket: 'does-not-touch-the-embed-sha-column',
      reason: 'Clears the retry counter once a fingerprint read succeeds; embed_sha is not in this statement\'s column list.',
    },
  ],
])

function classify(site: WriteSite): Classification | undefined {
  return CLASSIFICATION.get(key(site))
}

describe('every files-table write site is classified for embed_sha handling (reparse-drops-embed_sha defect class)', () => {
  it('scans a real, non-empty population', () => {
    const sites = writeSites()
    pinnedPopulation({
      what: 'INSERT INTO files / UPDATE files SET statements in src/**/*.ts',
      items: sites.map((s) => key(s)),
      floor: 6,
      mustInclude: ['parser.ts::INSERT INTO files', 'parser.ts::UPDATE files SET embed_sha = ?'],
    })
  })

  it('every discovered write site is classified', () => {
    const sites = writeSites()
    const unclassified = sites.filter((s) => classify(s) === undefined)
    expect(
      unclassified.map((s) => `${s.file}:${s.line} ${s.sql}`),
      'These files-table write statements carry no entry in CLASSIFICATION. Decide whether this ' +
        'write carries embed_sha forward on unchanged content, writes a freshly computed value, ' +
        'deliberately clears it, or does not touch the column at all -- and classify it here, or ' +
        'fix it if an unconditional re-insert is silently dropping a live embed_sha.',
    ).toEqual([])
  })

  it('every classification still matches a real write site in src', () => {
    const sites = writeSites()
    const found = new Set(sites.map((s) => key(s)))
    const stale = [...CLASSIFICATION.keys()].filter((k) => !found.has(k))
    expect(stale, 'these keys are classified but the scan no longer finds a matching write site (renamed, removed, or the SQL text changed)').toEqual([])
  })

  it('the classified carry-forward site actually reads a prior embed_sha before writing', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'parser.ts'), 'utf8')
    expect(
      src.includes('embedShaToCarry'),
      'writeParseResult is classified as carrying embed_sha forward, but parser.ts no longer ' +
        'defines embedShaToCarry -- the classification is stale.',
    ).toBe(true)
  })

  it('the classified carry-forward INSERT statement still names embed_sha as a column and passes embedShaToCarry as its value', () => {
    // The key() prefix used for classification lookup above is deliberately short (so ordinary
    // whitespace churn does not break it), which means it cannot by itself tell "the INSERT still
    // carries embed_sha forward" from "the INSERT was quietly narrowed back to the pre-C2 column
    // list, which happens to share the same first 50 characters". This test reads the FULL,
    // untruncated statement (and the .run(...) call passing its bound parameters) instead of the
    // truncated key, so narrowing the column list without touching the shared prefix is red here.
    const site = writeSites().find((s) => key(s) === 'parser.ts::INSERT INTO files (path, sha, mtime, language, ind')
    expect(site, 'the classified writeParseResult INSERT site was not found by the scan at all').toBeDefined()
    expect(
      site!.sql.includes('embed_sha'),
      `writeParseResult's INSERT statement no longer names embed_sha as a column: "${site!.sql}"`,
    ).toBe(true)
    const src = fs.readFileSync(path.join(SRC_DIR, 'parser.ts'), 'utf8')
    expect(
      /\.run\([^)]*embedShaToCarry/.test(src),
      'writeParseResult defines embedShaToCarry but no .run(...) call in parser.ts passes it as a bound parameter -- it is computed and then dropped on the floor.',
    ).toBe(true)
  })
})
