/** Guard against architecture documentation drift. Enforces that the component table in CLAUDE.arch.md is exactly what scripts/sync-arch-docs.mjs generates from the tracked modules. If this guard fails: run `npm run docs:arch` to rewrite the table in place before committing. */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { scrubRepoLocalGitEnv } from '../helpers/git-env.js'
import { indexableDir } from '../helpers/temp-config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = path.join(ROOT, 'scripts', 'sync-arch-docs.mjs')
const START = '<!-- ARCH_COMPONENTS_START -->'
const END = '<!-- ARCH_COMPONENTS_END -->'

// FIXTURE PROVENANCE. The module sources, the doc and the config below are HAND-DERIVED: written by hand, with the expected rows worked out from the contract rather than read off the engine's output. The finding wording is FORMAT-DERIVED from SKILL.md "--check Output Contract" (arch-doc-sync skill, items 1, 2, 3 and 6), and the table shape from SKILL.md "Component Table Contract".
const CONFIG = JSON.stringify({ doc: 'ARCH.md', roots: ['src'], layers: [['src/a.ts', 'Core'], ['src', 'Rest']] })
const A_TS = '/** Alpha does the first thing. It also does more. */\nexport const alpha = 1\n'
const B_TS = 'export function beta(): void {}\nexport const gamma = 2\n'
const DOC_HEAD = '# Architecture\n\nProse before the table.\n\n'
const DOC_TAIL = '\nProse after the table.\n'

function git(cwd: string, args: string[]): void {
  const env = { ...process.env }
  scrubRepoLocalGitEnv(env)
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, stdio: 'ignore' })
}

interface Fixture {
  dir: string
  doc: string
}

/** A throwaway git repo with two modules, a config and an empty marker pair, all tracked. */
function makeRepo(docText = `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`): Fixture {
  const dir = indexableDir()
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), A_TS)
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), B_TS)
  fs.writeFileSync(path.join(dir, '.arch-doc-sync.json'), CONFIG)
  const doc = path.join(dir, 'ARCH.md')
  fs.writeFileSync(doc, docText)
  git(dir, ['init', '-q'])
  git(dir, ['add', '.'])
  return { dir, doc }
}

