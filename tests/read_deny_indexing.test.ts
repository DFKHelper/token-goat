// Ruling 78: a host-denied file is not indexed or embedded, by the worker drain or by `index`.
// Fixture provenance: HAND-DERIVED. Markers are unique strings; rule syntax is Read(glob).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, makeIndexer, pendingEmbeddings } from '../src/worker.js'
import { fingerprintFile } from '../src/fingerprint.js'
import type * as docExtract from '../src/doc_embed_extract.js'
import { buildDocxFixture } from './helpers/ooxml_fixtures.js'

const extracted: string[] = []

vi.mock('../src/doc_embed_extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof docExtract>()
  return {
    ...actual,
    extractEmbeddableDocumentText: async (filePath: string) => {
      extracted.push(normalizePath(filePath))
      return actual.extractEmbeddableDocumentText(filePath)
    },
  }
})

const SECRET_CODE = 'SECRETBODYMARKER'
const SECRET_DOC = 'SECRETDOCMARKER'
const OPEN_DOC = 'OPENDOCMARKER'

let dir = ''
let proj = ''
let prevEmbeddings: string | undefined

function put(rel: string, body: string | Uint8Array): void {
  const file = path.join(proj, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function writeDeny(): void {
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  resetReadDenyCache()
}

const source = (name: string, marker: string): string =>
  `/** Docstring of ${name}. */\nexport function ${name}(): string {\n  return '${marker}'\n}\n`

/** Every stored text column of the index that could hold file text, one string. */
function storedText(dbPath: string): string {
  const db = getDb(dbPath)
  const rows = [
    ...(db.prepare('SELECT file_path, name, body, docstring FROM symbols').all() as object[]),
    ...(db.prepare('SELECT file_path, text FROM chunks').all() as object[]),
    ...(db.prepare('SELECT path FROM files').all() as object[]),
  ]
  return JSON.stringify(rows)
}

function mentions(dbPath: string, needle: string): boolean {
  return storedText(dbPath).includes(needle)
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rd-index-')))
  proj = path.join(dir, 'proj')
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })
  prevEmbeddings = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
  put('package.json', '{}')
  put('secrets/vault.ts', source('vaultFn', SECRET_CODE))
  put('secrets/notes.docx', buildDocxFixture([{ text: `${SECRET_DOC} paragraph` }]))
  put('open/pub.ts', source('pubFn', 'OPENBODYMARKER'))
  put('open/pub.docx', buildDocxFixture([{ text: `${OPEN_DOC} paragraph` }]))
  extracted.length = 0
  resetReadDenyCache()
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddings === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddings
  closeAllDbs()
  resetReadDenyCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function drain(files: string[]): Promise<void> {
  fs.writeFileSync(path.join(dir, 'queue', 'dirty.txt'), files.map((f) => `${normalizePath(f)}\n`).join(''))
  drainOnce(dir)
  await pendingEmbeddings()
}

const RELS = ['secrets/vault.ts', 'secrets/notes.docx', 'open/pub.ts', 'open/pub.docx']
const ALL = (): string[] => RELS.map((r) => path.join(proj, r))

describe('Ruling 78: the worker drain skips a host-denied file', () => {
  it('stores no body, docstring, chunk or extracted text for a denied source file or document', async () => {
    writeDeny()
    await drain(ALL())
    const dbPath = path.join(dir, 'global.db')
    expect(mentions(dbPath, 'vaultFn'), 'denied source symbol').toBe(false)
    expect(mentions(dbPath, SECRET_CODE), 'denied source body').toBe(false)
    expect(mentions(dbPath, 'Docstring of vaultFn'), 'denied docstring').toBe(false)
    expect(mentions(dbPath, SECRET_DOC), 'denied document text').toBe(false)
    expect(mentions(dbPath, 'secrets'), 'denied path rows').toBe(false)
    const reached = extracted.filter((f) => f.includes('/secrets/'))
    expect(reached, 'denied document reached extraction').toEqual([])
  })

  it('still indexes the undenied source file and document (control)', async () => {
    writeDeny()
    await drain(ALL())
    const dbPath = path.join(dir, 'global.db')
    expect(mentions(dbPath, 'pubFn'), 'allowed source symbol').toBe(true)
    const allowedDoc = extracted.some((f) => f.endsWith('/open/pub.docx'))
    expect(allowedDoc, 'allowed document is extracted').toBe(true)
  })

  it('indexes every file when no deny rule exists (control)', async () => {
    await drain(ALL())
    const dbPath = path.join(dir, 'global.db')
    expect(mentions(dbPath, 'vaultFn')).toBe(true)
    const doc = extracted.some((f) => f.endsWith('/secrets/notes.docx'))
    expect(doc, 'no rule: the document is extracted').toBe(true)
  })

  it('purges rows stored before the denial; an uncheckable file is skipped and stops no other', async () => {
    await drain(ALL())
    const dbPath = path.join(dir, 'global.db')
    expect(mentions(dbPath, 'vaultFn')).toBe(true)
    // The settings file becomes malformed: the check cannot run, so nothing is indexed, nothing throws.
    put('.claude/settings.json', '{ not json')
    resetReadDenyCache()
    const indexer = makeIndexer(dbPath)
    put('open/second.ts', source('secondFn', 'SECONDBODYMARKER'))
    const file = path.join(proj, 'open', 'second.ts')
    const sha = fingerprintFile(normalizePath(file))
    expect(() => indexer(normalizePath(file), sha as string)).not.toThrow()
    expect(mentions(dbPath, 'secondFn'), 'a file with unchecked rules is skipped').toBe(false)
    writeDeny()
    const vault = normalizePath(path.join(proj, 'secrets', 'vault.ts'))
    await indexer(vault, fingerprintFile(vault) as string)
    expect(mentions(dbPath, 'vaultFn'), 'rows stored before the denial are purged').toBe(false)
    await indexer(normalizePath(file), sha as string)
    expect(mentions(dbPath, 'secondFn'), 'an undenied file is indexed once the rules load').toBe(true)
  })
})

describe('Ruling 78: `index` skips a host-denied file', () => {
  it('stores nothing for a denied source file or document and still indexes the others', async () => {
    writeDeny()
    const dbPath = path.join(dir, 'index.db')
    await cmdIndex(proj, { walk: true, dbPath })
    expect(mentions(dbPath, 'vaultFn')).toBe(false)
    expect(mentions(dbPath, SECRET_CODE)).toBe(false)
    expect(mentions(dbPath, SECRET_DOC)).toBe(false)
    const reached = extracted.filter((f) => f.includes('/secrets/'))
    expect(reached, 'denied document reached extraction').toEqual([])
    expect(mentions(dbPath, 'pubFn'), 'allowed source symbol').toBe(true)
  })
})
