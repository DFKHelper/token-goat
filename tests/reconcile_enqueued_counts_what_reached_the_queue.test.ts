/** `reconcile` must report what reached the dirty queue, not what it handed the queue. `enqueueDirtyPathsSafe` refuses anything under the OS temp dir, and the sweep counted every path it passed in: a project there reported `enqueued: 1` with no queue file written and no worker woken, the text report said the file was "queued for reindexing", and the session-start note told the model token-goat was reindexing a file nothing would reindex. Why didn't a test catch this: the reconcile tests that assert on `enqueued` all build their project outside the temp dir, where every path is accepted, and the session-start note test built its project inside it and pinned the "reindexing" wording there. Provenance: CAPTURE. Every expectation is measured from real runs of the built bundle against real indexed projects, one under the OS temp dir and one outside it; the drift is a direct write to the file on disk, as an out-of-session editor makes it. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

interface Sweep {
  changed: string[]
  added: string[]
  removed: string[]
  enqueued: number
}

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir }
}

function run(projectDir: string, homeDir: string, args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function sweep(projectDir: string, homeDir: string): Sweep {
  const r = run(projectDir, homeDir, ['reconcile', '--budget-ms', '30000', '--json'])
  try {
    return JSON.parse(r.out) as Sweep
  } catch {
    return expect.fail(`reconcile emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
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

function queueLines(homeDir: string): string[] {
  const queue = findDirtyQueue(homeDir)
  if (queue === null) return []
  return readFileSync(queue, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

/** An indexed git project whose one file then changes on disk, so a sweep has exactly one path to hand the queue. Returns the changed file's path. */
function driftedProject(projectDir: string, homeDir: string): string {
  const file = join(projectDir, 'alpha.ts')
  writeFileSync(file, 'export function alpha(): number {\n  return 1\n}\n')
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
    expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
  }
  git('init', '-q')
  git('add', '-A')
  const indexed = run(projectDir, homeDir, ['index', '.'])
  expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)
  writeFileSync(file, 'export function alpha(): number {\n  return 100\n}\n')
  return file
}

describe('reconcile under the OS temp dir, where the queue refuses every path', () => {
  let projectDir: string
  let homeDir: string

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-temp-project-'))
    homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-temp-project-home-'))
    driftedProject(projectDir, homeDir)
  })

  it('reports as enqueued only what the queue holds', () => {
    const swept = sweep(projectDir, homeDir)
    // Calibration: the sweep found the drift, so a count of zero below is the queue refusing it and not a clean project.
    expect(swept.changed.map((p) => p.split(/[\\/]/).pop()), 'the fixture produced no drift, so the count proves nothing').toEqual(['alpha.ts'])
    expect(queueLines(homeDir), 'the queue took a path under the OS temp dir').toEqual([])
    expect(swept.enqueued, 'reconcile reported a path the queue never took as enqueued').toBe(0)
  })

  it('does not print that a refused file was queued', () => {
    const r = run(projectDir, homeDir, ['reconcile', '--budget-ms', '30000'])
    expect(r.code).toBe(0)
    expect(r.out, 'the fixture produced no drift, so the wording proves nothing').toContain('changed since indexing')
    expect(r.out, 'the report called a file the queue refused queued').not.toContain('(queued for reindexing)')
    expect(r.out, 'the report must say the drift was not queued').toContain('1 file of the above could not be queued for reindexing')
  })

  it('does not tell the model at session start that it is reindexing files the queue refused', () => {
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'session_start'], {
      cwd: projectDir,
      encoding: 'utf-8',
      input: JSON.stringify({ cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' }),
      env: isolatedEnv(homeDir),
    })
    expect(res.status, `the session_start hook exited ${res.status}; it must never fail the session`).toBe(0)
    const parsed = JSON.parse(res.stdout ?? '{}') as { hookSpecificOutput?: { additionalContext?: string } }
    const context = parsed.hookSpecificOutput?.additionalContext ?? ''
    expect(context, 'the fixture produced no drift note, so its wording proves nothing').toContain('changed outside this session')
    expect(context, 'the note claimed a reindex the queue refused').not.toContain('token-goat: reindexing')
    expect(context, 'the note must say the drift was not queued').toContain('but it could not be queued for reindexing')
  })
})

describe('reconcile outside the OS temp dir, where the queue accepts every path', () => {
  it('reports as enqueued the paths the queue holds', () => {
    const projectDir = indexableDir()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-reconcile-queued-home-'))
    const file = driftedProject(projectDir, homeDir)
    const swept = sweep(projectDir, homeDir)
    expect(queueLines(homeDir).map(normalizePath), 'the sweep found drift and queued none of it').toEqual([normalizePath(file)])
    expect(swept.enqueued).toBe(1)
  })
})
