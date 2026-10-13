/** Regression: the Playwright CLI and the Playwright MCP server write every page snapshot to `.playwright-cli/` or `.playwright-mcp/` as `page-<timestamp>.yml`. The non-git walk skips hidden directories, but `index` lists a git repo through `git ls-files`, so a repo that committed its snapshots indexed them, and `search "updatedToolOutput WebSearch"` in this repo returned 8 of its 20 hits from two such files. Both tests drive the real default paths: `cmdIndex` over a real git repo, and the worker's own drain with no injected indexer. */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'
import { indexableDir, tempConfigPath } from './helpers/temp-config.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = tempConfigPath('tg-tool-output-dirs.toml')

import { cmdIndex } from '../src/cli.js'
import { invalidateConfigCache } from '../src/config.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { dataDir } from '../src/constants.js'
import { indexFileSync } from '../src/parser.js'
import { reconcileProject } from '../src/reconcile.js'
import { isToolOutputPath } from '../src/skip_scope.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

// Provenance: CAPTURE. The head of a real `.playwright-cli/page-*.yml` tracked in this repository, cut to a few nodes.
const SNAPSHOT = [
  '- main [ref=e2]:',
  '  - generic [ref=e3]:',
  '    - link "Open the Token-Goat README" [ref=e4] [cursor=pointer]:',
  '      - /url: ../README.md',
  '    - paragraph [ref=e6]: Approval demo / VS Code Copilot Chat',
  '',
].join('\n')

let TMP: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: TMP, stdio: 'ignore' })
}

function seed(): { app: string; snapshots: string[] } {
  const app = path.join(TMP, 'app.ts')
  fs.writeFileSync(app, 'export function zqToolOutputApp(): number {\n  return 1\n}\n')
  const snapshots = ['.playwright-cli', '.playwright-mcp'].map((dir) => {
    fs.mkdirSync(path.join(TMP, dir), { recursive: true })
    const file = path.join(TMP, dir, 'page-2026-08-06T20-03-09-007Z.yml')
    fs.writeFileSync(file, SNAPSHOT)
    return file
  })
  return { app, snapshots }
}

function snapshotRows(dbPath: string): number {
  const db = getDb(dbPath)
  const files = db.prepare("SELECT count(*) AS n FROM files WHERE path LIKE '%.playwright-%'").get() as { n: number }
  const chunks = db.prepare("SELECT count(*) AS n FROM chunks WHERE file_path LIKE '%.playwright-%'").get() as { n: number }
  return files.n + chunks.n
}

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tool-output-dirs-')))
  fs.writeFileSync(_testConfigPath, '')
  invalidateConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  invalidateConfigCache()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('isToolOutputPath', () => {
  it('matches a snapshot below the project root and nothing outside the two directories', () => {
    expect(isToolOutputPath('/repo/.playwright-cli/page-1.yml', '/repo')).toBe(true)
    expect(isToolOutputPath('/repo/web/.playwright-mcp/page-1.yml', '/repo')).toBe(true)
    expect(isToolOutputPath('/repo/playwright-cli/page-1.yml', '/repo')).toBe(false)
    expect(isToolOutputPath('/repo/.playwright-cli.yml', '/repo')).toBe(false)
    expect(isToolOutputPath('/home/.playwright-cli/repo/app.ts', '/home/.playwright-cli/repo')).toBe(false)
  })
})

