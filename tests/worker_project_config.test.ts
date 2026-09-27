/** The worker daemon runs in the temp directory (6aedcc74), so its argument-less loadConfig() reads the user config alone and a project's `.token-goat.toml` never reached the files the daemon indexes for that project. `indexing.embeddings_enabled` is the setting that costs: it is not locked against project files, and docs/architecture-qa.html offers a checked-in `[indexing] embeddings_enabled = false` as the way to keep background indexing off the CPU. With the daemon ignoring it, a drain embedded every file the project had turned off, and the idle sweep read each `disabled:` stamp that `token-goat index` run in the project wrote as a missing embed, so the two undid each other on every run. Driven on the real default wiring, drainOnce and runWorkerLoop with their own indexer, from the temp directory the daemon runs in; only the embedding backend is stubbed, as tests/worker_embed_backlog_survives_a_stop.test.ts does. PROVENANCE: HAND-DERIVED. One-function source files and a two-line project config, the one the documentation prints. The expected stamp is FORMAT-DERIVED from `disabledEmbedSha`, the producer indexFileEmbeddings stamps with (src/parser.ts). */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, isAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { disabledEmbedSha } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, parseDirtyQueueLines, pendingEmbeddings, runWorkerLoop } from '../src/worker.js'

const EMBEDDINGS_OFF = '[indexing]\nembeddings_enabled = false\n'

/** Same probe tests/worker_embed_backlog_survives_a_stop.test.ts gates its sweep cases on: the sweep only runs once embeddings could actually be written. */
function vec0Works(): boolean {
  const req = createRequire(import.meta.url)
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.close()
    return true
  } catch {
    return false
  }
}

const canRunSweep = vec0Works() && isAvailable()

let TMP: string
let DB_PATH: string
let FLAT: string
let MONO: string
let OPEN: string
let prevEmbeddingsEnv: string | undefined
let cwdSpy: ReturnType<typeof vi.spyOn>

function writeFile(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return normalizePath(file)
}

function source(name: string): string {
  return `export function ${name}(): number {\n  return 1\n}\n`
}

function queue(...files: string[]): void {
  fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), files.map((f) => `${f}\n`).join(''))
}

function queuedPaths(): string[] {
  const file = path.join(TMP, 'queue', 'dirty.txt')
  return fs.existsSync(file) ? parseDirtyQueueLines(fs.readFileSync(file, 'utf8')) : []
}

/** The `files` row for `file`, matched without case because the index keys a path by its canonical spelling, which on Windows need not be the one this test built. */
function row(file: string): { path: string; sha: string; embed_sha: string | null } {
  const rows = getDb(DB_PATH).prepare('SELECT path, sha, embed_sha FROM files').all() as Array<{ path: string; sha: string; embed_sha: string | null }>
  const hit = rows.find((r) => r.path.toLowerCase() === file.toLowerCase())
  if (hit === undefined) throw new Error(`no files row for ${file}; rows: ${rows.map((r) => r.path).join(', ')}`)
  return hit
}

function setStamp(file: string, stamp: string | null): void {
  getDb(DB_PATH).prepare('UPDATE files SET embed_sha = ? WHERE path = ?').run(stamp, row(file).path)
}

beforeEach(() => {
  // Not under the OS temp dir: the idle sweep skips temp-dir paths, and these have to be ones it keeps. tests/.tg-* is gitignored.
  TMP = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.tg-worker-project-config-'))
  DB_PATH = path.join(TMP, 'global.db')
  // A single-package project with the setting at its root.
  writeFile(path.join(TMP, 'flat', 'package.json'), '{}\n')
  writeFile(path.join(TMP, 'flat', '.token-goat.toml'), EMBEDDINGS_OFF)
  FLAT = writeFile(path.join(TMP, 'flat', 'src', 'flat.ts'), source('flatFn'))
  // A monorepo: the setting sits at the repository root, and the package holding the file has its own package.json, which makes the package the nearest project root.
  writeFile(path.join(TMP, 'mono', 'package.json'), '{}\n')
  writeFile(path.join(TMP, 'mono', '.token-goat.toml'), EMBEDDINGS_OFF)
  writeFile(path.join(TMP, 'mono', 'packages', 'app', 'package.json'), '{}\n')
  MONO = writeFile(path.join(TMP, 'mono', 'packages', 'app', 'src', 'app.ts'), source('appFn'))
  // A project that says nothing, so the user config decides.
  writeFile(path.join(TMP, 'open', 'package.json'), '{}\n')
  OPEN = writeFile(path.join(TMP, 'open', 'src', 'open.ts'), source('openFn'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // tests/setup/isolate-home.ts forces embeddings off through the environment, which outranks a project file. Unset, the user config's default (on) is what a project file layers over.
  delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
  // Where the daemon runs: runDetachedWorkerDaemon chdirs to os.tmpdir() before its first drain.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir())
})

afterEach(() => {
  cwdSpy.mockRestore()
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('the worker drain, run from the temp directory', () => {
  it("stamps a file disabled when its project's .token-goat.toml turns embeddings off, and embeds one whose project says nothing", async () => {
    queue(FLAT, MONO, OPEN)
    expect(drainOnce(TMP)).toBe(3)
    await pendingEmbeddings()

    const open = row(OPEN)
    expect(open.embed_sha, 'calibration: the user config embeds, so the project file is the only thing that differs').not.toBe(disabledEmbedSha(open.sha))
    expect(open.embed_sha).not.toBeNull()
    const flat = row(FLAT)
    expect(flat.embed_sha).toBe(disabledEmbedSha(flat.sha))
    const mono = row(MONO)
    expect(mono.embed_sha, 'a package inside a monorepo answers to the configuration at the repository root').toBe(disabledEmbedSha(mono.sha))
  })
})

describe.skipIf(!canRunSweep)('the idle sweep, run from the temp directory', () => {
  it('leaves the disabled stamps `token-goat index` wrote in a project that turns embeddings off, while it embeds the backlog elsewhere', async () => {
    queue(FLAT, MONO, OPEN)
    drainOnce(TMP)
    await pendingEmbeddings()
    // The state `token-goat index` run inside each project leaves: its own files stamped disabled, and a file elsewhere whose embed a stopped worker dropped.
    for (const file of [FLAT, MONO]) setStamp(file, disabledEmbedSha(row(file).sha))
    setStamp(OPEN, null)

    let queuedOff = false
    let cycles = 0
    await runWorkerLoop(TMP, 10, () => {
      queuedOff ||= queuedPaths().some((p) => p.toLowerCase() === FLAT.toLowerCase() || p.toLowerCase() === MONO.toLowerCase())
      cycles += 1
      return cycles > 200 || (cycles % 5 === 0 && row(OPEN).embed_sha === row(OPEN).sha)
    })
    await pendingEmbeddings()

    expect(row(OPEN).embed_sha, 'calibration: the sweep ran and embedded the file whose project says nothing').toBe(row(OPEN).sha)
    expect(queuedOff, 'the sweep queued a file its own project keeps unembedded').toBe(false)
    expect(row(FLAT).embed_sha).toBe(disabledEmbedSha(row(FLAT).sha))
    expect(row(MONO).embed_sha).toBe(disabledEmbedSha(row(MONO).sha))
  })
})
