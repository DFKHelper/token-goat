/**
 * Guard: token-goat's JSON/YAML commands (`json-query`, `yaml-query`, `json-outline`,
 * `yaml-outline`) must be discoverable from the surfaces a model sees without asking for them.
 *
 * They were not. Every unprompted surface -- the shared guidance body written into CLAUDE.md,
 * AGENTS.md, copilot-instructions.md and SKILL.md, and the SessionStart reminder -- listed only
 * code-shaped commands. The guidance body even named `config-get file KEY`, so the absence of a
 * JSON command read as a deliberate statement ("config has a command, JSON data does not")
 * rather than as an omission. Probing then confirmed the wrong conclusion: `symbol
 * better-sqlite3` answered `No matches` plus `Did you mean: sql`, a confident negative with a
 * suggestion pointing away from the answer, because JSON files are indexed only to depth 1.
 *
 * This file covers the third surface: a `symbol` miss on a name that really is a nested
 * JSON/YAML key must name the exact dot-path, so the next command is copy-pasteable. Asserted
 * end-to-end against the built bundle, including running the suggested command verbatim -- a
 * hint that prints a path the tool then rejects would be worse than silence. The other two
 * surfaces are covered in tests/install_claude_md_skill.test.ts and
 * tests/hooks_session_start.test.ts.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { findStructuredKeyPath } from '../../src/read_commands.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
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

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-structdisc-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'tg-structdisc-proj-'))
  // `sql` exists so the near-name ranker really produces "Did you mean: sql" for `better-sqlite3` -- the misleading-suggestion case is precisely the one the pointer has to correct, so the coexistence test must exercise it rather than the semantic fallback.
  writeFileSync(join(projectDir, 'a.ts'), 'export function alpha(x: number): number { return x + 1 }\nexport function sql(q: string): string { return q }\n')
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'better-sqlite3': '^11.3.0' } }, null, 2) + '\n',
  )
  run(['index', '.', '--walk'], projectDir, homeDir)
})

describe('structured-data discoverability', () => {
  it('symbol miss on a real nested JSON key names the dot-path, and the suggested command works', () => {
    const r = run(['symbol', 'better-sqlite3'], projectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("No matches for 'better-sqlite3'")
    expect(r.out).toContain('is a key in package.json at dependencies.better-sqlite3')
    expect(r.out).toContain("token-goat json-query package.json 'dependencies.better-sqlite3'")
    const q = run(['json-query', 'package.json', 'dependencies.better-sqlite3'], projectDir, homeDir)
    expect(q.status).toBe(0)
    expect(q.out.trim()).toBe('"^11.3.0"')
  })

  it('symbol miss coexists with the did-you-mean suggestion rather than replacing it', () => {
    const r = run(['symbol', 'better-sqlite3'], projectDir, homeDir)
    expect(r.out).toContain('Did you mean:')
    expect(r.out).toContain('sql')
    expect(r.out).toContain('is a key in package.json at dependencies.better-sqlite3')
  })

  it('symbol miss on a genuinely unknown name adds nothing', () => {
    const r = run(['symbol', 'zzzNoSuchThingAnywhere'], projectDir, homeDir)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("No matches for 'zzzNoSuchThingAnywhere'")
    expect(r.out).not.toContain('is a key in')
    expect(r.out).not.toContain('json-query')
  })

  it('symbol --json miss output stays byte-identical (no prose appended)', () => {
    const r = run(['symbol', 'better-sqlite3', '--json'], projectDir, homeDir)
    expect(r.out).not.toContain('is a key in')
    expect(r.out).not.toContain('json-query')
  })

  it('findStructuredKeyPath: non-firing guard -- valid top-level-only names are never claimed as nested keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-structdisc-nonfire-'))
    const file = join(dir, 'package.json')
    writeFileSync(file, JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { alpha: '1' } }, null, 2))
    const topLevelNames = ['name', 'version', 'dependencies']
    expect(topLevelNames.length).toBeGreaterThan(0)
    for (const n of topLevelNames) {
      expect(findStructuredKeyPath(n, [file])).toBeNull()
    }
    // And the rule still fires for the thing it is for, so the guard is not passing by being dead.
    expect(findStructuredKeyPath('alpha', [file])?.dotPath).toBe('dependencies.alpha')
  })

  it('findStructuredKeyPath: skips files over the byte cap instead of parsing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-structdisc-big-'))
    const file = join(dir, 'huge.json')
    const filler: Record<string, string> = {}
    for (let i = 0; i < 20_000; i++) filler[`k${i}`] = 'x'.repeat(20)
    writeFileSync(file, JSON.stringify({ deps: { needle: '1' }, filler }))
    expect(findStructuredKeyPath('needle', [file])).toBeNull()
  })

  it('findStructuredKeyPath: swallows malformed JSON and keeps scanning later files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-structdisc-bad-'))
    const bad = join(dir, 'broken.json')
    const good = join(dir, 'good.json')
    writeFileSync(bad, '{ this is not json at all ,,, ')
    writeFileSync(good, JSON.stringify({ deps: { needle: '1' } }))
    expect(() => findStructuredKeyPath('needle', [bad])).not.toThrow()
    expect(findStructuredKeyPath('needle', [bad])).toBeNull()
    expect(findStructuredKeyPath('needle', [bad, good])?.dotPath).toBe('deps.needle')
  })

  it('findStructuredKeyPath: resolves YAML nested keys and suggests yaml-query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-structdisc-yaml-'))
    const file = join(dir, 'conf.yaml')
    writeFileSync(file, 'server:\n  listenPort: 8080\n')
    const hit = findStructuredKeyPath('listenPort', [file])
    expect(hit?.dotPath).toBe('server.listenPort')
    expect(hit?.command).toBe('yaml-query')
  })
})
