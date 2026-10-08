/** `doctor` on a machine wired for Codex CLI and Copilot CLI checks both hosts' config files and still creates no global.db, and the lookups that answer "nothing found" leave it absent too. Provenance: CAPTURE for the install destinations and the doctor row names (`install --codex`, `install --copilot` and `doctor` run through dist/token-goat.mjs in an isolated lab home, 2026-10-08); the no-file assertion is HAND-DERIVED from the contract. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')

let root: string
let home: string
let copilotHome: string
let data: string
let project: string

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: project,
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      TOKEN_GOAT_HOME: data,
      LOCALAPPDATA: data,
      XDG_DATA_HOME: data,
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: copilotHome,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
      TOKEN_GOAT_NO_WORKER_SPAWN: '1',
    },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

function globalDbFiles(dir: string): string[] {
  const found: string[] = []
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...globalDbFiles(full))
    else if (entry.name.startsWith('global.db')) found.push(full)
  }
  return found
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-hosts-'))
  home = path.join(root, 'home')
  copilotHome = path.join(root, 'copilot')
  data = path.join(root, 'data')
  project = path.join(root, 'proj')
  for (const d of [home, copilotHome, data, project]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"hosts","version":"0.0.0"}\n')
  expect(run(['install', '--codex']).status).toBe(0)
  expect(run(['install', '--copilot']).status).toBe(0)
  // Installing is a writer and may create the database; what is under test is what a read does afterwards.
  for (const f of globalDbFiles(data)) fs.rmSync(f, { force: true })
}, 180_000)

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('doctor and lookups on a Codex CLI and Copilot CLI machine', () => {
  it('wrote both hosts config files', () => {
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(true)
    expect(fs.existsSync(path.join(copilotHome, 'hooks', 'token-goat.json'))).toBe(true)
    expect(fs.existsSync(path.join(copilotHome, 'copilot-instructions.md'))).toBe(true)
  })

  it('doctor checks both hosts, names the missing database, and creates none', () => {
    const r = run(['doctor'])
    expect(r.out).toContain('Codex: hook shim')
    expect(r.out).toContain('Copilot CLI: preToolUse hook invokes cleanly')
    expect(r.out).toContain('Database: global.db not found')
    expect(globalDbFiles(data)).toEqual([])
  })

  it('doctor --json reports both hosts without a failure and creates none', () => {
    const r = run(['doctor', '--json'])
    const rows = JSON.parse(r.out) as Array<{ name: string; status: string }>
    for (const name of ['Codex', 'Copilot CLI']) {
      const row = rows.find((x) => x.name === name)
      expect(row, name).toBeDefined()
      expect(row?.status, name).toBe('ok')
    }
    expect(globalDbFiles(data)).toEqual([])
  })

  it('a lookup answers "nothing found" and creates none', () => {
    expect(run(['symbol', 'foo']).out).toContain('No matches for "foo"')
    expect(globalDbFiles(data)).toEqual([])
  })
})
