import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyParts, MAX_ENTRIES, readEntries, recordGreen, runChecked, splitGreen, STATIC_LEG, treeId } from '../scripts/prepush-green.mjs'

const REPO = process.cwd()
const TOOL = path.join(REPO, 'scripts', 'prepush-green.mjs')
const GIT_VARS = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']
const saved: Record<string, string | undefined> = {}
let root = ''
let store = ''

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', ...args], { cwd: root, encoding: 'utf8' }).trim()
}

function write(rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

// The hook knobs stay out of the checked environment, so only what a test sets reaches the tool
function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TG_)?PREPUSH_|^TG_PREPUSH_NO_REUSE$/.test(k) && !GIT_VARS.includes(k)))
  return { ...base, PREPUSH_GREEN_STORE: store, ...extra }
}

// A command that appends one line to a counter file each time it really runs
function counterCmd(extra = ''): string[] {
  write('count.mjs', `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(path.join(root, 'ran.txt').replace(/\\/g, '/'))}, 'x\\n')\n${extra}`)
  return ['node', path.join(root, 'count.mjs').replace(/\\/g, '/')]
}

const runs = (): number => (existsSync(path.join(root, 'ran.txt')) ? readFileSync(path.join(root, 'ran.txt'), 'utf8').split('\n').filter(Boolean).length : 0)

