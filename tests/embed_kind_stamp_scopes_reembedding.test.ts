/**
 * A change to one document extractor re-embeds that format's files and nothing else.
 *
 * `EMBED_FINGERPRINT` was a single digest over all 25 embedding-decision sources, folded whole into the provenance stamp, so any mismatch cleared `files.embed_sha` for every embedded file in the database. Editing `src/pdf_extract.ts` -- which can only ever change how a PDF's bytes become chunk text -- therefore re-embedded every TypeScript, Python and Markdown file on the machine: 243,238 chunks across 17,876 files on one real index, roughly 45 minutes of inference. The stamp now carries a global digest plus one per extraction kind, and `ensureEmbeddingProvenance` marks stale only the kinds whose digest moved.
 *
 * Both directions are asserted, because either alone proves nothing: a change to a global source must still invalidate every kind (or the split has simply disabled the mechanism), and a change to one kind must invalidate exactly that kind. The upgrade into this scheme is asserted too -- it must re-embed nothing, since a one-time full re-embed would cost every user far more than the change saves -- along with the case that grandfathering must NOT cover, a stamp from some other build.
 *
 * Provenance: HAND-DERIVED. Every stale stamp below is the running stack's own stamp with one digest field substituted, which is the state a source edit leaves behind; each substitution is asserted to have actually changed the string, so a stamp that silently failed to move cannot pass as a no-op result. The pre-split stamp is the literal digest v2.9.18 shipped, read from `git show v2.9.18:src/embed_fingerprint.ts`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { embeddingProvenance, ensureEmbeddingProvenance } from '../src/embeddings.js'

let TMP: string

const FILES = { 'src/app.ts': 3, 'docs/readme.md': 2, 'docs/spec.pdf': 2, 'docs/deck.pptx': 1 }

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

/** The files this database now considers stale for re-embedding, i.e. whose embed_sha was cleared. */
function staleFiles(dbPath: string): string[] {
  return (getDb(dbPath).prepare('SELECT path FROM files WHERE embed_sha IS NULL ORDER BY path').pluck().all() as string[])
}

function chunkCount(dbPath: string): number {
  return getDb(dbPath).prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number
}

/** Runs the real gate against a database stamped with `stored`, and reports which files it marked stale. */
function afterStamp(name: string, stored: string): { stale: string[]; chunks: number; warned: boolean; provenance: string | undefined } {
  const dbPath = path.join(TMP, `${name}.db`)
  seedIndex(dbPath)
  getDb(dbPath).prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (1, ?)').run(stored)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  ensureEmbeddingProvenance(getDb(dbPath))
  return {
    stale: staleFiles(dbPath),
    chunks: chunkCount(dbPath),
    warned: warn.mock.calls.length > 0,
    provenance: getDb(dbPath).prepare('SELECT provenance FROM embedding_provenance WHERE id = 1').pluck().get() as string | undefined,
  }
}

/** The running stamp with one kind's digest replaced, asserting the substitution landed -- a regex that matched nothing would produce the current stamp and a green "nothing was re-embedded". */
function withMovedKind(kind: string): string {
  const moved = embeddingProvenance().replace(new RegExp(`\\+${kind}-[0-9a-f]{16}`), `+${kind}-0000000000000000`)
  expect(moved, `the ${kind} digest is not in the stamp, so this case would assert against an unchanged stamp`).not.toBe(embeddingProvenance())
  return moved
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-kind-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a moved extraction-kind digest', () => {
  it('re-embeds that format alone', () => {
    const r = afterStamp('pdf', withMovedKind('pdf'))
    expect(r.stale, 'a pdf-extractor change re-embedded files it cannot possibly have changed the chunk text of').toEqual(['docs/spec.pdf'])
    expect(r.chunks, 'the vectors and chunks were dropped; a chunking-half move must keep them serving until each file is re-embedded').toBe(8)
    expect(r.warned, 'a kind-scoped re-embed warned as though vectors had been discarded').toBe(false)
    expect(r.provenance).toBe(embeddingProvenance())
  })

  it('re-embeds markdown alone when the markdown heading scanner moves', () => {
    expect(afterStamp('md', withMovedKind('markdown')).stale).toEqual(['docs/readme.md'])
  })

  it('leaves a format whose own digest did not move alone, even when a sibling document kind moved', () => {
    // pptx and docx share the OOXML reader, so this also pins that sharing a source does not merge two kinds into one blast radius when only one of their digests moved.
    expect(afterStamp('pptx', withMovedKind('pptx')).stale).toEqual(['docs/deck.pptx'])
  })
})

describe('a moved global digest', () => {
  it('still re-embeds every kind, because the chunker decides all of them', () => {
    // The calibration that matters: without it, a split that simply stopped invalidating anything would pass every case above.
    const stored = embeddingProvenance().replace(/\/embed-[0-9a-f]{16}/, '/embed-0000000000000000')
    expect(stored).not.toBe(embeddingProvenance())
    const r = afterStamp('global', stored)
    expect(r.stale, 'a chunker change left some already-embedded files carrying vectors the old code produced').toEqual(['docs/deck.pptx', 'docs/readme.md', 'docs/spec.pdf', 'src/app.ts'])
    expect(r.chunks, 'the vectors were discarded rather than kept serving until each file is re-embedded').toBe(8)
  })
})

describe('the upgrade into per-kind stamps', () => {
  it('re-embeds nothing for a database stamped by the release before the split', () => {
    // The whole point of the change is to stop billing a full re-embed for a change that cannot have altered most files' chunk text. An upgrade that itself re-embedded all 17,876 files would cost every user roughly 45 minutes up front, more than the change saves for months.
    const preSplit = `${embeddingProvenance().replace(/\/embed-.*$/, '')}/embed-b7b2ff71de288d13`
    const r = afterStamp('presplit', preSplit)
    expect(r.stale, 'upgrading to per-kind stamps re-embedded files whose chunk text no source change could have moved').toEqual([])
    expect(r.chunks).toBe(8)
    expect(r.provenance, 'the upgraded stamp was not recorded, so every later run would repeat this decision').toBe(embeddingProvenance())
  })

  it('does not grandfather a stamp from some other build just because it carries no kinds', () => {
    // The pre-split digest identifies one exact source set. Any other whole-set digest names a build whose extractors are unknown, and those files must be re-embedded as they always were.
    const otherBuild = `${embeddingProvenance().replace(/\/embed-.*$/, '')}/embed-1234567890abcdef`
    expect(afterStamp('other', otherBuild).stale, 'vectors from an unknown build were kept as though they matched this one').toEqual(['docs/deck.pptx', 'docs/readme.md', 'docs/spec.pdf', 'src/app.ts'])
  })
})
