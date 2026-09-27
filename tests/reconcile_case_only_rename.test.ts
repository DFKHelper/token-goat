/** `token-goat reconcile` must notice a case-only rename made while no hook was watching. On a case-insensitive filesystem `git mv beta.ts Beta.ts` leaves the file's bytes as they were, and `git mv` leaves its mtime alone too, so every check the sweep made (parser stamp, embedding stamp, mtime, content) passed. The row kept the old spelling and `symbol betaFn` went on answering `beta.ts` for a file that git and the disk both spell `Beta.ts`. The drain and `token-goat index` correct a stale spelling once a file reaches them (`indexedPathSpellingIsStale`), but nothing brings a renamed, unedited file to either, and the session-start sweep called the project clean. Why didn't a test catch this: every reconcile test drifts a file by its bytes, its parser stamp or its existence, and the case-rename tests drive `index` and the drain directly, never the sweep that has to hand them the file. The assertions hold on a case-sensitive filesystem as well, where the rename is a new path plus a deleted one: either way the sweep reports the drift and the drain leaves one row, spelled the new way. Provenance: CAPTURE. The rename is made by real git in a real repository indexed by the built bundle, the sweep is the bundle's own `reconcile`, and the drain is `drainOnce` with its real default indexer. The working directory typed in another case is a real one the bundle is started in, and the calibration reads the spelling it left in the row. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

interface Sweep {
  changed: string[]
  added: string[]
  removed: string[]
  enqueued: number
}

function run(projectDir: string, homeDir: string, args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function sweep(projectDir: string, homeDir: string, ...extra: string[]): Sweep {
  const r = run(projectDir, homeDir, ['reconcile', '--budget-ms', '30000', '--json', ...extra])
  try {
    return JSON.parse(r.out) as Sweep
  } catch {
    return expect.fail(`reconcile emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

function git(projectDir: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

// Searched for under the isolated home rather than rebuilt from dataDir()'s layout, so a layout change cannot turn "not found" into a silent pass.
function findDirtyQueue(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findDirtyQueue(full)
      if (found !== null) return found
    } else if (entry.name === 'dirty.txt') return full
  }
  return null
}

// Whether a process started in a directory spelled in another case reports that spelling as its working directory, which is what lets index rows carry it. Windows keeps the typed spelling; a case-sensitive filesystem has no such directory, and macOS reports the one on disk.
function cwdKeepsTypedCase(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'tg-CwdCaseProbe-'))
  try {
    const typed = dir.toLowerCase()
    if (typed === dir || !existsSync(typed)) return false
    return spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: typed, encoding: 'utf-8' }).stdout === typed
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const lastSegment = (p: string): string | undefined => p.replace(/\\/g, '/').split('/').pop()

describe('reconcile after a case-only rename', () => {
  it('reports the renamed file, and the drain leaves one row spelled the new way', async () => {
    const projectDir = indexableDir()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-rename-home-'))
    writeFileSync(join(projectDir, 'beta.ts'), 'export function betaFn(): number {\n  return 2\n}\n')
    git(projectDir, 'init', '-q')
    git(projectDir, 'config', 'user.email', 't@example.com')
    git(projectDir, 'config', 'user.name', 'T')
    git(projectDir, 'add', '-A')
    git(projectDir, 'commit', '-q', '-m', 'init')
    const indexed = run(projectDir, homeDir, ['index', '.'])
    expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)

    // Calibration: the file is indexed under its first spelling and a sweep finds nothing yet, so whatever the sweep reports below is the rename's doing.
    expect(run(projectDir, homeDir, ['symbol', 'betaFn']).out).toContain('beta.ts')
    const clean = sweep(projectDir, homeDir, '--dry-run')
    expect([...clean.changed, ...clean.added, ...clean.removed], 'a freshly indexed project reported drift before anything was renamed').toEqual([])

    git(projectDir, 'mv', 'beta.ts', 'Beta.ts')
    expect(readdirSync(projectDir), 'git did not rename the file on disk').toContain('Beta.ts')

    const swept = sweep(projectDir, homeDir)
    expect([...swept.changed, ...swept.added].map(lastSegment), 'the sweep called the project clean after a case-only rename').toContain('Beta.ts')
    expect(swept.enqueued).toBeGreaterThan(0)

    const queueFile = findDirtyQueue(homeDir)
    expect(queueFile, 'the sweep reported drift but no dirty queue exists').not.toBeNull()
    // The daemon's own drain: no injected callbacks, so makeIndexer and makeRemover are the production defaults.
    drainOnce(dirname(dirname(queueFile as string)))
    await pendingEmbeddings()

    const dbPath = findGlobalDb(homeDir) as string
    // LIKE folds ASCII case, so this finds the row under either spelling, and a second row under the old one.
    const rows = getDb(dbPath).prepare("SELECT path FROM files WHERE path LIKE '%/beta.ts'").pluck().all() as string[]
    expect(rows.map(lastSegment), 'the index kept a spelling the file no longer has').toEqual(['Beta.ts'])
    expect(querySymbols({ name: 'betaFn' }, dbPath).map((s) => lastSegment(s.filePath))).toEqual(['Beta.ts'])
  })

  // The spelling check compares paths below the project root: compared whole, a directory spelled in another case above it would read as a rename of every file, and each sweep would send the whole project back through the drain.
  it.skipIf(!cwdKeepsTypedCase())('reports nothing when the index was built from a working directory typed in another case', () => {
    const projectDir = join(indexableDir(), 'CaseProj')
    mkdirSync(projectDir)
    const typed = projectDir.toLowerCase()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-cwdcase-home-'))
    writeFileSync(join(projectDir, 'beta.ts'), 'export function betaFn(): number {\n  return 2\n}\n')
    git(projectDir, 'init', '-q')
    git(projectDir, 'config', 'user.email', 't@example.com')
    git(projectDir, 'config', 'user.name', 'T')
    git(projectDir, 'add', '-A')
    git(projectDir, 'commit', '-q', '-m', 'init')
    const indexed = run(typed, homeDir, ['index', '.'])
    expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)

    // Calibration: the row carries the typed spelling, so the sweep below compares two spellings of one path rather than one spelling with itself.
    const rows = getDb(findGlobalDb(homeDir) as string).prepare('SELECT path FROM files').pluck().all() as string[]
    expect(rows).toEqual([normalizePath(join(typed, 'beta.ts'))])

    const swept = sweep(projectDir, homeDir, '--dry-run')
    expect([...swept.changed, ...swept.added, ...swept.removed], 'a directory spelled in another case above the project root read as a rename').toEqual([])
  })
})
