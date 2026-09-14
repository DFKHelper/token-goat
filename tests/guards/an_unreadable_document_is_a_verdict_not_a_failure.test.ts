/**
 * Guard: a document that cannot be read because of what its bytes are must be recorded as settled, not retried forever.
 *
 * The indexer splits extraction errors in two. A refusal is a verdict on the document, so the file is stamped and never re-opened while its bytes are unchanged. Anything else is a failure to read -- the library was momentarily missing, the file was mid-write -- so the file is left unstamped and picked up again later. That split is the difference between one wasted attempt and one wasted attempt on every worker drain for as long as the file exists.
 *
 * Four deterministic verdicts were on the wrong side of it: a zip holding no `word/document.xml`, no `xl/workbook.xml`, or no slides, and a part nesting past the parser's depth limit. Whether an archive holds a part is a fact about the archive, identical on every future pass, and all four were thrown as errors the classifier reads as a failure. Measured before the fix, through the real indexer: every one came back with an empty `embed_sha`, against a readable document in the same run that came back stamped.
 *
 * A PDF that pdfjs rejects is deliberately NOT in that set, and the last test here pins it so nobody quietly moves it. That verdict belongs to one version of one library rather than to the bytes: a pdfjs upgrade can read a file the current one calls invalid, and settling it would bury the document on someone else's opinion. tests/document_extraction_failure_is_retried.ts holds the other side of the same line.
 *
 * The stamp is keyed on the file's content hash, which is what makes settling safe here: a document that was truly mid-write gets a new hash when the write finishes, and is read again on its own.
 *
 * HAND-DERIVED: every fixture is built here from the format's own structure -- a zip with the wrong parts, nesting counted against the exported limit, bytes that are plainly not a PDF. No fixture is a capture of this code's output, and none is derived from the classifier being tested.
 */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../../src/db.js'
import { DEFAULT_DIM, setPipelineFnForTesting } from '../../src/embeddings.js'
import { extractEmbeddableDocumentText, isDocumentRefusal, isEmbeddableDocument, isTransientDocumentRefusal } from '../../src/doc_embed_extract.js'
import { resolveIndexPath } from '../../src/paths.js'
import { indexFileEmbeddings } from '../../src/parser.js'
import { MAX_XML_DEPTH } from '../../src/xml_parser.js'

const SHA = 'c0ffee00c0ffee00'

let root: string
let dbPath: string
let prevEmbeddingsEnv: string | undefined

function write(name: string, bytes: Uint8Array | string): string {
  const file = resolveIndexPath(path.join(root, name))
  fs.writeFileSync(file, bytes)
  return file
}

/** A real, well-formed zip that simply does not hold the part the named format is made of. */
function zipWithout(parts: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': '<Types/>', ...parts }).map(([k, v]) => [k, strToU8(v)])))
}

/** The embed_sha the indexer left on the file, or null when it left none. Null is the retry-forever state. */
async function stampAfterIndexing(file: string): Promise<string | null> {
  const db = getDb(dbPath)
  db.prepare('INSERT OR REPLACE INTO files(path, sha, mtime, language) VALUES (?, ?, ?, ?)').run(file, SHA, 0, 'unknown')
  await indexFileEmbeddings(file, dbPath, SHA)
  const row = db.prepare('SELECT embed_sha FROM files WHERE path = ?').get(file) as { embed_sha: string | null } | undefined
  return row?.embed_sha ?? null
}

async function errorFrom(file: string): Promise<unknown> {
  try {
    await extractEmbeddableDocumentText(file)
    return expect.fail(`${path.basename(file)} extracted without error, so there is no verdict to classify`)
  } catch (err) {
    return err
  }
}