beforeEach(() => {
  for (const k of GIT_VARS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  root = mkdtempSync(path.join(tmpdir(), 'tg-green-'))
  store = path.join(root, '.green-store', 'green.json')
  git('init', '-q')
  write('.gitignore', 'ran.txt\nignored.txt\n.green-store/\n')
  write('src/a.ts', 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(`${root}-lists`, { recursive: true, force: true })
  for (const k of GIT_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('treeId', () => {
  it('is stable for an unchanged tree and leaves the real index alone', () => {
    const before = readFileSync(path.join(root, '.git', 'index'))
    const a = treeId(root)
    expect(a).toMatch(/^[0-9a-f]{40,64}$/)
    expect(treeId(root)).toBe(a)
    expect(readFileSync(path.join(root, '.git', 'index')).equals(before)).toBe(true)
    expect(git('status', '--porcelain')).toBe('')
    expect(readdirSync(path.join(root, '.git')).filter((n) => n.endsWith('.index'))).toEqual([])
  })

  it('changes when an unstaged tracked file is edited', () => {
    const before = treeId(root)
    write('src/a.ts', 'export const a = 2\n')
    expect(git('diff', '--name-only')).toBe('src/a.ts')
    expect(treeId(root)).not.toBe(before)
  })

  it('changes when an untracked file appears, and not for an ignored one', () => {
    const before = treeId(root)
    write('ignored.txt', 'noise\n')
    expect(treeId(root)).toBe(before)
    write('src/new.ts', 'export const n = 1\n')
    expect(treeId(root)).not.toBe(before)
  })

  it('is null outside a repository', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'tg-green-plain-'))
    try {
      expect(treeId(plain)).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('runChecked', () => {
  it('runs once, then reuses the green result and says so', () => {
    const cmd = counterCmd()
    expect(runChecked(root, 'lint', STATIC_LEG, cmd, envWith())).toBe(0)
    expect(runs()).toBe(1)
    expect(runChecked(root, 'lint', STATIC_LEG, cmd, envWith())).toBe(0)
    expect(runs()).toBe(1)
  })

  it('runs again when an unstaged edit or an untracked file moves the tree', () => {
    const cmd = counterCmd()
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    write('src/a.ts', 'export const a = 3\n')
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    expect(runs()).toBe(2)
    write('src/untracked.ts', 'export const u = 1\n')
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    expect(runs()).toBe(3)
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    expect(runs()).toBe(3)
  })

  it('reuses only the exact check name and the exact leg', () => {
    const cmd = counterCmd()
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    runChecked(root, 'typecheck', STATIC_LEG, cmd, envWith())
    expect(runs()).toBe(2)
    runChecked(root, 'lint', 'win', cmd, envWith())
    expect(runs()).toBe(3)
  })

  it('records nothing for a failed command', () => {
    write('fail.mjs', 'process.exit(3)\n')
    const cmd = ['node', path.join(root, 'fail.mjs').replace(/\\/g, '/')]
    expect(runChecked(root, 'lint', STATIC_LEG, cmd, envWith())).toBe(3)
    expect(readEntries(store)).toEqual([])
  })

  it('records nothing when the tree moved during the run', () => {
    const touch = `import * as fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(path.join(root, 'src/a.ts').replace(/\\/g, '/'))}, '// moved\\n')\n`
    const cmd = counterCmd(touch)
    expect(runChecked(root, 'lint', STATIC_LEG, cmd, envWith())).toBe(0)
    expect(readEntries(store)).toEqual([])
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    expect(runs()).toBe(2)
  })

  it('PREPUSH_FULL=1 ignores the record and TG_PREPUSH_NO_REUSE=1 neither reads nor writes one', () => {
    const cmd = counterCmd()
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith({ PREPUSH_FULL: '1' }))
    expect(runs()).toBe(2)
    rmSync(path.dirname(store), { recursive: true, force: true })
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith({ TG_PREPUSH_NO_REUSE: '1' }))
    expect(existsSync(store)).toBe(false)
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
    runChecked(root, 'lint', STATIC_LEG, cmd, envWith({ TG_PREPUSH_NO_REUSE: '1' }))
    expect(runs()).toBe(5)
  })

  it('treats a corrupt record file as empty and replaces it with a sound one', () => {
    mkdirSync(path.dirname(store), { recursive: true })
    for (const bad of ['{"entries": [', 'null', '{"entries": [{"tree": 1}]}', '']) {
      writeFileSync(store, bad)
      rmSync(path.join(root, 'ran.txt'), { force: true })
      const cmd = counterCmd()
      runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
      expect(runs()).toBe(1)
      expect(readEntries(store)).toHaveLength(1)
      runChecked(root, 'lint', STATIC_LEG, cmd, envWith())
      expect(runs()).toBe(1)
    }
  })

  it('a changed env knob, node version or dependency record changes the key', () => {
    const base = keyParts(root, STATIC_LEG, {})
    expect(keyParts(root, STATIC_LEG, { TG_SOMETHING: '1' }).env).not.toBe(base.env)
    expect(keyParts(root, STATIC_LEG, { PREPUSH_FULL: '1', TG_PREPUSH_WSL: '1' })).toEqual(base)
    write('node_modules/.package-lock.json', '{"a":1}')
    const withDeps = keyParts(root, STATIC_LEG, {})
    expect(withDeps.deps).not.toBe(base.deps)
    write('node_modules/.package-lock.json', '{"a":2}')
    expect(keyParts(root, STATIC_LEG, {}).deps).not.toBe(withDeps.deps)
    expect(base.node).toBe(process.version)
    expect(base.platform).toBe(process.platform)
  })

  it('keys the built bundle for a test leg only', () => {
    write('dist/x.mjs', 'one')
    const a = keyParts(root, 'win', {})
    write('dist/x.mjs', 'two')
    expect(keyParts(root, 'win', {}).dist).not.toBe(a.dist)
    expect(keyParts(root, STATIC_LEG, {}).dist).toBe('n/a')
  })
})

describe('the record file', () => {
  it('keeps at most the cap, newest entries', () => {
    const parts = keyParts(root, STATIC_LEG, {})
    for (let i = 0; i < MAX_ENTRIES + 5; i++) recordGreen(store, `tree${i}`.padEnd(40, '0'), parts, ['lint'], 1000 + i)
    const entries = readEntries(store)
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]?.tree.startsWith('tree5')).toBe(true)
    expect(readFileSync(store).length).toBeLessThan(32 * 1024)
  })

  it('sweeps only its own temp files left stale by a crashed write', () => {
    const parts = keyParts(root, STATIC_LEG, {})
    mkdirSync(path.dirname(store), { recursive: true })
    const stale = `${store}.4242.0a1b2c3d.tmp`
    const fresh = `${store}.4243.0a1b2c3e.tmp`
    const foreign = path.join(path.dirname(store), 'other.json.4242.0a1b2c3d.tmp')
    for (const f of [stale, fresh, foreign]) writeFileSync(f, 'partial')
    const old = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(foreign, old, old)
    recordGreen(store, 'a'.repeat(40), parts, ['lint'])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(readEntries(store)).toHaveLength(1)
  })

  it('stays parseable while several writers race', async () => {
    const parts = keyParts(root, STATIC_LEG, {})
    write('racer.mjs', `import { recordGreen } from ${JSON.stringify(`file:///${TOOL.replace(/\\/g, '/')}`)}\nrecordGreen(process.argv[2], process.argv[3], JSON.parse(process.argv[4]), ['lint'])\n`)
    const racers = Array.from({ length: 6 }, (_, i) => new Promise<void>((resolve) => {
      const child = spawn('node', [path.join(root, 'racer.mjs'), store, `t${i}`.padEnd(40, '0'), JSON.stringify(parts)], { stdio: 'ignore' })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    }))
    await Promise.all(racers)
    const text = readFileSync(store, 'utf8')
    expect(() => JSON.parse(text)).not.toThrow()
    expect(readEntries(store).length).toBeGreaterThan(0)
    expect(readdirSync(path.dirname(store)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('test file reuse', () => {
  const parts = (leg: string) => keyParts(root, leg, {})

  it('drops the files already green on the key and the guard files when guards were green', () => {
    const tree = 'a'.repeat(40)
    recordGreen(store, tree, parts('win'), ['tests/a.test.ts'])
    recordGreen(store, tree, { ...parts(STATIC_LEG), dist: parts('win').dist }, ['guards'])
    const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/guards/g.test.ts']
    expect(splitGreen(files, readEntries(store), tree, parts('win'), parts(STATIC_LEG))).toEqual({ keep: ['tests/b.test.ts'], reused: ['tests/a.test.ts', 'tests/guards/g.test.ts'] })
    expect(splitGreen(files, readEntries(store), 'b'.repeat(40), parts('win'), parts(STATIC_LEG)).reused).toEqual([])
    expect(splitGreen(files, readEntries(store), tree, parts('wsl'), parts(STATIC_LEG)).keep).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])
  })

  it('reuses a guard file only while the bundle the guards read is unchanged', () => {
    write('.gitignore', 'ran.txt\nignored.txt\n.green-store/\ndist/\n')
    write('dist/x.mjs', 'one')
    git('add', '-A')
    git('commit', '-q', '-m', 'bundle')
    const cmd = counterCmd()
    const tree = treeId(root) ?? ''
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(runChecked(root, 'guards', STATIC_LEG, cmd, envWith())).toBe(0)
    expect(runs()).toBe(1)
    const guardFile = ['tests/guards/g.test.ts']
    // The run's env is keyed too, so the split is judged under the same env the record was written with.
    const keys = (leg: string) => keyParts(root, leg, envWith())
    expect(splitGreen(guardFile, readEntries(store), tree, keys('win'), keys(STATIC_LEG)).reused).toEqual(guardFile)
    write('dist/x.mjs', 'two')
    expect(treeId(root)).toBe(tree)
    expect(splitGreen(guardFile, readEntries(store), tree, keys('win'), keys(STATIC_LEG)).keep).toEqual(guardFile)
  })

  it('keys a record by the checkout root, so another worktree never honours it', () => {
    const tree = 'a'.repeat(40)
    recordGreen(store, tree, parts('win'), ['tests/a.test.ts'])
    expect(parts('win').root).toMatch(/^(?:[a-z]:)?\//)
    expect(parts('win').root).not.toContain('\\')
    expect(splitGreen(['tests/a.test.ts'], readEntries(store), tree, { ...parts('win'), root: 'd:/elsewhere' }, parts(STATIC_LEG)).reused).toEqual([])
    expect(splitGreen(['tests/a.test.ts'], readEntries(store), tree, parts('win'), parts(STATIC_LEG)).reused).toEqual(['tests/a.test.ts'])
  })

  it('the filter and record-files commands round-trip through the real tool', () => {
    // outside the repository, as the hook's log dir is, so these files do not move the tree
    mkdirSync(`${root}-lists`, { recursive: true })
    const list = path.join(`${root}-lists`, 'focus.txt')
    const treeFile = path.join(`${root}-lists`, 'tree.txt')
    const run = (...a: string[]): string => execFileSync('node', [TOOL, ...a], { cwd: root, encoding: 'utf8', env: envWith() })
    writeFileSync(list, 'tests/a.test.ts\ntests/b.test.ts\n')
    expect(run('filter', 'win', list, treeFile)).toBe('')
    expect(readFileSync(list, 'utf8')).toBe('tests/a.test.ts\ntests/b.test.ts\n')
    run('record-files', 'win', list, treeFile)
    writeFileSync(list, 'tests/a.test.ts\ntests/b.test.ts\ntests/c.test.ts\n')
    const out = run('filter', 'win', list, treeFile)
    expect(out).toContain('reused 2 green test file(s)')
    expect(readFileSync(list, 'utf8')).toBe('tests/c.test.ts\n')
    writeFileSync(list, 'tests/a.test.ts\n')
    run('filter', 'win', list, treeFile)
    expect(readFileSync(list, 'utf8')).toBe('')
    write('src/a.ts', 'export const a = 9\n')
    writeFileSync(list, 'tests/a.test.ts\n')
    run('filter', 'win', list, treeFile)
    expect(readFileSync(list, 'utf8')).toBe('tests/a.test.ts\n')
  })

  it('record-files writes nothing when the tree moved since the filter', () => {
    mkdirSync(`${root}-lists`, { recursive: true })
    const list = path.join(`${root}-lists`, 'focus.txt')
    const treeFile = path.join(`${root}-lists`, 'tree.txt')
    const run = (...a: string[]): string => execFileSync('node', [TOOL, ...a], { cwd: root, encoding: 'utf8', env: envWith() })
    writeFileSync(list, 'tests/a.test.ts\n')
    run('filter', 'win', list, treeFile)
    write('src/a.ts', 'export const a = 5\n')
    run('record-files', 'win', list, treeFile)
    expect(readEntries(store)).toEqual([])
  })
})
