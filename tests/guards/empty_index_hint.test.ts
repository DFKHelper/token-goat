/**
 * Guard: symbol/semantic/refs/types/callers/brief/dead/call-chain must not let a zero-result
 * query read as a genuine "not found" when the real cause is that the project has zero indexed
 * files. Doctor's Symbols check already diagnoses this exact condition (cli_doctor.ts's
 * checkSymbolCount) -- these commands must append the same wording (via index_health.ts's
 * emptyIndexMessage) instead of dead-ending into the plain message alone.
 *
 * Every case is asserted both ways: an unindexed project gets the new hint, and an indexed
 * project with a genuine miss keeps its original message byte-identical -- a fix that always
 * appended the hint (or fired the DB check regardless of query outcome) would pass only one half.
 *
 * The suggested command in the hint must also be git-aware: `token-goat index .` inside a git
 * repo, `token-goat index . --walk` outside one (a non-git scratch folder is empty-index's most
 * common trigger, and plain `index .` refuses there with "no tracked files found").
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let gitProjectDir: string
let nonGitProjectDir: string
let indexedProjectDir: string
let homeDir: string

function run(args: string[], cwd: string, home: string): { status: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [BUNDLE, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home },
    })
    return { status: 0, out: stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

const EMPTY_INDEX_SNIPPET = 'no files indexed for this project'

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-emptyidx-home-'))

  // Unindexed non-git scratch folder -- never indexed, no .git anywhere in its ancestry.
  nonGitProjectDir = mkdtempSync(join(tmpdir(), 'tg-emptyidx-nongit-'))
  writeFileSync(join(nonGitProjectDir, 'a.ts'), 'export function alpha(x: number): number { return x + 1 }\n')

  // Unindexed git repo.
  gitProjectDir = mkdtempSync(join(tmpdir(), 'tg-emptyidx-git-'))
  writeFileSync(join(gitProjectDir, 'b.ts'), 'export function beta(x: number): number { return x + 2 }\n')
  mkdirSync(join(gitProjectDir, '.git'))

  // Genuinely indexed project, for the "keep the old message" control.
  indexedProjectDir = mkdtempSync(join(tmpdir(), 'tg-emptyidx-indexed-'))
  writeFileSync(join(indexedProjectDir, 'c.ts'), 'export function gamma(x: number): number { return x + 3 }\n')
  run(['index', '.', '--walk'], indexedProjectDir, homeDir)
})

describe('empty-index hint', () => {
  it('symbol: unindexed project appends the empty-index hint and suggests --walk outside git', () => {
    const r = run(['symbol', 'noSuchSymbol'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
    expect(r.out).toContain("token-goat index . --walk")
  })

  it('symbol: unindexed git project suggests plain index . (no --walk)', () => {
    const r = run(['symbol', 'noSuchSymbol'], gitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
    expect(r.out).toContain("run 'token-goat index .' here")
    expect(r.out).not.toContain('--walk')
  })

  it('symbol: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['symbol', 'noSuchSymbol'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("No matches for 'noSuchSymbol'")
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('semantic: unindexed project appends the empty-index hint', () => {
    const r = run(['semantic', 'noSuchThingAtAll'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
    expect(r.out).toContain('--walk')
  })

  it('semantic --json: unindexed project stays valid JSON and names indexEmpty', () => {
    const r = run(['semantic', 'noSuchThingAtAll', '--json'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    const parsed = JSON.parse(r.out) as { indexEmpty?: boolean; hint?: string; items: unknown[] }
    expect(parsed.indexEmpty).toBe(true)
    expect(parsed.hint).toContain(EMPTY_INDEX_SNIPPET)
    expect(parsed.items).toEqual([])
  })

  it('semantic --json: indexed project with a genuine miss stays byte-identical (no indexEmpty field)', () => {
    const r = run(['semantic', 'noSuchThingAtAll', '--json'], indexedProjectDir, homeDir)
    const parsed = JSON.parse(r.out) as { indexEmpty?: boolean; hint?: string }
    expect(parsed.indexEmpty).toBeUndefined()
    expect(parsed.hint).toBeUndefined()
  })

  it('refs: unindexed project appends the empty-index hint', () => {
    const r = run(['refs', 'noSuchSymbol'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('refs: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['refs', 'noSuchSymbol'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("No references found for 'noSuchSymbol'")
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('types: unindexed project appends the empty-index hint', () => {
    const r = run(['types'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('types: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['types', 'c.ts'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('No type declarations found')
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('callers: unindexed project appends the empty-index hint', () => {
    const r = run(['callers', 'noSuchSymbol'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('callers: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['callers', 'noSuchSymbol'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("No references found for 'noSuchSymbol'")
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('brief: unindexed project appends the empty-index hint', () => {
    const r = run(['brief', 'foo.ts::noSuchSymbol'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('brief: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['brief', 'c.ts::noSuchSymbol'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('Symbol not found: c.ts::noSuchSymbol')
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('dead: unindexed project appends the empty-index hint', () => {
    const r = run(['dead'], nonGitProjectDir, homeDir)
    expect(r.status).toBe(0)
    expect(r.out).toContain('No dead symbols found')
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('dead: indexed project with a genuinely clean result keeps the old message unchanged', () => {
    // Scan for a kind the indexed project genuinely has none of (no classes in c.ts) -- a real
    // "nothing of this kind exists" zero-result, distinct from "never indexed".
    const r = run(['dead', '--kind', 'class'], indexedProjectDir, homeDir)
    expect(r.status).toBe(0)
    expect(r.out).toContain('No dead symbols found.')
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })

  it('call-chain: unindexed project appends the empty-index hint', () => {
    const r = run(['call-chain', 'noSuchSymbol'], nonGitProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain(EMPTY_INDEX_SNIPPET)
  })

  it('call-chain: indexed project with a genuine miss keeps the old message unchanged', () => {
    const r = run(['call-chain', 'noSuchSymbol'], indexedProjectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('Symbol not found: noSuchSymbol')
    expect(r.out).not.toContain(EMPTY_INDEX_SNIPPET)
  })
})