const READABLE_DOCX = zipWithout({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>readable calibration text</w:t></w:r></w:p></w:body></w:document>' })

/** An unreadable fixture per embeddable extension, and whether being unreadable is a verdict on the file. Keyed by extension so the coverage check below measures against the product's own set rather than against this list. */
const UNREADABLE: Record<string, { bytes: Uint8Array | string; settled: boolean }> = {
  '.docx': { bytes: zipWithout({ 'word/other.xml': '<x/>' }), settled: true },
  '.pptx': { bytes: zipWithout({ 'ppt/presentation.xml': '<p:presentation/>' }), settled: true },
  '.xlsx': { bytes: zipWithout({ 'xl/other.xml': '<x/>' }), settled: true },
  // Not settled, on purpose. See the note at the top of this file: the refusal would be pdfjs's rather than the file's.
  '.pdf': { bytes: 'these bytes are plainly not a PDF', settled: false },
}

/** Written out rather than derived, so the table each parameterized block below runs over is provably non-empty in this file's own source: a table that computes to nothing registers zero cases and the file still reports green. Held equal to UNREADABLE's keys by the first test. */
const EXTENSIONS = ['.docx', '.pptx', '.xlsx', '.pdf']

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'tg-verdict-'))
  dbPath = path.join(root, 'probe.db')
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts) and that early return short-circuits above the document branch under test, stamping a disabled-marker that would make every stamp assertion here meaningless.
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
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a document that cannot be read for what it is', () => {
  it('has a fixture for every format the indexer extracts, so a format added later cannot slip past this file', () => {
    // The link between the written-out table and the fixtures: drift either way fails here rather than silently shrinking what the blocks below run over.
    expect(EXTENSIONS).toEqual(Object.keys(UNREADABLE))
    // Driven off isEmbeddableDocument rather than a copy of its set: a fifth format would fail here instead of being quietly untested, which is how a list in this repo usually goes wrong.
    for (const ext of ['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.txt']) {
      expect(isEmbeddableDocument(`f${ext}`), ext).toBe(Object.hasOwn(UNREADABLE, ext))
    }
  })

  it.each(EXTENSIONS)('is classified for %s the way that format is meant to be', async (ext) => {
    const { bytes, settled } = UNREADABLE[ext]
    const err = await errorFrom(write(`broken${ext}`, bytes))
    expect(isDocumentRefusal(err), `${(err as Error).name}: ${(err as Error).message}`).toBe(settled)
    // Never the clock: nothing here measures the machine, so no fixture may come back as the kind of refusal that is re-examined when the bound moves.
    expect(isTransientDocumentRefusal(err)).toBe(false)
  })

  it.each(EXTENSIONS)('stamps or leaves %s exactly as its classification says', async (ext) => {
    const { bytes, settled } = UNREADABLE[ext]
    expect(await stampAfterIndexing(write(`broken${ext}`, bytes))).toBe(settled ? SHA : null)
  })

  it('is a permanent refusal when a part nests past the parser depth limit', async () => {
    const deep = zipWithout({ 'word/document.xml': '<a>'.repeat(MAX_XML_DEPTH + 8) + '</a>'.repeat(MAX_XML_DEPTH + 8) })
    const err = await errorFrom(write('deep.docx', deep))
    expect(isDocumentRefusal(err), `${(err as Error).name}: ${(err as Error).message}`).toBe(true)
    expect(isTransientDocumentRefusal(err)).toBe(false)
    expect(await stampAfterIndexing(write('deep2.docx', deep))).toBe(SHA)
  })

  it('still stamps a document it can read, so a stamp does not merely mean the indexer gave up', () => {
    // Calibration in the affirmative direction. Without it, a stamping path broken in some other way would make every assertion above pass for the wrong reason.
    return expect(stampAfterIndexing(write('good.docx', READABLE_DOCX))).resolves.toBe(SHA)
  })

  it('leaves a file it could not open at all unstamped, so a real read failure is still retried', async () => {
    // The other half of the split. A path that is not there is not a verdict about any bytes, and settling it would bury the document once the cause went away.
    const missing = resolveIndexPath(path.join(root, 'vanished.docx'))
    expect(await stampAfterIndexing(missing)).toBeNull()
  })
})
