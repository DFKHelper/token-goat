/** `install` queues the project it runs in for a first index (src/install_index.ts). Before it, a fresh install indexed nothing, because session start reconciles only a project that was indexed, so every surgical read answered empty until the user ran `token-goat index` themselves. Why didn't a test catch this: nothing asserted what the index holds after an install. Install tests assert on settings files, and the indexing tests all start by calling `index` themselves, which is the step a new user never took. The first case below drives the shipped default with the env opt-out unset and the real worker drain with no injected indexer, and asserts a known symbol resolves; the last two spawn the built bundle's `install`. PROVENANCE: HAND-DERIVED. One-function TypeScript files and marker files written by the test; the queue and symbols are read back through the same modules the product uses. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultConfig, saveConfig } from '../src/config.js'
import { dataDir, globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { appendDirtyQueuePaths, dirtyQueuePathFor } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { formatInstallIndexResult, queueInstallIndex, type InstallIndexResult } from '../src/install_index.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce } from '../src/worker.js'
import { rmInSandbox } from './helpers/sandbox-rm.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')

let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env['TOKEN_GOAT_INSTALL_INDEX']
  // tests/setup/isolate-home.ts pins this off for every other file; the shipped default is on, so it is unset here.
  delete process.env['TOKEN_GOAT_INSTALL_INDEX']
  fs.rmSync(dirtyQueuePathFor(dataDir()), { force: true })
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env['TOKEN_GOAT_INSTALL_INDEX']
  else process.env['TOKEN_GOAT_INSTALL_INDEX'] = savedEnv
  closeAllDbs()
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
}

/** A git project outside the OS temp dir (the queue refuses paths under it) with one tracked TypeScript file declaring `name`. */
function gitProject(name: string): { dir: string; file: string } {
  const dir = indexableDir()
  const file = path.join(dir, `${name}.ts`)
  fs.writeFileSync(file, `export function ${name}(): number {\n  return 1\n}\n`)
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  return { dir, file }
}

