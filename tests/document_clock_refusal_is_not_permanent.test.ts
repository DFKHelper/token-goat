/**
 * Regression: a document refused by the work CLOCK must not be recorded as settled forever.
 *
 * `tests/document_extraction_failure_is_retried.test.ts` covers the two cases the indexer already told apart -- a failure to read (never stamped, retried) and a refusal on the bytes (stamped terminal, never re-read). A clock refusal was quietly sorted into the second pile, because `PdfTookTooLongError` and `OoxmlTookTooLongError` are `DocumentRefusedError`s and the branch asked nothing beyond that. But a size or count bound is past on every run forever, while a clock bound measured this machine under this load: a document that timed out while a build saturated the disk extracts in two seconds an hour later, and it had already been stamped with its own content sha, which the freshness gate reads as "embedded, current". The document is then never embedded again -- `semantic` stays blind to it for the life of the file -- from one busy minute. The comment on that same branch's sibling calls this out in as many words: a stamp there "would be a permanent verdict recorded from a temporary condition".
 *
 * The extractor is stubbed here on purpose, and only the extractor. The subject is parser.ts's stamp branch, which cannot be reached with a real 60-second timeout inside a test suite; that these errors are really raised by real documents is what `tests/pdf_text_extraction_is_bounded.test.ts` and `tests/ooxml_extract.test.ts` prove. The errors thrown below are the shipping classes themselves, constructed the way the readers construct them, so the `transient` flag under test is the real one and not a fixture restating it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DocEmbedExtract from '../src/doc_embed_extract.js'

import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { MAX_DOCUMENT_WORK_MILLIS } from '../src/document_refusal.js'
import { MAX_OOXML_WORK_MILLIS, OoxmlTookTooLongError, OoxmlPartTooLargeError } from '../src/ooxml_extract.js'
import { MAX_PDF_WORK_MILLIS, PdfTookTooLongError, PdfTooLargeError } from '../src/pdf_extract.js'
import { closeAllDbs } from '../src/db.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { getFileEntry } from '../src/index_reader.js'
import { isEmbedFresh, timeoutEmbedSha } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { pdfBomb } from './helpers/pdf-bomb.js'

const extractStub = vi.hoisted(() => vi.fn<(filePath: string) => Promise<string | null>>())

vi.mock('../src/doc_embed_extract.js', async (importOriginal) => ({
  // Everything except the extractor stays the real module, so the two predicates the branch under test consults are the shipping ones.
  ...(await importOriginal<typeof DocEmbedExtract>()),
  extractEmbeddableDocumentText: extractStub,
}))

// HAND-DERIVED: built by tests/helpers/pdf-bomb.ts, whose own provenance line covers the layout. The bytes only have to be a routable `.pdf` the indexer will hand to the extractor; what the extractor then does is the stub's business.
const A_PDF = pdfBomb({ ops: 3, charsPerOp: 40 })

let DIR: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-clock-'))
  fs.mkdirSync(path.join(DIR, 'queue'), { recursive: true })
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts) and the disabled branch short-circuits above the document branch under test.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  extractStub.mockReset()
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

/** Write a `.pdf` the indexer will route to the (stubbed) document extractor, drain the queue the way the worker does, and return its row. */
async function drainOneDocument(name: string): Promise<{ dbPath: string; doc: string; sha: string; embedSha: string }> {
  const dbPath = path.join(DIR, 'global.db')
  const doc = normalizePath(path.join(DIR, name))
  fs.writeFileSync(doc, A_PDF)
  fs.writeFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${doc}\n`)
  // Real shipping path: drainOnce builds its own indexer, so no callback is injected here.
  expect(drainOnce(DIR)).toBe(1)
  await pendingEmbeddings()
  const row = getFileEntry(doc, dbPath)
  const sha = row?.sha ?? ''
  // The file really was indexed, so what follows is a statement about the embed stamp and not about a row that was never written.
  expect(sha).not.toBe('')
  return { dbPath, doc, sha, embedSha: row?.embedSha ?? '' }
}

describe('a document refused by the clock is settled only while that clock is', () => {
  it('records a PDF clock refusal against the bound rather than as the content sha', async () => {
    extractStub.mockRejectedValue(new PdfTookTooLongError("reading this PDF's text passed the limit."))

    const { sha, embedSha } = await drainOneDocument('slow.pdf')

    // The discriminating assertion. Before the fix this held the bare content sha -- the exact value the freshness gate reads as "embedded, current", indistinguishable from a document that genuinely has no text.
    expect(embedSha).not.toBe(sha)
    expect(embedSha).toBe(timeoutEmbedSha(sha, MAX_DOCUMENT_WORK_MILLIS))
  })

  it('does not re-spend the clock on the next drain while the bound is unchanged', async () => {
    extractStub.mockRejectedValue(new OoxmlTookTooLongError('walking this deck passed the limit.'))

    const { doc, dbPath, sha } = await drainOneDocument('slow2.pdf')

    // Settled for now: the marker must read fresh through the gate the worker actually consults, or the minute the clock exists to cap gets re-spent on every drain for as long as the file exists.
    expect(isEmbedFresh(timeoutEmbedSha(sha, MAX_DOCUMENT_WORK_MILLIS), sha, true, true, 1024)).toBe(true)
    fs.writeFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${doc}\n`)
    expect(drainOnce(DIR)).toBe(0)
    await pendingEmbeddings()
    expect(getFileEntry(doc, dbPath)?.embedSha).toBe(timeoutEmbedSha(sha, MAX_DOCUMENT_WORK_MILLIS))
    expect(extractStub).toHaveBeenCalledTimes(1)
  })

  it('re-examines the document once the clock it was refused under moves', async () => {
    extractStub.mockRejectedValue(new PdfTookTooLongError("reading this PDF's text passed the limit."))

    const { sha, embedSha } = await drainOneDocument('slow3.pdf')

    // The whole point of encoding the bound: a release that raises the clock must re-examine every document a lower one refused, the same way raising large_file_symbol_only_kb re-examines every `oversize:` stamp. A bare sha could never express this.
    expect(isEmbedFresh(embedSha, sha, true, true, 1024)).toBe(true)
    expect(isEmbedFresh(timeoutEmbedSha(sha, MAX_DOCUMENT_WORK_MILLIS * 2), sha, true, true, 1024)).toBe(false)
    expect(isEmbedFresh(timeoutEmbedSha(sha, Math.floor(MAX_DOCUMENT_WORK_MILLIS / 2)), sha, true, true, 1024)).toBe(false)
  })

  it('still stamps a refusal on the bytes as the content sha', async () => {
    extractStub.mockRejectedValue(new PdfTooLargeError('past the text budget.'))

    const { sha, embedSha } = await drainOneDocument('bomb.pdf')

    // The other half of the discrimination. A branch that stamped the clock marker for every refusal would pass the three tests above and quietly make the deterministic refusals re-examinable too, which is the cost the terminal stamp was added to avoid.
    expect(embedSha).toBe(sha)
    expect(isEmbedFresh(embedSha, sha, true, true, 1024)).toBe(true)
  })
})

describe('which refusals declare themselves transient', () => {
  it('marks the two clock refusals transient and the size refusals not', () => {
    // Read off the shipping classes, not off a list in the indexer: a format added later is classified by what it extends and what it passes, which is the whole reason the flag lives on the error rather than in a name list here.
    expect(new PdfTookTooLongError('x').transient).toBe(true)
    expect(new OoxmlTookTooLongError('x').transient).toBe(true)
    expect(new PdfTooLargeError('x').transient).toBe(false)
    expect(new OoxmlPartTooLargeError('word/document.xml', 1).transient).toBe(false)
  })

  it('holds every document work clock to the one value the marker encodes', () => {
    // The marker records `MAX_DOCUMENT_WORK_MILLIS` because the gate that reads it back has no file path and so cannot know which reader's clock applied. That is only sound while the readers share one value; a reader that set its own would have its refusals stamped under a bound it never used, and every one of them would read stale forever.
    expect(MAX_PDF_WORK_MILLIS).toBe(MAX_DOCUMENT_WORK_MILLIS)
    expect(MAX_OOXML_WORK_MILLIS).toBe(MAX_DOCUMENT_WORK_MILLIS)
  })
})
