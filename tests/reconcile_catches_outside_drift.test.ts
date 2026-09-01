/**
 * `token-goat reconcile` finds files that changed while no hook was watching, and queues them.
 *
 * Every other freshness mechanism in this repo is hook-driven, so it only sees drift that happened
 * during a session token-goat was part of. This one exists for the rest: a pull in another
 * terminal, an IDE save, a codegen step run outside the harness. The failure it guards against is
 * a stale index answering a `semantic`/`symbol`/`refs` query, none of which name a file and so
 * none of which trip the per-file self-heal -- a stale answer there is shaped exactly like a
 * correct one.
 *
 * Two properties matter more than "it detects a change", and both have cases below:
 *  - it must NOT enqueue on a moved mtime alone, because `git checkout` rewrites mtimes wholesale
 *    and a sweep that trusted them would queue the whole repository on every branch switch;
 *  - a budget-truncated sweep must not report deletions, because every file it never got to looks
 *    exactly like one that is indexed and gone.
 *
 * Provenance: CAPTURE. Every expectation is measured from a real run of the built bundle against a
 * real indexed temp project. The drift is created by writing to the file on disk directly, which
 * is the same thing an out-of-session editor does, rather than through any token-goat code path.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function json(args: string[]): Record<string, unknown> {
  const r = run([...args, '--json'])
  try {
    return JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return expect.fail(`\`${args.join(' ')} --json\` emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

/**
 * Every path currently sitting in the dirty queue, or [] when the queue file does not exist.
 *
 * The queue is located by searching the isolated home rather than by rebuilding `dataDir()`'s
 * layout here: a hardcoded path copied from the implementation would silently stop finding the
 * file if that layout changed, and an empty result reads exactly like "nothing was queued" -- so
 * the test would go green on the very change that broke it.
 */
function findDirtyQueue(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findDirtyQueue(full)
      if (found !== null) return found
    } else if (entry.name === 'dirty.txt') return full
  }
  return null
}

function dirtyQueue(): string[] {
  if (!existsSync(homeDir)) return []
  const queue = findDirtyQueue(homeDir)
  if (queue === null) return []
  return readFileSync(queue, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-home-'))

  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(projectDir, `mod${i}.ts`), `export function mod${i}(): number {\n  return ${i}\n}\n`)
  }
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  const indexed = run(['index', '.'])
  expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)
})

describe('reconcile', () => {
  it('reports a freshly indexed project as clean, so a later "drift found" means something', () => {
    // Calibration. A sweep that reported drift unconditionally -- because it scoped the index query
    // wrongly, say, and saw every tracked file as unindexed -- would pass every detection case
    // below while being completely broken.
    const r = json(['reconcile', '--dry-run'])
    expect(r.scanned, 'the sweep examined no files; it is not seeing the fixture at all').toBeGreaterThan(0)
    expect(r.changed, 'a freshly indexed project reported changed files').toEqual([])
    expect(r.added, 'a freshly indexed project reported unindexed files').toEqual([])
    expect(r.removed, 'a freshly indexed project reported deleted files').toEqual([])
  })

  it('detects a file edited outside any session', () => {
    writeFileSync(join(projectDir, 'mod1.ts'), 'export function mod1(): number {\n  return 999\n}\n')
    const r = json(['reconcile', '--dry-run'])
    expect((r.changed as string[]).map((p) => p.replace(/\\/g, '/').split('/').pop())).toEqual(['mod1.ts'])
  })

  it('leaves a file alone when only its timestamp moved', () => {
    // This is the `git checkout` round trip: mtimes rewritten wholesale, content identical. A sweep
    // that took a moved mtime as proof of change would queue the entire repository on every branch
    // switch, which is worse than the staleness it set out to fix.
    const target = join(projectDir, 'mod2.ts')
    const before = statSync(target)
    const future = new Date(before.mtimeMs + 60_000)
    utimesSync(target, future, future)
    expect(statSync(target).mtimeMs, 'the fixture mtime did not actually move; this case proves nothing').toBeGreaterThan(before.mtimeMs)

    const r = json(['reconcile', '--dry-run'])
    const changedNames = (r.changed as string[]).map((p) => p.replace(/\\/g, '/').split('/').pop())
    expect(changedNames, 'a timestamp-only touch was reported as a content change').not.toContain('mod2.ts')
    expect(r.mtimeOnly, 'the timestamp-only file was not counted as one').toBeGreaterThan(0)
  })

  it('names a file that was created outside any session', () => {
    writeFileSync(join(projectDir, 'brandnew.ts'), 'export const brandnew = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf-8' })
    const r = json(['reconcile', '--dry-run'])
    expect((r.added as string[]).map((p) => p.replace(/\\/g, '/').split('/').pop())).toContain('brandnew.ts')
  })

  it('queues the drift it found, and queues nothing under --dry-run', () => {
    const beforeQueue = dirtyQueue().length
    const dry = json(['reconcile', '--dry-run'])
    expect(dry.enqueued, '--dry-run enqueued paths').toBe(0)
    expect(dirtyQueue().length, '--dry-run wrote to the dirty queue').toBe(beforeQueue)

    const real = json(['reconcile'])
    expect(real.enqueued, 'the sweep found drift but enqueued nothing').toBeGreaterThan(0)
    const after = dirtyQueue()
    expect(after.length, 'nothing reached the dirty queue').toBeGreaterThan(beforeQueue)
    // Absolute paths, because the worker's SHA gate keys on the canonical absolute form: a relative
    // entry here would fill the queue with keys nothing can ever match, and the symptom would be a
    // queue that grows while the index silently never updates.
    for (const p of after) {
      expect(p, `dirty queue holds a non-absolute path: ${p}`).toMatch(/^([a-zA-Z]:[/\\]|\/)/)
    }
  })

  it('detects a file that is indexed but gone from disk', () => {
    rmSync(join(projectDir, 'mod3.ts'))
    spawnSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf-8' })
    const r = json(['reconcile', '--dry-run'])
    expect((r.removed as string[]).map((p) => p.replace(/\\/g, '/').split('/').pop())).toContain('mod3.ts')
  })

  it('reports no deletions at all when the budget cut the sweep short', () => {
    // A budget-limited pass never visited some tracked files, and each of those looks exactly like
    // "indexed but not on disk". Guessing there would queue live files for removal, so the sweep
    // reports nothing rather than a guess -- and says that it did.
    const r = json(['reconcile', '--dry-run', '--budget-ms', '0'])
    expect(r.budgetExhausted, 'a 0ms budget did not truncate the sweep; this case proves nothing').toBe(true)
    expect(r.removed, 'a truncated sweep reported deletions it could not have known about').toEqual([])
    expect(r.unscanned, 'the sweep truncated but claimed nothing was left unchecked').toBeGreaterThan(0)
  })

  it('discloses the truncation in its text output rather than reading as a complete sweep', () => {
    const r = run(['reconcile', '--dry-run', '--budget-ms', '0'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/budget/i)
    expect(r.out).toMatch(/unchecked/i)
  })

  it('exits 0 when it finds drift, so it can be chained ahead of another command', () => {
    writeFileSync(join(projectDir, 'mod4.ts'), 'export function mod4(): number {\n  return 4444\n}\n')
    const r = run(['reconcile', '--dry-run'])
    expect(r.code).toBe(0)
  })
})