/** Runs the engine as a command from `dir`, the way `npm run docs:arch` does. */
function engine(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env }
  scrubRepoLocalGitEnv(env)
  const result = spawnSync(process.execPath, [ENGINE, ...args], { cwd: dir, env, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const synced = (): Fixture => {
  const repo = makeRepo()
  expect(engine(repo.dir, '--write').status).toBe(0)
  return repo
}

describe('Architecture documentation freshness and coverage', () => {
  it('has zero drift in this repository, checked as the command npm run docs:arch:check runs', () => {
    const result = engine(ROOT, '--check')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('keeps every row in a configured layer, with a bounded role and no trailing period', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.arch.md'), 'utf8')
    const rows = doc
      .slice(doc.indexOf(START) + START.length, doc.indexOf(END))
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split(/(?<!\\)\|/).map((cell) => cell.trim()))
    expect(rows.length).toBeGreaterThan(500)
    const uncategorized = rows.filter((cells) => cells[2] === 'Uncategorized').map((cells) => cells[1])
    expect(uncategorized).toEqual([])
    const badRoles = rows.filter((cells) => [...(cells[3] ?? '')].length > 120 || (cells[3] ?? '').endsWith('.') || cells[3] === '').map((cells) => cells[1])
    expect(badRoles).toEqual([])
  })
})

describe('sync-arch-docs engine', () => {
  it('reports an undocumented module and leaves the stdout empty', () => {
    const repo = synced()
    fs.writeFileSync(path.join(repo.dir, 'src', 'c.ts'), 'export const delta = 4\n')
    git(repo.dir, ['add', 'src/c.ts'])
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/c.ts: undocumented module, run --write\n')
    expect(result.stdout).toBe('')
  })

  it('reports an obsolete row once its module is gone', () => {
    const repo = synced()
    git(repo.dir, ['rm', '-q', '-f', 'src/b.ts'])
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/b.ts: obsolete entry, module no longer exists\n')
  })

  it('reports a stale row when a module gains an export', () => {
    const repo = synced()
    fs.appendFileSync(path.join(repo.dir, 'src', 'a.ts'), 'export const omega = 3\n')
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/a.ts: stale entry, run --write\n')
    expect(engine(repo.dir, '--write').status).toBe(0)
    expect(fs.readFileSync(repo.doc, 'utf8')).toContain('| `src/a.ts` | Core | Alpha does the first thing | alpha, omega |')
  })

  it('reports a layout-only difference when every row still matches', () => {
    const repo = synced()
    fs.writeFileSync(repo.doc, fs.readFileSync(repo.doc, 'utf8').replace('| --- | --- | --- | --- |', '|---|---|---|---|'))
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: ARCH.md: table layout differs from generated output, run --write\n')
  })

  it('exits 2 on a duplicated marker and writes nothing', () => {
    const repo = makeRepo(`${DOC_HEAD}${START}\n${END}\n${START}\n${END}\n`)
    const before = fs.readFileSync(repo.doc)
    for (const flag of ['--check', '--write']) {
      const result = engine(repo.dir, flag)
      expect(result.status, flag).toBe(2)
      expect(result.stderr, flag).toContain('error: duplicated ARCH_COMPONENTS_START marker')
    }
    expect(fs.readFileSync(repo.doc).equals(before)).toBe(true)
  })

  it('exits 2 on a missing or reversed marker', () => {
    expect(engine(makeRepo(`${DOC_HEAD}${START}\n`).dir, '--check').stderr).toContain('missing ARCH_COMPONENTS_END marker')
    expect(engine(makeRepo(`${DOC_HEAD}${END}\n${START}\n`).dir, '--check').stderr).toContain('ARCH_COMPONENTS_END precedes ARCH_COMPONENTS_START')
  })

  it('writes byte-identical output on a second --write and keeps the prose outside the markers', () => {
    const repo = makeRepo()
    expect(engine(repo.dir, '--write').status).toBe(0)
    const first = fs.readFileSync(repo.doc)
    expect(engine(repo.dir, '--write').status).toBe(0)
    expect(fs.readFileSync(repo.doc).equals(first)).toBe(true)
    const text = first.toString('utf8')
    expect(text.startsWith(DOC_HEAD + START)).toBe(true)
    expect(text.endsWith(`${END}\n${DOC_TAIL}`)).toBe(true)
    expect(text).toContain('| `src/a.ts` | Core | Alpha does the first thing | alpha |')
    expect(text).toContain('| `src/b.ts` | Rest | Rest module: b.ts | beta, gamma |')
    expect(engine(repo.dir, '--check').status).toBe(0)
  })

  it('leaves the doc untouched on --check even when it has drifted', () => {
    const repo = synced()
    fs.appendFileSync(path.join(repo.dir, 'src', 'a.ts'), 'export const omega = 3\n')
    const before = fs.readFileSync(repo.doc)
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(1)
    expect(fs.readFileSync(repo.doc).equals(before)).toBe(true)
  })

  it('keeps a curated role and replaces a role that only restates the template', () => {
    const repo = synced()
    const curated = fs.readFileSync(repo.doc, 'utf8').replace('Rest module: b.ts', 'Hand written beta role')
    fs.writeFileSync(repo.doc, curated)
    expect(engine(repo.dir, '--check').status).toBe(0)
    expect(engine(repo.dir, '--write').status).toBe(0)
    expect(fs.readFileSync(repo.doc, 'utf8')).toContain('| `src/b.ts` | Rest | Hand written beta role | beta, gamma |')
  })

  it('keeps CRLF line endings', () => {
    const repo = makeRepo(`${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`.replace(/\n/g, '\r\n'))
    expect(engine(repo.dir, '--write').status).toBe(0)
    const text = fs.readFileSync(repo.doc, 'utf8')
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(text).toContain('| `src/a.ts` |')
    expect(engine(repo.dir, '--check').status).toBe(0)
  })

  it('runs as a command: exit code 1 on drift, nothing on stdout, nothing written by --check', () => {
    const repo = synced()
    fs.appendFileSync(path.join(repo.dir, 'src', 'a.ts'), 'export const omega = 3\n')
    const before = fs.readFileSync(repo.doc)
    const env = { ...process.env }
    scrubRepoLocalGitEnv(env)
    const result = spawnSync(process.execPath, [ENGINE, '--check'], { cwd: repo.dir, env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: src/a.ts: stale entry, run --write\n')
    expect(fs.readFileSync(repo.doc).equals(before)).toBe(true)
  })

  it('exits 2 on an unknown config key', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, '.arch-doc-sync.json'), JSON.stringify({ doc: 'ARCH.md', surprise: true }))
    const result = engine(repo.dir, '--check')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown key "surprise"')
  })
})