describe('tool snapshot directories on the real indexing paths', () => {
  it('index leaves committed snapshots out of a git repo and still indexes its source', async () => {
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    seed()
    git('add', '-A')
    git('commit', '-qm', 'seed')
    const dbPath = path.join(TMP, 'index.db')

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await cmdIndex(TMP, { dbPath })

    expect(snapshotRows(dbPath)).toBe(0)
    expect(querySymbols({ name: 'zqToolOutputApp', limit: 10 }, dbPath).length).toBe(1)
  })

  it('the worker drain leaves a snapshot out when a hook enqueues it', async () => {
    const { app, snapshots } = seed()
    const dataDir = path.join(TMP, 'data')
    const queue = path.join(dataDir, 'queue', 'dirty.txt')
    fs.mkdirSync(path.dirname(queue), { recursive: true })
    fs.writeFileSync(queue, `${[app, ...snapshots].map((p) => normalizePath(p)).join('\n')}\n`)

    drainOnce(dataDir)
    await pendingEmbeddings()

    const dbPath = path.join(dataDir, 'global.db')
    expect(snapshotRows(dbPath)).toBe(0)
    expect(querySymbols({ name: 'zqToolOutputApp', limit: 10 }, dbPath).length).toBe(1)
  })

  it('the built bundle indexes the source and leaves a committed snapshot out', () => {
    git('init', '-q', '.')
    seed()
    // A top-level YAML key is a symbol, so a snapshot that reached the index would answer `symbol` for it.
    fs.writeFileSync(path.join(TMP, '.playwright-cli', 'page-2026-08-06T20-03-43-226Z.yml'), 'zqSnapshotKey: page\n')
    git('add', '-A')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'seed')
    const env = tgIsolatedEnv(path.join(TMP, 'home'), { TOKEN_GOAT_HOME: path.join(TMP, 'data'), TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' })
    const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
      const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: TMP, env, encoding: 'utf8', timeout: 120000 })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }

    const idx = run(['index', '.'])
    expect(idx.status, idx.stderr).toBe(0)
    expect(run(['symbol', 'zqToolOutputApp']).stdout).toContain('app.ts')
    const snap = run(['symbol', 'zqSnapshotKey'])
    expect(snap.status).toBe(1)
    expect(snap.stdout).not.toContain('.playwright-cli')
  }, 180000)

  // The rule is kept out of parser.ts so upgrading moves no parser fingerprint, which also means no upgrade reparse sweeps the old snapshot rows away: reconcile has to find them itself.
  it('reconcile re-queues a snapshot an older index still holds, and the drain purges it', async () => {
    const repo = indexableDir()
    fs.mkdirSync(path.join(repo, '.playwright-cli'))
    const snapshot = path.join(repo, '.playwright-cli', 'page-2026-08-06T20-03-09-007Z.yml')
    const fresh = path.join(repo, '.playwright-cli', 'page-2026-08-06T20-03-43-226Z.yml')
    fs.writeFileSync(snapshot, 'zqStaleSnapshotKey: page\n')
    fs.writeFileSync(fresh, 'zqFreshSnapshotKey: page\n')
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export function zqReconcileApp(): number {\n  return 1\n}\n')
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '-A'], { cwd: repo, stdio: 'ignore' })
    const dbPath = path.join(dataDir(), 'global.db')
    // An index written before the rule existed: indexFileSync itself has no tool-output check, so this is exactly the row such an index holds.
    indexFileSync(normalizePath(snapshot), dbPath)
    indexFileSync(normalizePath(path.join(repo, 'app.ts')), dbPath)
    expect(querySymbols({ name: 'zqStaleSnapshotKey', limit: 10 }, dbPath).length).toBe(1)

    const result = reconcileProject({ cwd: repo, dbPath })
    expect(result.changed.map((f) => normalizePath(f))).toContain(normalizePath(snapshot))
    // A snapshot that never reached the index is no drift.
    expect(result.added.map((f) => normalizePath(f))).not.toContain(normalizePath(fresh))

    drainOnce(dataDir())
    await pendingEmbeddings()
    expect(querySymbols({ name: 'zqStaleSnapshotKey', limit: 10 }, dbPath).length).toBe(0)
    expect(querySymbols({ name: 'zqFreshSnapshotKey', limit: 10 }, dbPath).length).toBe(0)
    expect(querySymbols({ name: 'zqReconcileApp', limit: 10 }, dbPath).length).toBe(1)
  })
})
