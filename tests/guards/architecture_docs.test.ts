/** Guard against architecture documentation drift. Enforces that the component table in CLAUDE.arch.md is exactly what scripts/sync-arch-docs.mjs generates from the tracked modules. If this guard fails: run `npm run docs:arch` to rewrite the table in place before committing. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRepoLocalExecutableDecoys } from '../helpers/repo_local_executable_decoys.js'
import { scrubRepoLocalGitEnv } from '../helpers/git-env.js'
import { ROOT, ENGINE, START, END, CONFIG, DOC_HEAD, DOC_TAIL, git, gitOut, scratchDirs, makeRepo, engineEnv, engineWithEnv, engine, synced, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

describe('Architecture documentation freshness and coverage', () => {
  it('has zero drift in this repository, checked as the command npm run docs:arch:check runs', () => {
    const result = engineWithEnv(ROOT, {}, '--check')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each(['--check', '--write'])('rejects a document reached through a symlink outside the repository (%s)', (mode) => {
    const repo = makeRepo()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-outside-'))
    scratchDirs.push(outside)
    const outsideDoc = path.join(outside, 'ARCH.md')
    const original = `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`
    fs.writeFileSync(outsideDoc, original)
    fs.symlinkSync(outside, path.join(repo.dir, 'docs'), 'junction')
    const config = JSON.parse(CONFIG) as { doc: string; roots: string[]; layers: [string, string][] }
    config.doc = 'docs/ARCH.md'
    fs.writeFileSync(path.join(repo.dir, '.arch-doc-sync.json'), JSON.stringify(config))

    const result = engine(repo.dir, mode)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('must resolve inside the repository')
    expect(fs.readFileSync(outsideDoc, 'utf8')).toBe(original)
  })

  it('writes to a document reached through a symlink inside the repository', () => {
    const repo = makeRepo()
    const inside = path.join(repo.dir, 'doc-target')
    const link = path.join(repo.dir, 'docs')
    fs.mkdirSync(inside)
    const insideDoc = path.join(inside, 'ARCH.md')
    const original = `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`
    fs.writeFileSync(insideDoc, original)
    fs.symlinkSync(inside, link, 'junction')
    const config = JSON.parse(CONFIG) as { doc: string; roots: string[]; layers: [string, string][] }
    config.doc = 'docs/ARCH.md'
    fs.writeFileSync(path.join(repo.dir, '.arch-doc-sync.json'), JSON.stringify(config))

    const result = engine(repo.dir, '--write')

    expect(result.status).toBe(0)
    expect(fs.readFileSync(insideDoc, 'utf8')).not.toBe(original)
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
  it.runIf(process.platform === 'win32')('does not execute git.exe from a nested directory in the repository being analyzed', () => {
    const fixture = makeRepo()
    gitOut(fixture.dir, ['commit', '-m', 'fixture'])
    const linked = path.join(path.dirname(fixture.dir), `${path.basename(fixture.dir)}-linked`)
    scratchDirs.push(linked)
    git(fixture.dir, ['worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD'])
    expect(fs.statSync(path.join(fixture.dir, '.git')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true)

    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const nodeOptionsKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'NODE_OPTIONS') ?? 'NODE_OPTIONS'
    for (const root of [fixture.dir, linked]) {
      const decoys = createRepoLocalExecutableDecoys(root)
      const extra: NodeJS.ProcessEnv = {
        [pathKey]: `${root}${path.delimiter}${process.env[pathKey] ?? ''}`,
        [nodeOptionsKey]: [process.env[nodeOptionsKey], decoys.preloadOption].filter(Boolean).join(' '),
      }
      const env = engineEnv(extra)
      const probe = spawnSync('git', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(decoys.marker)}, 'probe')`], {
        cwd: root,
        env,
        encoding: 'utf8',
      })
      expect(probe.status).toBe(0)
      expect(fs.readFileSync(decoys.marker, 'utf8')).toBe('probe')
      fs.rmSync(decoys.marker)

      const result = engineWithEnv(path.join(root, 'src'), extra, '--write')
      expect(result.status).toBe(0)
      expect(fs.existsSync(decoys.marker)).toBe(false)
    }
  })

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
