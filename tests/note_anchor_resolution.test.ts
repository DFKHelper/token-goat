/** Which declaration a project note's `--anchor file::Name` binds to, and which one its staleness marker then follows. Drives the built bundle against a really indexed fixture project (isolated home), so the symbols, the parent column and the re-resolution at `note list` time are all the production ones. Provenance: HAND-DERIVED. The fixture source is written out below and every expected outcome follows from which lines each edit touches and from `read "file::Name"`'s documented grammar (a bare name shared by unrelated definitions is refused, `Class.method` picks one), not from the resolver under test. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

const SOURCE = [
  'export function over(a: string): string;',
  'export function over(a: number): number;',
  'export function over(a: any): any {',
  '  return a',
  '}',
  '',
  'export class Alpha {',
  '  run(): number {',
  '    return 1',
  '  }',
  '}',
  '',
  'export class Beta {',
  '  run(): number {',
  '    return 2',
  '  }',
  '}',
  '',
].join('\n')

describe('note anchors resolve the way read does', () => {
  let projectDir: string
  let filePath: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, ...args], { cwd: projectDir, encoding: 'utf-8', env })
  const lineFor = (text: string, key: string): string => text.split('\n').find((l) => l.includes(key)) ?? ''
  const edit = (from: string, to: string): void => {
    writeFileSync(filePath, readFileSync(filePath, 'utf-8').replace(from, to))
    const indexed = run('index', '.')
    expect(indexed.status, indexed.stderr).toBe(0)
  }

  beforeAll(() => {
    projectDir = indexableDir()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-note-anchor-res-home-'))
    env = { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir }
    filePath = join(projectDir, 'probe.ts')
    writeFileSync(filePath, SOURCE)
    for (const args of [['init', '-q'], ['add', '-A']]) {
      expect(spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' }).status).toBe(0)
    }
    const indexed = run('index', '.')
    expect(indexed.status, indexed.stderr).toBe(0)
  })

  it('refuses a bare name two classes share, listing the qualified forms, and sets no note', () => {
    const r = run('note', 'set', 'bare-run', 'x', '--anchor', 'probe.ts::run')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Ambiguous symbol')
    expect(r.stderr).toContain('Alpha.run')
    expect(r.stderr).toContain('Beta.run')
    expect(r.stderr, 'the candidate list printed an escaped newline instead of breaking lines').not.toContain('\\n')
    expect(r.stderr, 'the retry hint must be the --anchor form that sets the note').toContain('--anchor "probe.ts::Alpha.run"')
    expect(r.stderr, 'the retry hint sent the user to read, which sets no note').not.toContain('token-goat read')
    expect(run('note', 'list').stdout).not.toContain('bare-run')
  })

  it('refuses an ambiguous note-add --symbol with the --symbol form of each qualified name', () => {
    const r = run('note-add', 'probe.ts', '--symbol', 'run', '--content-b64', Buffer.from('x').toString('base64'))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--symbol "Alpha.run"')
    expect(r.stderr).toContain('--symbol "Beta.run"')
    expect(r.stderr).not.toContain('token-goat read')
  })

  it('binds a qualified anchor to that class, so only edits to its body flag the note', () => {
    const set = run('note', 'set', 'beta-run', 'Beta.run returns two', '--anchor', 'probe.ts::Beta.run')
    expect(set.status, set.stderr).toBe(0)
    expect(set.stdout).toContain('Anchored to probe.ts::Beta.run')
    expect(lineFor(run('note', 'list').stdout, 'beta-run')).not.toMatch(/since note|symbol gone/)

    edit('    return 1', '    return 100')
    expect(lineFor(run('note', 'list').stdout, 'beta-run'), 'an edit to Alpha.run flagged the note on Beta.run').not.toMatch(/since note|symbol gone/)

    edit('    return 2', '    return 200')
    expect(lineFor(run('note', 'list').stdout, 'beta-run')).toContain('(changed since note)')
  })

  it('anchors a qualified name written in the note text without an --anchor flag', () => {
    const set = run('note', 'set', 'auto-alpha', 'see probe.ts::Alpha.run for the loop')
    expect(set.status, set.stderr).toBe(0)
    expect(set.stdout).toContain('Anchored to probe.ts::Alpha.run')
  })

  it('fingerprints an overloaded function by its whole declaration, so the implementation body counts', () => {
    const set = run('note', 'set', 'over-note', 'over is overloaded', '--anchor', 'probe.ts::over')
    expect(set.status, set.stderr).toBe(0)
    expect(lineFor(run('note', 'list').stdout, 'over-note')).not.toMatch(/since note|symbol gone/)

    edit('  return a\n', '  return a // changed\n')
    expect(lineFor(run('note', 'list').stdout, 'over-note')).toContain('(changed since note)')
  })
})
