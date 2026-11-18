/** Built-bundle check that `semantic` names the symbol a chunk belongs to from the lines the index numbered, for a file whose lines end with a lone CR as for one ended by LF. A chunk that runs past a function into top-level code is no longer inside it, and the check that tells (the lines after the function's last one are only blank or comment) cuts the file into lines: cut on LF alone a CR-only file is one line, that slice is empty, and the chunk is labelled with a function it runs out of. Fixture provenance: HAND-DERIVED. The six lines are written by hand, the function closes on line 4 and the chunk the index cuts is lines 1-6 (the trailing line is shorter than the 50 characters below which chunkFile folds a gap into the chunk before it, MIN_CHUNK_CHARS in src/embeddings.ts); the LF control beside the CR file shows the same chunk and the same label. Rows are skipped when the vector store or the embedding model is missing, and CI sets TOKEN_GOAT_MODEL_CACHE_DIR so they run there. */
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isAvailable } from '../src/embeddings.js'
import { modelFilesPresent } from '../src/embed_model.js'
import Database from '../src/sqlite_driver.js'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

// Whether the vector store and the embedding model are both usable here: without them `semantic` prints no stored chunk at all, so there is nothing to test.
function canExerciseRealEmbeddings(): boolean {
  try {
    const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
  } catch {
    return false
  }
  return isAvailable() && modelFilesPresent()
}

const LINES = [
  'export function getUserByEmail(input: string): { id: number } | null {',
  '  const match = ACCOUNTS.find((row) => row.contact === input)',
  '  return match ? { id: match.id } : null',
  '}',
  '',
  'seed(ACCOUNTS)',
]
const QUERY = 'look up an account using its email address'

const ENDINGS = [
  ['LF', '\n'],
  ['lone CR', '\r'],
] as const

interface SemanticItem {
  readonly filePath: string
  readonly name: string | null
  readonly startLine: number
  readonly endLine: number
  readonly preview: string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!canExerciseRealEmbeddings())('semantic on a chunk that runs past a function into top-level code', () => {
  it.each(ENDINGS)('labels it with no symbol when the lines end with %s', (_name, nl) => {
    const { root, project, env: baseEnv } = makeBundleProject('tg-cr-semantic-')
    roots.push(root)
    const env = { ...baseEnv, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_EMBEDDINGS_ENABLED: 'true' }
    fs.writeFileSync(path.join(project, 'users.ts'), LINES.join(nl) + nl)
    const idx = bundleTg(project, env, ['index', '.', '--walk'])
    expect(idx.status, idx.stderr).toBe(0)
    const res = bundleTg(project, env, ['semantic', QUERY, '--json'])
    expect(res.status, res.stderr).toBe(0)
    const items = (JSON.parse(res.stdout) as { items: SemanticItem[] }).items
    expect(items, 'semantic found nothing, so the row measures nothing').toHaveLength(1)
    const hit = items[0]!
    expect(hit.startLine).toBe(1)
    expect(hit.endLine, 'the chunk no longer runs past the function, so the row cannot tell the two line counts apart').toBe(6)
    expect(hit.name).toBeNull()
  })
})
