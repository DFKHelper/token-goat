/** `doctor` and `doctor --repair` against the installed Claude Code hook matchers, run through the built bundle because the defect lived in what the CLI process had loaded, not in any function a unit test calls. The doctor process never imported relay.ts, so the hook registry toolMatcherFor reads held only the handlers its own imports happened to reach: measured on 2.9.30, a `doctor --repair` that rewrote the hooks (one event deleted from settings.json) left PreToolUse matching `^Read$|^Grep$` and PostToolUse on the catch-all. And nothing compared an installed matcher with the one the build derives, so an install from before the PreToolUse MCP matcher was narrowed kept its `^mcp__` with no doctor row and no repair. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')

/** The PreToolUse matcher 2.9.30 installed, read off a real settings.json, before the MCP handlers declared narrower patterns. */
const PRE_2_9_30_MATCHER = '^Read$|^Grep$|^Glob$|^Write$|^WebFetch$|^Skill$|^Bash$|^mcp__|^WebSearch$|^Agent$|^task$|^Task$|^spawn_agent$'

let home: string
let project: string

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: project,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, HOME: home, USERPROFILE: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1' },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

interface Settings {
  hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>
}

const settingsFile = (): string => path.join(project, '.claude', 'settings.json')
const readSettings = (): Settings => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Settings
const writeSettings = (s: Settings): void => fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
const matchers = (): Record<string, string | undefined> => {
  const s = readSettings()
  return { PreToolUse: s.hooks['PreToolUse']?.[0]?.matcher, PostToolUse: s.hooks['PostToolUse']?.[0]?.matcher }
}

function doctorRow(name: string): { status: string; message: string } | undefined {
  const r = run(['doctor', '--json'])
  const rows = JSON.parse(r.stdout) as Array<{ name: string; status: string; message: string }>
  return rows.find((row) => row.name === name)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-matcher-'))
  project = path.join(home, 'project')
  fs.mkdirSync(project)
  expect(run(['install', '--project', '--no-index']).status).toBe(0)
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('doctor and the installed hook matchers (built bundle)', () => {
  it('flags an install that still matches every MCP tool on PreToolUse, and doctor --repair narrows it to what install writes', () => {
    const fresh = matchers()
    expect(fresh.PreToolUse).not.toContain('^mcp__|')
    expect(doctorRow('Claude Code hook matchers'), 'a fresh install read against a partial registry would look stale').toBeUndefined()

    const s = readSettings()
    const pre = s.hooks['PreToolUse']?.[0]
    if (pre === undefined) throw new Error('no PreToolUse group installed')
    pre.matcher = PRE_2_9_30_MATCHER
    writeSettings(s)

    const row = doctorRow('Claude Code hook matchers')
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain('project scope matches PreToolUse')
    expect(row?.message).toContain('token-goat install --project')

    run(['doctor', '--repair'])
    expect(matchers()).toEqual(fresh)
    expect(doctorRow('Claude Code hook matchers')).toBeUndefined()
  })

  it('keeps every handler in both tool matchers when a repair rewrites the hooks', () => {
    const fresh = matchers()
    const s = readSettings()
    delete s.hooks['PostToolUse']
    writeSettings(s)

    run(['doctor', '--repair'])
    expect(matchers()).toEqual(fresh)
  })
})
