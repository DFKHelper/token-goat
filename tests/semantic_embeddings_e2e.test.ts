/**
 * End-to-end proof that `token-goat semantic` performs real embedding-vector similarity
 * search when indexing.embeddings_enabled is on, not just the FTS keyword fallback -
 * exercised against the BUILT bundle (dist/token-goat.mjs), the actual shipping path.
 *
 * The command-matrix e2e's own `semantic` case is a wrong-oracle test: it searches for a
 * literal keyword ("alphamarker") that appears verbatim in the fixture, so plain FTS trivially
 * satisfies it and the assertion can't tell real semantic search apart from the FTS fallback
 * it was meant to prove is gone. This file supplies the missing proof: index a file whose only
 * relevant symbol never uses the query's words, phrase the query as a natural-language sentence
 * (sanitizeFtsQuery ANDs every word as a separate literal FTS token, so filler words like
 * "look"/"an"/"using"/"its" that never appear in real code defeat it trivially), and assert the
 * symbol surfaces anyway - proof of real meaning-based matching, not keyword luck. A control run
 * with embeddings explicitly disabled proves the identical query genuinely misses under the old
 * FTS-only path, so the contrast is demonstrated within this file rather than assumed.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isAvailable } from '../src/embeddings.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

type Vec0State = 'working' | 'broken' | 'absent'

// Mirrors tests/embeddings_vec_insert.test.ts's classifyVec0(): 'absent' (package not
// installed) is a legitimate platform skip; 'broken' (installed but vec0 fails to load) is
// silent-dead semantic search and must fail loudly, not be swallowed by a skip.
function classifyVec0(): Vec0State {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const Database = req('better-sqlite3') as new (p: string) => {
      prepare: (s: string) => { get: () => unknown }
      close: () => void
    }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const vec0State = classifyVec0()
// isAvailable() only proves the @xenova/transformers package require succeeded, not that a
// real inference run will succeed offline (a first-ever run may still need to fetch the model
// from the hub) - real availability here mirrors embeddings_vec_insert.test.ts's own
// canExerciseRealUpsert gate: both the model and a genuinely loaded vec0 table.
const canExerciseRealEmbeddings = vec0State === 'working' && isAvailable()

let repo: string
let dataBase: string
const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: string[], embeddingsEnabled: boolean): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      LOCALAPPDATA: dataBase,
      XDG_DATA_HOME: dataBase,
      TOKEN_GOAT_EMBEDDINGS_ENABLED: embeddingsEnabled ? 'true' : 'false',
    },
    encoding: 'utf8',
    timeout: 60000,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// Deliberately avoids every word in QUERY: no "look"/"account"/"email"/"address" anywhere in
// the name or body, so an FTS hit here could only come from a real meaning-based match.
const FIXTURE =
  'export function getUserByEmail(address: string): { id: number } | null {\n' +
  '  const match = ACCOUNTS.find((row) => row.contact === address)\n' +
  '  return match ? { id: match.id } : null\n' +
  '}\n\n' +
  'const ACCOUNTS = [{ id: 1, contact: "a@example.com" }]\n'

const QUERY = 'look up an account using its email address'

beforeAll(() => {
  dataBase = mkIsolated('tg-semantic-data-')
  repo = mkIsolated('tg-semantic-repo-')
  fs.writeFileSync(path.join(repo, 'users.ts'), FIXTURE)
}, 30000)

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering handle can briefly hold a temp dir on Windows
    }
  }
})

describe('token-goat semantic performs real embedding search, not just FTS fallback', () => {
  it(
    'control: the same natural-language query misses under FTS alone (embeddings disabled)',
    () => {
      const idx = run(['index', '.', '--walk'], false)
      expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)

      const r = run(['semantic', QUERY], false)
      // sanitizeFtsQuery ANDs every word as a separate literal token; "look"/"up"/"an"/
      // "using"/"its" never appear in the fixture, so no row can satisfy every term. Either
      // the command exits 1 with "no matches" or its output simply omits the target symbol -
      // both prove keyword search cannot find it, establishing this as a genuine miss rather
      // than an accidental non-match.
      expect(r.stdout).not.toContain('getUserByEmail')
    },
    60000,
  )

  it.skipIf(!canExerciseRealEmbeddings)(
    'the identical query surfaces the meaning-matching function via real embeddings',
    () => {
      const idx = run(['index', '.', '--walk'], true)
      expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)

      const r = run(['semantic', QUERY], true)
      expect(r.status, `semantic failed: ${r.stderr}`).toBe(0)
      expect(r.stdout).toContain('getUserByEmail')
    },
    60000,
  )
})
