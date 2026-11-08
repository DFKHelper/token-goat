/** The --staged rows and the curated-role rename rows of the architecture documentation engine. Split from architecture_docs.test.ts so its rows run in a parallel worker; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveRenames } from '../../scripts/arch-docs/curated.mjs'
import { parseNameStatus } from '../../scripts/arch-docs/source.mjs'
import { A_TS, BETA_ROLE, gitOut, scratchDirs, engineWithEnv, engine, scratchRepo, curatedRepo, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

describe('sync-arch-docs --check --staged', () => {
  it('reports a staged rename as a warning', () => {
    const dir = curatedRepo()
    gitOut(dir, ['mv', 'src/b.ts', 'src/bb.ts'])
    const result = engine(dir, '--check', '--staged')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('error: src/bb.ts: undocumented module, run --write\nwarning: rename: src/b.ts -> src/bb.ts\n')
  })

  it('carries a curated role across a staged rename', () => {
    const dir = curatedRepo()
    gitOut(dir, ['mv', 'src/b.ts', 'src/bb.ts'])
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

  // The next two rows are one scenario split in two, so each pays about half of the git starts (a start costs 1 s or more on a loaded Windows host) and stays well under the row timeout.
  it('lets an unstaged edit cause no drift in the staged check', () => {
    const dir = curatedRepo()
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const omega = 3\n')
    const caused = { staged: engine(dir, '--check', '--staged'), worktree: engine(dir, '--check') }
    expect({ status: caused.staged.status, stderr: caused.staged.stderr }).toEqual({ status: 0, stderr: '' })
    expect(caused.worktree.stderr).toBe('error: src/a.ts: stale entry, run --write\n')
  })

  it('lets an unstaged revert not hide a staged edit', () => {
    const dir = curatedRepo()
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const omega = 3\n')
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

  // HAND-DERIVED: 5 git starts = rev-parse, ls-tree HEAD, diff --cached, cat-file for the config, cat-file for the doc and modules; worked out from the read order, not read off the engine output.
  it('starts five git processes for one --check --staged call on a committed, in-sync repo', () => {
    const dir = curatedRepo()
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-trace-'))
    scratchDirs.push(traceDir)
    const trace = path.join(traceDir, 'events.jsonl')
    const result = engineWithEnv(dir, { GIT_TRACE2_EVENT: trace }, '--check', '--staged')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    const starts = fs.readFileSync(trace, 'utf8').split('\n').filter((line) => line.includes('"event":"start"'))
    expect(starts).toHaveLength(5)
  })

  it('accepts --staged only with --check', () => {
    const result = engineWithEnv(scratchRepo(), {}, '--write', '--staged')
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