function queued(): string[] {
  const queue = dirtyQueuePathFor(dataDir())
  if (!fs.existsSync(queue)) return []
  return fs.readFileSync(queue, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

const norm = (p: string): string => normalizePath(fs.realpathSync(p))

describe('queueInstallIndex', () => {
  it('queues an unindexed git project by default, and the real worker drain makes its symbols resolve', () => {
    const { dir, file } = gitProject('installIndexProbe')
    expect(querySymbols({ name: 'installIndexProbe' }, globalDbPath()), 'the fixture symbol was indexed before install ran').toHaveLength(0)

    const result = queueInstallIndex(dir)
    expect(result).toMatchObject({ status: 'queued', files: 1 })
    expect(queued().map(norm)).toEqual([norm(file)])

    // No injected indexer: this is the production default path the worker runs.
    expect(drainOnce(dataDir())).toBe(1)
    const hits = querySymbols({ name: 'installIndexProbe' }, globalDbPath())
    expect(hits.map((h) => norm(h.filePath))).toEqual([norm(file)])

    // A reinstall in the same project leaves it to session start's reconcile, and says nothing.
    const again = queueInstallIndex(dir)
    expect(again).toMatchObject({ status: 'skipped', reason: 'indexed' })
    expect(formatInstallIndexResult(again)).toBeNull()
  })

  // HAND-DERIVED: the one queued file stands in for what the edit hook queues after an Edit in a project nobody indexed; the drain is the worker's own, with its production indexer.
  it('still queues a project whose only symbols came from one file the edit hook had the worker index', () => {
    const { dir, file } = gitProject('editedOnlyProbe')
    const untouched = path.join(dir, 'untouched.ts')
    fs.writeFileSync(untouched, 'export function untouchedProbe(): number {\n  return 2\n}\n')
    git(dir, 'add', '.')
    appendDirtyQueuePaths(dataDir(), [file])
    expect(drainOnce(dataDir())).toBe(1)
    expect(querySymbols({ name: 'editedOnlyProbe' }, globalDbPath()), 'calibration: the edited file is indexed').toHaveLength(1)

    expect(queueInstallIndex(dir)).toMatchObject({ status: 'queued', files: 1 })
    expect(queued().map(norm)).toEqual([norm(untouched)])
  })

  it('queues nothing when TOKEN_GOAT_INSTALL_INDEX=0 or --no-index turned it off', () => {
    const { dir } = gitProject('installIndexOff')
    process.env['TOKEN_GOAT_INSTALL_INDEX'] = '0'
    expect(queueInstallIndex(dir)).toEqual({ status: 'skipped', reason: 'disabled' })
    delete process.env['TOKEN_GOAT_INSTALL_INDEX']
    expect(queueInstallIndex(dir, { enabled: false })).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(queued()).toEqual([])
  })

  it('says a folder with no project marker is not a project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-index-bare-'))
    try {
      expect(queueInstallIndex(dir)).toEqual({ status: 'skipped', reason: 'no-project' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a project rooted at the home directory', () => {
    const home = os.homedir()
    fs.mkdirSync(path.join(home, '.git'), { recursive: true })
    try {
      expect(queueInstallIndex(home)).toMatchObject({ status: 'skipped', reason: 'broad-root' })
    } finally {
      rmInSandbox(path.join(home, '.git'))
    }
    expect(queued()).toEqual([])
  })

  it('skips a project under the OS temp dir, whose paths the queue would refuse anyway', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-index-temp-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
      git(dir, 'init', '-q')
      git(dir, 'add', '.')
      expect(queueInstallIndex(dir)).toMatchObject({ status: 'skipped', reason: 'temp' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a project under worker.blocked_roots', () => {
    const { dir } = gitProject('installIndexBlocked')
    const cfg = defaultConfig()
    cfg.worker.blocked_roots = [dir]
    saveConfig(cfg)
    try {
      expect(queueInstallIndex(dir)).toMatchObject({ status: 'skipped', reason: 'blocked' })
    } finally {
      saveConfig(defaultConfig())
    }
    expect(queued()).toEqual([])
  })

  it('names `index --walk` for a project that is not a git repository', () => {
    const dir = indexableDir()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
    // indexableDir sits inside this repository, so the marker has to be the nearest one: findProject stops at the first.
    const result = queueInstallIndex(dir)
    expect(result).toMatchObject({ status: 'skipped', reason: 'not-git' })
    expect(formatInstallIndexResult(result)).toContain('token-goat index --walk')
  })

  // HAND-DERIVED: a just-initialised repository (git init, nothing added) is a git repository, so telling the user it is not one is false. The one untracked file and the git init are written by the test; the expected reason and wording come from the task's stated behavior, not from the implementation.
  it('says a freshly initialised repository with only untracked files is a git repository, not that it is not one', () => {
    const dir = indexableDir()
    fs.writeFileSync(path.join(dir, 'fresh.ts'), 'export const fresh = 1\n')
    git(dir, 'init', '-q')
    const result = queueInstallIndex(dir)
    expect(result).toMatchObject({ status: 'skipped', reason: 'untracked' })
    const msg = formatInstallIndexResult(result)
    expect(msg).toContain('index --walk')
    expect(msg).toContain('git add')
    expect(msg).not.toContain('not a git repository')
    expect(queued()).toEqual([])
  })
})

describe('formatInstallIndexResult', () => {
  it('prints one line for work queued, a failure, and each skip a user can act on, and nothing otherwise', () => {
    const line = (r: InstallIndexResult): string | null => formatInstallIndexResult(r)
    expect(line({ status: 'queued', root: '/p', files: 2 })).toBe('Indexing /p in the background (2 files queued); `token-goat doctor` shows progress.')
    expect(line({ status: 'queued', root: '/p', files: 1 })).toContain('(1 file queued)')
    expect(line({ status: 'failed', error: 'boom' })).toContain('boom')
    for (const reason of ['no-project', 'broad-root', 'temp'] as const) expect(line({ status: 'skipped', reason })).toContain('token-goat index')
    expect(line({ status: 'skipped', reason: 'untracked', root: '/p' })).toContain('index --walk')
    expect(line({ status: 'skipped', reason: 'blocked', root: '/p' })).toContain('worker.blocked_roots')
    for (const reason of ['disabled', 'indexed', 'nothing-queued'] as const) expect(line({ status: 'skipped', reason, root: '/p' })).toBeNull()
  })

  // HAND-DERIVED: each reason's remedy differs (temp and broad-root can still be indexed by hand, no-project has nothing to index), so the three messages must not share wording.
  it('distinguishes temp from other skipped reasons with its own message', () => {
    const msg = formatInstallIndexResult({ status: 'skipped', reason: 'temp', root: '/some/temp/project' })
    expect(msg).toContain('/some/temp/project')
    expect(msg).toContain('token-goat index')
    expect(msg).toContain('system temp directory')
    expect(msg).not.toContain('No project here')
  })

  it('distinguishes broad-root from other skipped reasons with its own message', () => {
    const msg = formatInstallIndexResult({ status: 'skipped', reason: 'broad-root', root: '/home/user' })
    expect(msg).toContain('/home/user')
    expect(msg).toContain('token-goat index')
    expect(msg).toContain('too broad')
    expect(msg).not.toContain('No project here')
  })

  it('keeps the no-project message unchanged', () => {
    const msg = formatInstallIndexResult({ status: 'skipped', reason: 'no-project' })
    expect(msg).toContain('No project here')
    expect(msg).toContain('token-goat index')
  })
})

describe('the built bundle', () => {
  function installIn(dir: string, extra: string[], env: NodeJS.ProcessEnv = {}): { out: string; home: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-index-home-'))
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      LOCALAPPDATA: home,
      XDG_DATA_HOME: home,
      TOKEN_GOAT_HOME: path.join(home, 'tg'),
      TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      ...env,
    }
    delete e['TOKEN_GOAT_INSTALL_INDEX']
    if (env['TOKEN_GOAT_INSTALL_INDEX'] !== undefined) e['TOKEN_GOAT_INSTALL_INDEX'] = env['TOKEN_GOAT_INSTALL_INDEX']
    const r = spawnSync(process.execPath, [BUNDLE, 'install', ...extra], { cwd: dir, encoding: 'utf-8', env: e })
    expect(r.status, `install exited ${r.status}\n${r.stderr}`).toBe(0)
    return { out: r.stdout, home }
  }

  /** The data dir is platform-shaped (LOCALAPPDATA on Windows, XDG_DATA_HOME on Linux, ~/Library on macOS), so the queue is found under the isolated home rather than its path rebuilt per platform here. */
  function bundleQueue(home: string): string[] {
    const hits = (fs.readdirSync(home, { recursive: true }) as string[]).filter((rel) => rel.replace(/\\/g, '/').endsWith('queue/dirty.txt'))
    expect(hits.length, `more than one dirty queue under ${home}: ${hits.join(', ')}`).toBeLessThanOrEqual(1)
    if (hits.length === 0) return []
    return fs.readFileSync(path.join(home, hits[0]!), 'utf-8').split('\n').filter((l) => l.trim() !== '')
  }

  it('install queues the project it runs in and says so', () => {
    const { dir, file } = gitProject('installIndexBundle')
    const { out, home } = installIn(dir, [])
    try {
      expect(out).toContain('in the background (1 file queued)')
      expect(bundleQueue(home).map(norm)).toEqual([norm(file)])
    } finally {
      rmInSandbox(home)
    }
  })

  it('install --no-index queues nothing and prints no indexing line', () => {
    const { dir } = gitProject('installIndexBundleOff')
    const { out, home } = installIn(dir, ['--no-index'])
    try {
      expect(out).not.toContain('in the background')
      expect(bundleQueue(home)).toEqual([])
    } finally {
      rmInSandbox(home)
    }
  })
})
