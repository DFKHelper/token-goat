/**
 * The pre-split grandfather clause stops applying once this build's chunker moves.
 *
 * `resetStaleChunking` reads a database stamped with the single whole-set digest v2.9.18 shipped as already agreeing with every stamp the per-kind build writes, so upgrading into per-kind stamps re-embeds nothing. That is only true while no source that produces chunk text has moved since that digest. Keyed on the stored stamp alone it would never stop being applied: a database still carrying the pre-split digest is a user who skipped a release, which is exactly the population the clause exists for, so the first genuine chunker or extractor change would leave those vectors grandfathered past the change that invalidated them, permanently and with nothing reporting it. The clause therefore pins this build's global digest to `SPLIT_EMBED_FINGERPRINT` as well, and lapses on its own the moment `EMBED_FINGERPRINT` leaves that value.
 *
 * All three cases are needed. Without the first, a build that had moved its chunker would still grandfather. Without the second, a clause that grandfathered nothing at all would pass -- and it would bill every upgrading user roughly 45 minutes of inference. Without the third, a clause that grandfathered every kind-less stamp would pass.
 *
 * Provenance: HAND-DERIVED. Every stored stamp is the running stack's own stamp with one digest field substituted, which is the state a source edit leaves behind, and each substitution is asserted to have actually moved the string. The pre-split digest is the literal v2.9.18 shipped (`git show v2.9.18:src/embed_fingerprint.ts`). The build whose chunker moved is simulated by substituting the generated digests in `src/embed_fingerprint.ts` -- the one thing a chunking-source edit changes -- so `embeddingProvenance` and `resetStaleChunking` run their real code against it; nothing in the path under test is stubbed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { PRE_KIND_EMBED_FINGERPRINT, SPLIT_EMBED_FINGERPRINT } from '../src/embed_fingerprint.js'
import type * as EmbedFingerprint from '../src/embed_fingerprint.js'
import { embeddingProvenance, ensureEmbeddingProvenance } from '../src/embeddings.js'

const build = vi.hoisted(() => ({ chunkerMoved: false }))

vi.mock('../src/embed_fingerprint.js', async (importOriginal) => {
  const real = await importOriginal<typeof EmbedFingerprint>()
  const move = (digest: string): string => `${digest.slice(0, 8)}ffffffff`
  const movedKinds = new Map([...real.EMBED_KIND_FINGERPRINTS].map(([kind, digest]) => [kind, move(digest)]))
  return {
    ...real,
    get EMBED_FINGERPRINT() {
      return build.chunkerMoved ? move(real.EMBED_FINGERPRINT) : real.EMBED_FINGERPRINT
    },
    get EMBED_KIND_FINGERPRINTS() {
      return build.chunkerMoved ? movedKinds : real.EMBED_KIND_FINGERPRINTS
    },
  }
})

let TMP: string

const FILES = { 'src/app.ts': 3, 'docs/readme.md': 2, 'docs/spec.pdf': 2, 'docs/deck.pptx': 1 }
const ALL_FILES = ['docs/deck.pptx', 'docs/readme.md', 'docs/spec.pdf', 'src/app.ts']

/** A database holding chunk rows for one file of each extraction kind, every one stamped as fully embedded. */
function seedIndex(dbPath: string): void {
  const db = getDb(dbPath)
  const insertFile = db.prepare('INSERT INTO files (path, sha, embed_sha) VALUES (?, ?, ?)')
  const insertChunk = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
  for (const [filePath, chunks] of Object.entries(FILES)) {
    insertFile.run(filePath, `sha-of-${filePath}`, `sha-of-${filePath}`)
    for (let i = 0; i < chunks; i++) insertChunk.run(filePath, i * 10 + 1, i * 10 + 9, `body ${i} of ${filePath}`, 'symbol')
  }
}

/** Runs the real gate against a database stamped with `stored`, and reports which files it marked stale and how many chunk rows survived. */
function afterStamp(name: string, stored: string): { stale: string[]; chunks: number } {
  const dbPath = path.join(TMP, `${name}.db`)
  seedIndex(dbPath)
  getDb(dbPath).prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (1, ?)').run(stored)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ensureEmbeddingProvenance(getDb(dbPath))
  return {
    stale: getDb(dbPath).prepare('SELECT path FROM files WHERE embed_sha IS NULL ORDER BY path').pluck().all() as string[],
    chunks: getDb(dbPath).prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number,
  }
}

/** The running stamp with its chunking half replaced by a pre-split one: the whole-set digest v2.9.18 shipped, and no per-kind digests at all. */
function preSplitStamp(): string {
  return `${embeddingProvenance().replace(/\/embed-.*$/, '')}/embed-${PRE_KIND_EMBED_FINGERPRINT}`
}

beforeEach(() => {
  build.chunkerMoved = false
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-grandfather-'))
})

afterEach(() => {
  build.chunkerMoved = false
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a pre-split database read by a build whose chunker has since moved', () => {
  it('re-embeds every file, because the grandfather clause no longer describes this build', () => {
    const stored = preSplitStamp()
    build.chunkerMoved = true
    expect(embeddingProvenance(), 'the moved build stamps identically to this one, so this case would assert nothing').not.toBe(stored)
    const r = afterStamp('moved', stored)
    expect(r.stale, 'a database that skipped the split kept vectors a later chunker invalidated, and nothing would ever revisit that').toEqual(ALL_FILES)
    expect(r.chunks, 'the vectors were discarded rather than kept serving until each file is re-embedded').toBe(8)
  })
})

describe('a pre-split database read by the build the clause was written against', () => {
  it('re-embeds nothing', () => {
    expect(SPLIT_EMBED_FINGERPRINT, 'the frozen split digest is not this build\'s, so the clause is already retired and the case above proves nothing').toBe(embeddingProvenance().split('/embed-')[1]?.split('+')[0])
    expect(afterStamp('unmoved', preSplitStamp()).stale, 'upgrading to per-kind stamps re-embedded files whose chunk text no source change could have moved').toEqual([])
  })
})

describe('a kind-less stamp from an unrecognised build', () => {
  it('is re-embedded in full, on this build as on any other', () => {
    const otherBuild = `${embeddingProvenance().replace(/\/embed-.*$/, '')}/embed-1234567890abcdef`
    expect(afterStamp('other', otherBuild).stale, 'vectors from a build whose extractors are unknown were kept as though they matched this one').toEqual(ALL_FILES)
  })
})