/**
 * A directory git cannot enumerate is the one input where a deletion cannot be inferred at all.
 *
 * `getTrackedFiles` returns an empty list for a non-repository, for a missing git, and for a git
 * that errored -- and an empty tracked list against a populated index is numerically identical to
 * a project whose every file was deleted. Measured against the built bundle before the guard
 * existed: two live files on disk, both reported "indexed but gone from disk", both queued for
 * removal. Nothing failed; the index just lost working rows.
 *
 * Provenance: CAPTURE. The fixture is built here and the expectations come from running the real
 * bundle against it, not from reading `reconcile.ts`.
 */
describe('reconcile in a directory git cannot enumerate', () => {
  let dir: string
  let home: string

  const runHere = (args: string[]): { out: string; code: number } => {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home },
    })
    return { out: res.stdout ?? '', code: res.status ?? -1 }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-nongit-'))
    home = mkdtempSync(join(tmpdir(), 'tg-nongit-home-'))
    writeFileSync(join(dir, 'a.ts'), 'export function alpha(): number {\n  return 1\n}\n')
    writeFileSync(join(dir, 'b.ts'), 'export function beta(): number {\n  return 2\n}\n')
    // --walk, because the ordinary index path enumerates through git too and would leave the
    // index empty here -- which would make every assertion below pass for the wrong reason.
    const indexed = runHere(['index', '.', '--walk'])
    expect(indexed.code, 'indexing the non-git fixture failed').toBe(0)
  })

  it('has a populated index, so the assertions below are testing something', () => {
    // Calibration, and the exact trap this fixture invites: with an empty index there is nothing
    // to mistake for a deletion, and a broken guard would look perfect.
    const r = runHere(['symbol', 'alpha'])
    expect(r.out, 'the fixture index is empty; the deletion cases below prove nothing').toContain('alpha')
  })

  it('reports no deletions when git listed no files at all', () => {
    const r = runHere(['reconcile', '--dry-run', '--json'])
    const parsed = JSON.parse(r.out) as { removed: string[]; trackedUnavailable: boolean; scanned: number }
    expect(parsed.scanned, 'git enumerated nothing here, so nothing can have been scanned').toBe(0)
    expect(parsed.trackedUnavailable, 'the failed-enumeration state must be reported, not inferred from the counts').toBe(true)
    expect(parsed.removed, 'live files on disk were reported as deleted').toEqual([])
  })

  it('queues nothing for removal, which is what actually destroys index rows', () => {
    // Not --dry-run: the harm is in the queue, and a guard that only held under --dry-run would
    // leave the real path broken.
    const r = runHere(['reconcile', '--json'])
    const parsed = JSON.parse(r.out) as { enqueued: number }
    expect(parsed.enqueued, 'a live file was queued for removal').toBe(0)
  })

  it('does not claim the index matches disk over zero comparisons', () => {
    const r = runHere(['reconcile', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.out, '"Index matches disk" over a sweep that compared nothing is the confident wrong answer').not.toContain('Index matches disk')
    expect(r.out, 'the reason nothing was compared must be stated').toMatch(/git listed no files/)
  })
})
