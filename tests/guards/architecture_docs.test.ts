/** Guard against architecture documentation drift. Enforces that the component table in CLAUDE.arch.md is exactly what scripts/sync-arch-docs.mjs generates from the tracked modules. If this guard fails: run `npm run docs:arch` to rewrite the table in place before committing. */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveRenames } from '../../scripts/arch-docs/curated.mjs'
import { parseNameStatus } from '../../scripts/arch-docs/source.mjs'
import { runCli } from '../../scripts/sync-arch-docs.mjs'
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
  scratchDirs.push(dir)
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

/** The exit code of `--check` (text format) from the engine's entry point, in process: one node spawn fewer than `engine`. The repo-local git variables are scrubbed for the call only. */
function checkExitCode(dir: string): number {
  const saved = { ...process.env }
  scrubRepoLocalGitEnv(process.env)
  try {
    return runCli(['--check'], { cwd: dir, stderr: () => {}, stdout: () => {} })
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
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

// FIXTURE PROVENANCE (staged, JSON and curated-role rows). Module sources, docs and expected rows are HAND-DERIVED from the contract. The finding, warning and note wording, the --staged error texts and the JSON key order are FORMAT-DERIVED from SKILL.md "Core Invariants" item 3, "Operating Modes" (Verification Mode) and "--check Output Contract" items 1, 2, 3 and 7 plus the JSON shape; the note texts also match the reference engine's self_test Cases 14 to 19. The git record bytes in the parseNameStatus row are FORMAT-DERIVED from git-diff(1) "-z" name-status output (R and C records carry a score and two paths).
const IDENTITY = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const BETA_ROLE = 'Hand written beta role'
const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function gitOut(cwd: string, args: string[]): string {
  const env = { ...process.env, ...IDENTITY }
  scrubRepoLocalGitEnv(env)
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repo under the OS temp dir holding the two modules and the config, an empty marker pair, removed after the test. */
function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-'))
  scratchDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), A_TS)
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), B_TS)
  fs.writeFileSync(path.join(dir, '.arch-doc-sync.json'), CONFIG)
  fs.writeFileSync(path.join(dir, 'ARCH.md'), `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`)
  gitOut(dir, ['init', '-q'])
  return dir
}

