/** Regression: `token-goat index` lowered its own scheduling priority before it listed the files, so the `git ls-files` child inherited the lowered class. That child does nothing but wait on the disk, yet on a busy machine it queued behind every busy process: an isolated `index . --walk` took 11.3 s against 1.6 s idle, and minutes on a real install. The demotion exists to keep the parse and embed work from competing with the user's editor, so it belongs after the file list exists. Driven through the real cmdIndex against a real repo and a real non-git folder; the ordering is read off the calls themselves, so the test does not depend on how fast or how loaded the host is. FORMAT-DERIVED: the spawn site is runGit in src/util.ts, the one place that starts git, and the priority call is process_priority.ts's os.setPriority. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessType from 'node:child_process'
import type * as OsType from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const events = vi.hoisted(() => ({ list: [] as string[] }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof OsType>()
  const setPriority = (_pid: number, priority: number): void => {
    events.list.push(`setPriority:${priority}`)
  }
  return { ...actual, default: { ...actual, setPriority }, setPriority }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessType>()
  const spawnSync = ((cmd: string, args: readonly string[], opts: never) => {
    if (cmd === 'git') events.list.push(`git:${args.filter((a) => !a.startsWith('-') && !a.includes('=')).join(' ')}`)
    return actual.spawnSync(cmd, args as string[], opts)
  }) as typeof actual.spawnSync
  return { ...actual, default: { ...actual, spawnSync }, spawnSync }
})

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'

let TMP: string

beforeEach(() => {
  events.list.length = 0
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-prio-')))
  fs.writeFileSync(path.join(TMP, 'a.ts'), 'export function zqPrio(): number {\n  return 1\n}\n')
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function runIndex(opts: Parameters<typeof cmdIndex>[1]): Promise<void> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await cmdIndex(TMP, opts)
  } finally {
    spy.mockRestore()
  }
}

describe('cmdIndex lowers its priority only after the file list exists', () => {
  it('lists the files with git before it asks for the lower class, in a folder git does not track', async () => {
    await runIndex({ dbPath: path.join(TMP, 'index.db'), walk: true, embed: false, embedBudgetMs: 0 })
    const firstLower = events.list.findIndex((e) => e.startsWith('setPriority:'))
    const lastList = events.list.map((e) => e.startsWith('git:ls-files')).lastIndexOf(true)
    expect(firstLower, `no priority call was made: ${events.list.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(lastList, `git ls-files never ran: ${events.list.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(firstLower, `the priority was lowered before git ls-files ran: ${events.list.join(' | ')}`).toBeGreaterThan(lastList)
  })

  it('does the same in a git repository, and still asks for the default below-normal class', async () => {
    const { execFileSync } = await import('node:child_process')
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: TMP, stdio: 'ignore' })
    }
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    git('add', '-A')
    git('commit', '-qm', 'seed')
    events.list.length = 0
    await runIndex({ dbPath: path.join(TMP, 'index.db'), embed: false, embedBudgetMs: 0 })
    const firstLower = events.list.findIndex((e) => e.startsWith('setPriority:'))
    const lastList = events.list.map((e) => e.startsWith('git:ls-files')).lastIndexOf(true)
    expect(lastList, `git ls-files never ran: ${events.list.join(' | ')}`).toBeGreaterThanOrEqual(0)
    expect(firstLower, `the priority was lowered before git ls-files ran: ${events.list.join(' | ')}`).toBeGreaterThan(lastList)
    expect(events.list[firstLower]).toBe(`setPriority:${os.constants.priority.PRIORITY_BELOW_NORMAL}`)
  })
})
