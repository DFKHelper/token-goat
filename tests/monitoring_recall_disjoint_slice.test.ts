import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Provenance: the command shapes (a monitoring `node scripts/*.mjs` run cached as `| head -20`, then re-run as `| sed -n 40,60p`) are CAPTURE from hint ledger row 26230; the 20 output lines are HAND-DERIVED.

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

let home: string
let work: string
let counter = 0

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(home, 'tg'),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'local'),
    APPDATA: path.join(home, 'roaming'),
    XDG_DATA_HOME: path.join(home, 'local'),
    TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
    TOKEN_GOAT_BASH_COMPRESS: '0',
  }
}

function hook(event: 'pre_tool_use' | 'post_tool_use', session: string, command: string, stdout?: string): string {
  const payload: Record<string, unknown> = { tool_name: 'Bash', tool_input: { command }, session_id: session, cwd: work }
  if (stdout !== undefined) payload.tool_response = { stdout, stderr: '', interrupted: false, isImage: false }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', event, '--harness', 'claudecode'], { cwd: work, env: env(), encoding: 'utf8', timeout: 30000, input: JSON.stringify(payload) })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout ?? ''
}

function recallBytes(): number {
  const res = spawnSync(process.execPath, [BUNDLE, 'stats', '--json', '--full', '--window-days', '0'], { cwd: work, env: env(), encoding: 'utf8', timeout: 30000 })
  const text = res.stdout ?? ''
  const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { by_kind?: Record<string, { bytes_saved?: number }> }
  return parsed.by_kind?.['bash_compress:recall']?.bytes_saved ?? 0
}

const OUTPUT = Array.from({ length: 20 }, (_, i) => 'report row ' + (i + 1) + ' ' + 'x'.repeat(180)).join('\n') + '\n'

function seed(cached: string): string {
  counter += 1
  const session = 'monrecall-' + counter + '-' + Date.now().toString(36)
  hook('pre_tool_use', session, cached)
  hook('post_tool_use', session, cached, OUTPUT)
  return session
}

describe('monitoring recall hint against a sliced cached run', () => {
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-monrecall-home-'))
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-monrecall-work-'))
  })

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(work, { recursive: true, force: true })
  })

  it('sanity: the unsliced re-run of a cached run gets the recall hint', () => {
    const session = seed('node scripts/report.mjs')
    const out = hook('pre_tool_use', session, 'node scripts/report.mjs')
    expect(out).toContain('is cached')
  })

  it('gives no hint and books no saving for a window the cached head -20 cannot hold', () => {
    const session = seed('node scripts/report.mjs | head -20')
    const before = recallBytes()
    const out = hook('pre_tool_use', session, 'node scripts/report.mjs | sed -n 40,60p')
    expect(out).not.toContain('is cached')
    expect(recallBytes() - before).toBe(0)
  })

  it('still hints for a smaller head of the cached head -20, and books its saving', () => {
    const session = seed('node scripts/report.mjs | head -20')
    const before = recallBytes()
    const out = hook('pre_tool_use', session, 'node scripts/report.mjs | head -10')
    expect(out).toContain('is cached')
    expect(recallBytes() - before).toBeGreaterThan(0)
  })

  it('gives no hint for an unsliced re-run of a cached head -20 run', () => {
    const session = seed('node scripts/report.mjs | head -20')
    const out = hook('pre_tool_use', session, 'node scripts/report.mjs')
    expect(out).not.toContain('is cached')
  })

  it('gives no hint when either side carries a pipeline it cannot parse', () => {
    const session = seed('node scripts/report.mjs | grep row')
    const out = hook('pre_tool_use', session, 'node scripts/report.mjs | head -5')
    expect(out).not.toContain('is cached')
  })

  it('leaves no trailing whitespace on the command summary of a long command', () => {
    // 56 characters then a space puts a space at the cut point of the 57-character summary.
    const long = 'node scripts/report.mjs --label ' + 'a'.repeat(24) + ' --note xyz'
    const session = seed(long)
    const out = hook('pre_tool_use', session, long)
    expect(out).toContain('is cached')
    expect(out).not.toMatch(/ \.\.\.`/)
  })
})