/** A committed repo whose table is written and whose src/b.ts row carries a curated role. */
function curatedRepo(): string {
  const dir = scratchRepo()
  gitOut(dir, ['add', '.'])
  expect(engine(dir, '--write').status).toBe(0)
  const doc = path.join(dir, 'ARCH.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Rest module: b.ts', BETA_ROLE))
  gitOut(dir, ['add', '.'])
  gitOut(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

describe('sync-arch-docs --check --staged', () => {
  it('carries a curated role across a staged rename and reports it as a warning', () => {
    const dir = curatedRepo()
    gitOut(dir, ['mv', 'src/b.ts', 'src/bb.ts'])
    const result = engine(dir, '--check', '--staged')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/bb.ts: undocumented module, run --write\nwarning: rename: src/b.ts -> src/bb.ts\n')
    const written = engine(dir, '--write')
    expect(written.status).toBe(0)
    expect(written.stderr).toContain('info: rename: src/b.ts -> src/bb.ts\n')
    const doc = fs.readFileSync(path.join(dir, 'ARCH.md'), 'utf8')
    expect(doc).toContain(`| \`src/bb.ts\` | Rest | ${BETA_ROLE} | beta, gamma |`)
    expect(doc).not.toContain('`src/b.ts`')
    gitOut(dir, ['add', '-A'])
    const synced = engine(dir, '--check', '--staged')
    expect({ status: synced.status, stderr: synced.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('does not carry a role across a copy: the copy is undocumented and gets a generated role', () => {
    const dir = curatedRepo()
    fs.copyFileSync(path.join(dir, 'src', 'b.ts'), path.join(dir, 'src', 'b2.ts'))
    gitOut(dir, ['add', '-A'])
    const result = engine(dir, '--check', '--staged')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/b2.ts: undocumented module, run --write\n')
    expect(engine(dir, '--write').status).toBe(0)
    const doc = fs.readFileSync(path.join(dir, 'ARCH.md'), 'utf8')
    expect(doc).toContain('| `src/b2.ts` | Rest | Rest module: b2.ts | beta, gamma |')
    expect(doc).toContain(`| \`src/b.ts\` | Rest | ${BETA_ROLE} | beta, gamma |`)
  })

  it('keeps only the rename records from git name-status output', () => {
    const data = Buffer.from('C100\0src/a.ts\0src/c.ts\0R087\0src/b.ts\0src/bb.ts\0M\0src/x.ts\0')
    expect(parseNameStatus(data)).toEqual([{ from: 'src/b.ts', to: 'src/bb.ts' }])
  })

  it('lets an unstaged edit neither cause drift nor hide it', () => {
    const dir = curatedRepo()
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const omega = 3\n')
    const caused = { staged: engine(dir, '--check', '--staged'), worktree: engine(dir, '--check') }
    expect({ status: caused.staged.status, stderr: caused.staged.stderr }).toEqual({ status: 0, stderr: '' })
    expect(caused.worktree.stderr).toBe('error: src/a.ts: stale entry, run --write\n')
    gitOut(dir, ['add', 'src/a.ts'])
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), A_TS)
    const hidden = { staged: engine(dir, '--check', '--staged'), worktree: engine(dir, '--check') }
    expect(hidden.staged.stderr).toBe('error: src/a.ts: stale entry, run --write\n')
    expect(hidden.staged.status).toBe(1)
    expect(hidden.worktree.status).toBe(0)
  })

  it('checks a repository whose HEAD is unborn from the index', () => {
    const dir = scratchRepo()
    gitOut(dir, ['add', '.'])
    expect(engine(dir, '--write').status).toBe(0)
    gitOut(dir, ['add', '.'])
    const result = engine(dir, '--check', '--staged')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('exits 2 when the doc or the config is on disk but not in the index', () => {
    const noDoc = scratchRepo()
    gitOut(noDoc, ['add', 'src', '.arch-doc-sync.json'])
    expect(engine(noDoc, '--check', '--staged')).toMatchObject({ status: 2, stderr: 'error: ARCH.md: architecture doc not found in the index; stage it with git add\n' })
    const noConfig = scratchRepo()
    gitOut(noConfig, ['add', 'src', 'ARCH.md'])
    expect(engine(noConfig, '--check', '--staged')).toMatchObject({
      status: 2,
      stderr: 'error: .arch-doc-sync.json: config exists in the working tree but not in the index; stage it with git add\n',
    })
  })

  it('exits 2 on an unmerged path', () => {
    const dir = curatedRepo()
    const main = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    gitOut(dir, ['checkout', '-q', '-b', 'side'])
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const side = 1\n')
    gitOut(dir, ['commit', '-q', '-am', 'side'])
    gitOut(dir, ['checkout', '-q', main])
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const mine = 1\n')
    gitOut(dir, ['commit', '-q', '-am', 'mine'])
    expect(() => gitOut(dir, ['merge', 'side'])).toThrow()
    expect(engine(dir, '--check', '--staged')).toMatchObject({ status: 2, stderr: 'error: src/a.ts: unmerged path; resolve the conflict before committing\n' })
  })

  it('accepts --staged only with --check', () => {
    const result = engine(scratchRepo(), '--write', '--staged')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('error: --staged applies only to --check')
  })
})

describe('curated roles through rename resolution', () => {
  const row = (module: string, role: string) => ({ module, layer: 'Core', role, exports: '—' })
  const resolve = (documented: [string, string][], current: string[], records: [string, string][], headAutoRole: string | null = null) =>
    resolveRenames({
      documented: new Map(documented.map(([key, role]) => [key, row(key, role)])),
      current: new Set(current),
      records: records.map(([from, to]) => ({ from, to })),
      isComponent: () => true,
      autoRole: (key) => `Auto role of ${key}`,
      headAutoRole: () => headAutoRole,
    })

  it('puts the origin suffix on every child of a split and reports it', () => {
    const result = resolve([['src/combined.ts', 'Curated combined logic']], ['src/a.ts', 'src/b.ts'], [['src/combined.ts', 'src/a.ts'], ['src/combined.ts', 'src/b.ts']])
    expect(result.overrides.get('src/a.ts')).toBe('Curated combined logic (split from src/combined.ts)')
    expect(result.overrides.get('src/b.ts')).toBe('Curated combined logic (split from src/combined.ts)')
    expect(result.notes).toEqual(['split: src/combined.ts -> src/a.ts, src/b.ts'])
    expect([...result.renamedAway]).toEqual(['src/combined.ts'])
  })

  it('keeps the longest curated role of a merge and reports the discarded one', () => {
    const result = resolve(
      [['src/one.ts', 'Short role'], ['src/two.ts', 'A much longer and more detailed curated role']],
      ['src/merged.ts'],
      [['src/one.ts', 'src/merged.ts'], ['src/two.ts', 'src/merged.ts']],
    )
    expect(result.overrides.get('src/merged.ts')).toBe('A much longer and more detailed curated role')
    expect(result.notes).toEqual(['rename: src/two.ts -> src/merged.ts', 'merge: discarded curated role from src/one.ts (kept src/two.ts) for src/merged.ts'])
  })

  it('does not carry a role the engine generated or move a module that still exists', () => {
    expect(resolve([['src/old.ts', 'Core module: old.ts']], ['src/new.ts'], [['src/old.ts', 'src/new.ts']]).overrides.size).toBe(0)
    expect(resolve([['src/old.ts', 'Old head sentence']], ['src/new.ts'], [['src/old.ts', 'src/new.ts']], 'Old head sentence').overrides.size).toBe(0)
    expect(resolve([['src/old.ts', 'Auto role of src/new.ts']], ['src/new.ts'], [['src/old.ts', 'src/new.ts']]).overrides.size).toBe(0)
    expect(resolve([['src/old.ts', 'Curated']], ['src/old.ts', 'src/new.ts'], [['src/old.ts', 'src/new.ts']]).overrides.size).toBe(0)
    expect(resolve([['src/old.ts', 'Curated']], ['src/new.ts'], [['src/old.ts', 'src/new.ts']]).overrides.get('src/new.ts')).toBe('Curated')
  })
})

describe('sync-arch-docs --check --format=json', () => {
  // src/b.ts carries a curated role, so removing it is also a drop note.
  const GOLDEN_DRIFT =
    '{"curated_at_risk":["drop: discarded role from src/b.ts (module no longer exists)"],"layer_violations":[],"layout_drift":false,"obsolete":["src/b.ts"],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/c.ts"}],"stale":["src/a.ts"],"static_cycles":[],"status":"drift","unmapped":["src/c.ts"]}\n'
  const GOLDEN_RENAME =
    '{"curated_at_risk":["rename: src/b.ts -> src/bb.ts"],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/bb.ts"}],"stale":[],"static_cycles":[],"status":"drift","unmapped":["src/bb.ts"]}\n'
  const GOLDEN_OK =
    '{"curated_at_risk":[],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/b.ts"}],"stale":[],"static_cycles":[],"status":"ok","unmapped":[]}\n'

  it('prints one compact object with the skill keys in order, byte-identical on two runs', () => {
    const dir = curatedRepo()
    const ok = engine(dir, '--check', '--format=json')
    expect({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }).toEqual({ status: 0, stdout: GOLDEN_OK, stderr: '' })
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const omega = 3\n')
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export const delta = 4\n')
    gitOut(dir, ['add', '-A'])
    gitOut(dir, ['rm', '-q', '-f', 'src/b.ts'])
    const first = engine(dir, '--check', '--format=json')
    const second = engine(dir, '--check', '--format', 'json')
    expect(first.stdout).toBe(GOLDEN_DRIFT)
    expect(second).toEqual(first)
    expect(first.status).toBe(1)
    expect(first.stderr).toBe('')
  })

  it('fills curated_at_risk with the rename note and keeps the exit code of the text format', () => {
    const dir = curatedRepo()
    gitOut(dir, ['mv', 'src/b.ts', 'src/bb.ts'])
    const json = engine(dir, '--check', '--format=json')
    expect({ status: json.status, stdout: json.stdout, stderr: json.stderr }).toEqual({ status: 1, stdout: GOLDEN_RENAME, stderr: '' })
    expect(checkExitCode(dir)).toBe(1)
  })

  it('exits 2 for a format that is not text or json, or json outside --check', () => {
    const dir = scratchRepo()
    expect(engine(dir, '--check', '--format=yaml').stderr).toContain('error: --format must be text or json, got "yaml"')
    expect(engine(dir, '--write', '--format=json').stderr).toContain('error: --format json applies only to --check')
    expect(engine(dir, '--check', '--format').stderr).toContain('error: --format requires a value')
  })
})

// FIXTURE PROVENANCE (architecture analysis). Every module source below is HAND-DERIVED: written by hand so the expected finding follows from SKILL.md "Architectural Analysis Contract" (arch-doc-sync skill: "Side-Effect Taxonomy", "Inward-Only Layer Boundaries", "Static Circular Dependencies"), not read off the engine's output. The finding wording is FORMAT-DERIVED from SKILL.md "--check Output Contract" items 4 and 5, and the JSON golden from its JSON paragraph (key order, labels in taxonomy order, arrays sorted).
const LAYERED_CONFIG = JSON.stringify({
  doc: 'ARCH.md',
  roots: ['src'],
  layers: [['src/ui', 'Presentation'], ['src/core', 'Domain Core'], ['src/data', 'Data Persistence']],
})

/** A repo of the given modules under the OS temp dir with its table already written, so only the analysis can make `--check` report. */
function analysisRepo(files: Record<string, string>, config = LAYERED_CONFIG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-'))
  scratchDirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  fs.writeFileSync(path.join(dir, '.arch-doc-sync.json'), config)
  fs.writeFileSync(path.join(dir, 'ARCH.md'), `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`)
  gitOut(dir, ['init', '-q'])
  gitOut(dir, ['add', '.'])
  expect(engine(dir, '--write').status).toBe(0)
  return dir
}

const sideEffectsOf = (dir: string): { module: string; labels: string[] }[] =>
  (JSON.parse(engine(dir, '--check', '--format=json').stdout) as { side_effects: { module: string; labels: string[] }[] }).side_effects

describe('sync-arch-docs --check layer order', () => {
  it('reports a reverse edge with both paths and layer names and exits 1', () => {
    const dir = analysisRepo({
      'src/ui/theme.ts': 'export const theme = 1\n',
      'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: 'error: src/data/store.ts: dependency on src/ui/theme.ts violates layer order (Data Persistence -> Presentation)\n',
    })
    expect(JSON.parse(engine(dir, '--check', '--format=json').stdout)).toMatchObject({ status: 'drift', layer_violations: [{ source: 'src/data/store.ts', target: 'src/ui/theme.ts' }] })
  })

  it('does not report a forward edge or an edge within one layer', () => {
    const dir = analysisRepo({
      'src/ui/view.ts': "import { store } from '../data/store'\nimport { theme } from './theme'\nexport const view = [store, theme]\n",
      'src/ui/theme.ts': 'export const theme = 1\n',
      'src/data/store.ts': 'export const store = 2\n',
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('reports none when the configured layers are not the five-layer profile', () => {
    const dir = analysisRepo(
      { 'src/ui/theme.ts': 'export const theme = 1\n', 'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n" },
      JSON.stringify({ doc: 'ARCH.md', roots: ['src'], layers: [['src/ui', 'Screens'], ['src/data', 'Storage']] }),
    )
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })
})

describe('sync-arch-docs --check static cycles', () => {
  it('reports each two-module cycle and each self-import, sorted by path', () => {
    const dir = analysisRepo({
      'src/core/y.ts': "import { x } from './x'\nexport const y = x\n",
      'src/core/x.ts': "import { y } from './y'\nexport const x = y\n",
      'src/core/n.ts': "import { m } from './m'\nexport const n = m\n",
      'src/core/m.ts': "import { n } from './n'\nexport const m = n\n",
      'src/core/s.ts': "import { s } from './s'\nexport const s = 1\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: 'error: static dependency cycle: src/core/m.ts, src/core/n.ts\nerror: static dependency cycle: src/core/s.ts\nerror: static dependency cycle: src/core/x.ts, src/core/y.ts\n',
    })
  })

  it('does not count a function-level import as a cycle edge', () => {
    const dir = analysisRepo({
      'src/core/a.ts': "import { b } from './b'\nexport const a = b\n",
      'src/core/b.ts': "export function load() {\n  const a = require('./a')\n  return a\n}\nexport async function later() {\n  return import('./a')\n}\nexport const b = 1\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('reports the table layout only when no other finding is present', () => {
    const cyclic = { 'src/core/a.ts': "import { b } from './b'\nexport const a = b\n", 'src/core/b.ts': "import { a } from './a'\nexport const b = a\n" }
    const mangle = (dir: string): void => {
      const doc = path.join(dir, 'ARCH.md')
      fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace(`${START}\n`, `${START}\n\n`))
    }
    const plain = analysisRepo({ 'src/core/a.ts': 'export const a = 1\n' })
    mangle(plain)
    expect(engine(plain, '--check').stderr).toBe('error: ARCH.md: table layout differs from generated output, run --write\n')
    const dir = analysisRepo(cyclic)
    mangle(dir)
    expect(engine(dir, '--check').stderr).toBe('error: static dependency cycle: src/core/a.ts, src/core/b.ts\n')
  })
})

describe('sync-arch-docs --check side effects', () => {
  const FILES: Record<string, string> = {
    'src/core/mutating.ts': "export const sql = 'INSERT INTO t VALUES (1)'\n",
    'src/core/readonly.ts': "// uses oracledb\nexport const sql = 'SELECT id FROM users'\n",
    'src/core/system.ts': "import fs from 'node:fs'\nexport const text = fs.readFileSync('x', 'utf8')\n",
    'src/ui/view.ts': 'export const view = () => render()\n',
    'src/core/cli.ts': 'export const args = process.argv.slice(2)\n',
    'src/core/pure.ts': 'export const add = (a: number, b: number) => a + b\n',
    'src/core/both.ts': "import fs from 'node:fs'\nexport const both = [fs.readFileSync('x', 'utf8'), process.argv]\n",
  }

  it('labels each one-file module, in taxonomy order, and gives [Pure Domain] only to a module with no other label', () => {
    const dir = analysisRepo(FILES)
    expect(sideEffectsOf(dir)).toEqual([
      { module: 'src/core/both.ts', labels: ['[File / System I/O]', '[CLI / Runtime]'] },
      { module: 'src/core/cli.ts', labels: ['[CLI / Runtime]'] },
      { module: 'src/core/mutating.ts', labels: ['[Oracle Mutating]'] },
      { module: 'src/core/pure.ts', labels: ['[Pure Domain]'] },
      { module: 'src/core/readonly.ts', labels: ['[Oracle Read-Only]'] },
      { module: 'src/core/system.ts', labels: ['[File / System I/O]'] },
      { module: 'src/ui/view.ts', labels: ['[UI / View]'] },
    ])
    expect(engine(dir, '--check').status).toBe(0)
  })
})

describe('sync-arch-docs --check --format=json analysis', () => {
  const pure = (module: string): string => `{"labels":["[Pure Domain]"],"module":"${module}"}`
  const GOLDEN =
    '{"curated_at_risk":[],"layer_violations":[{"source":"src/data/store.ts","source_layer":"Data Persistence","target":"src/ui/theme.ts","target_layer":"Presentation"}],"layout_drift":false,"obsolete":[],"side_effects":[' +
    [pure('src/core/a.ts'), pure('src/core/b.ts'), pure('src/data/store.ts'), pure('src/ui/theme.ts')].join(',') +
    '],"stale":[],"static_cycles":[["src/core/a.ts","src/core/b.ts"]],"status":"drift","unmapped":[]}\n'

  it('carries the layer violation, the cycle and the labels byte for byte, identically on two runs', () => {
    const dir = analysisRepo({
      'src/core/a.ts': "import { b } from './b'\nexport const a = b\n",
      'src/core/b.ts': "import { a } from './a'\nexport const b = a\n",
      'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n",
      'src/ui/theme.ts': 'export const theme = 1\n',
    })
    const first = engine(dir, '--check', '--format=json')
    const second = engine(dir, '--check', '--format=json')
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr }).toEqual({ status: 1, stdout: GOLDEN, stderr: '' })
    expect(second).toEqual(first)
  })
})
