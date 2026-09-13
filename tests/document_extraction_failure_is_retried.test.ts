/**
 * Regression: a binary document whose text extraction FAILS must not be recorded as settled.
 *
 * indexFileEmbeddings treats "no extractable text" as terminal: it deletes the file's embeddings
 * and stamps files.embed_sha with the real content sha, so isEmbedFresh reports the file done and
 * no later worker drain re-reads it. That is correct for a refusal (the same bytes are past the
 * same bound on every run) and wrong for a failure (pdfjs briefly unavailable, the file mid-write,
 * a read race). Before the fix extractEmbeddableDocumentText caught everything and returned null,
 * so both landed in the terminal branch and one transient error retired a document permanently.
 *
 * Both halves are driven through drainOnce with no injected index callback, so the default
 * makeIndexer -> embedFileSerialized -> indexFileEmbeddings chain is the one under test. A test
 * that injected its own index callback would exercise the loop and never the shipping path.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { closeAllDbs } from '../src/db.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { getFileEntry } from '../src/index_reader.js'
import { isEmbedFresh } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { pdfBomb } from './helpers/pdf-bomb.js'

let DIR: string
let prevEmbeddingsEnv: string | undefined

// HAND-DERIVED: a PDF header followed by bytes that are not PDF objects. Written from the PDF 1.7
// requirement that the header be followed by an object graph and a trailing `startxref`, not from
// anything in src/. pdfjs rejects it with a parse error, which is a failure to read the file and
// not a verdict on it -- exactly the input the terminal-stamp branch must not claim.
const CORRUPT_PDF = Buffer.from('%PDF-1.7\nnot a pdf at all, no objects, no xref, no trailer\n', 'latin1')

// HAND-DERIVED: built by tests/helpers/pdf-bomb.ts, whose own provenance line covers the layout.
// Small enough to pass readPdfFileWithinBounds' byte bound and, once decompressed, past the 8 MB
// extracted-text budget, so extractPdfText raises PdfTooLargeError (a PdfRefusedError subclass).
const REFUSED_PDF = pdfBomb({ ops: 130_000, charsPerOp: 70 })

// HAND-DERIVED: same helper, three short text-showing operators. A readable PDF with real text,
// used to prove the retry after the transient failure clears actually embeds the document.
const READABLE_PDF = pdfBomb({ ops: 3, charsPerOp: 40 })

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-extract-retry-'))
  fs.mkdirSync(path.join(DIR, 'queue'), { recursive: true })
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts) and the disabled branch
  // short-circuits above the document branch under test.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

function enqueue(absPath: string): void {
  fs.writeFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${absPath}\n`)
}

async function drainAndSettle(absPath: string): Promise<number> {
  enqueue(absPath)
  // Real shipping path: drainOnce builds its own indexer, so no callback is injected here.
  const processed = drainOnce(DIR)
  await pendingEmbeddings()
  return processed
}

describe('a document whose extraction fails is retried, one that is refused is not', () => {
  it('leaves embed_sha unstamped after a failed extraction and embeds it on a later drain', async () => {
    const dbPath = path.join(DIR, 'global.db')
    const doc = normalizePath(path.join(DIR, 'broken.pdf'))
    fs.writeFileSync(doc, CORRUPT_PDF)

    expect(await drainAndSettle(doc)).toBe(1)

    const failed = getFileEntry(doc, dbPath)
    const failedSha = failed?.sha ?? ''
    // The file really was indexed, so what follows is a statement about the embed stamp and not
    // about a row that was never written.
    expect(failedSha).not.toBe('')
    // The discriminating assertion. Before the fix this held the bare content sha, which is the
    // value the freshness gate reads as "embedded, current" -- indistinguishable from a document
    // that genuinely has no text. Nothing may be stamped after a failure.
    expect(failed?.embedSha ?? '').toBe('')
    // Same question asked through the gate the worker actually consults, so the assertion above
    // cannot pass on a stamp shape that still reads fresh.
    expect(isEmbedFresh(failed?.embedSha, failedSha, true, true, 1024)).toBe(false)

    // Nothing about the file changed, so a pre-fix stamp would make this drain find both parse and
    // embeddings current and do no work. It must still see the document as owed.
    expect(await drainAndSettle(doc)).toBe(1)
    expect(getFileEntry(doc, dbPath)?.embedSha ?? '').toBe('')

    // The transient cause clears: the same path now holds a readable PDF.
    fs.writeFileSync(doc, READABLE_PDF)
    expect(await drainAndSettle(doc)).toBe(1)

    const recovered = getFileEntry(doc, dbPath)
    const recoveredSha = recovered?.sha ?? ''
    expect(recoveredSha).not.toBe('')
    expect(recoveredSha).not.toBe(failedSha)
    // The retry ran extraction to completion and committed. Whether the stamp is the bare sha or
    // an `unavailable:` marker depends on whether the optional sqlite-vec table is usable on this
    // machine; either way it is no longer the never-attempted empty stamp, and it is not a stale
    // stamp carried over from the corrupt bytes.
    expect(recovered?.embedSha).toBeTruthy()
    expect(recovered?.embedSha).not.toBe(failedSha)
  })

  it('stamps a refused PDF terminal so its bound is not re-spent on every drain', async () => {
    const dbPath = path.join(DIR, 'global.db')
    const doc = normalizePath(path.join(DIR, 'bomb.pdf'))
    fs.writeFileSync(doc, REFUSED_PDF)

    expect(await drainAndSettle(doc)).toBe(1)

    const refused = getFileEntry(doc, dbPath)
    const sha = refused?.sha ?? ''
    expect(sha).not.toBe('')
    // Bare sha, not a marker: a refusal is deterministic, so it is settled and stays settled.
    expect(refused?.embedSha).toBe(sha)
    expect(isEmbedFresh(refused?.embedSha, sha, true, true, 1024)).toBe(true)

    // The second drain must find nothing to do. If the refusal stopped being terminal, this would
    // re-run the multi-second extraction on every drain for as long as the file exists.
    expect(await drainAndSettle(doc)).toBe(0)
    expect(getFileEntry(doc, dbPath)?.embedSha).toBe(sha)
  }, 60_000)
})
