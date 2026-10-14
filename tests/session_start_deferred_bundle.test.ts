import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'

// Provenance: HAND-DERIVED for every expectation. The reminder phrases are read off the user-facing wording in src/session_reminder.ts (GENERIC_REMINDER 'prefer surgical reads', NOTE_REMINDER 'must outlive a compaction'), not produced by calling the matcher. The shim argv shape (event, entry path, --session-start-deadline=<epoch>) is FORMAT-DERIVED from COPILOT_CLI_HOOK_SCRIPT in src/bridges/copilot_cli.ts. The doctor line is FORMAT-DERIVED from checkDeferredSessionStarts in src/cli_doctor.ts. Every row spawns the built dist/token-goat.mjs with its own isolated home; nothing is injected, and no row asserts an elapsed time.

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const REMINDER_PHRASE = 'must outlive a compaction'
const NONE_LINE = 'none -- every session start finished inside its budget'
const roots: string[] = []

interface Fixture {
  root: string
  project: string
  home: string
  shim: string
  env: NodeJS.ProcessEnv
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'tg-deferred-bundle-'))
  roots.push(root)
  const dirs = Object.fromEntries(['home', 'project', 'tmp', 'data', 'appdata', 'claude', 'copilot', 'codex', 'xdgconfig'].map((name) => [name, join(root, name)]))
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const shim = join(root, 'shim.cjs')
  writeFileSync(shim, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirs['home'],
    USERPROFILE: dirs['home'],
    TOKEN_GOAT_HOME: join(root, 'tghome'),
    LOCALAPPDATA: dirs['data'],
    XDG_DATA_HOME: dirs['data'],
    XDG_CONFIG_HOME: dirs['xdgconfig'],
    APPDATA: dirs['appdata'],
    CLAUDE_CONFIG_DIR: dirs['claude'],
    COPILOT_HOME: dirs['copilot'],
    CODEX_HOME: dirs['codex'],
    TEMP: dirs['tmp'],
    TMP: dirs['tmp'],
    TOKEN_GOAT_HOOK_SERVER: '0',
    TOKEN_GOAT_NATIVE_HOOKS: '0',
    TOKEN_GOAT_EMBED: '0',
    TOKEN_GOAT_NO_WORKER_SPAWN: '1',
  }
  delete env['TOKEN_GOAT_HARNESS_OVERRIDE']
  return { root, project: dirs['project'] as string, home: join(root, 'tghome'), shim, env }
}

function exec(argv: string[], fixture: Fixture, extraEnv: NodeJS.ProcessEnv, input: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: fixture.project, env: { ...fixture.env, ...extraEnv }, stdio: 'pipe', windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.stdin.on('error', () => undefined)
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

function hook(fixture: Fixture, event: string, harness: string, payload: Record<string, unknown>): Promise<Run> {
  return exec([BUNDLE, 'hook', event], fixture, { TOKEN_GOAT_HARNESS_OVERRIDE: harness }, JSON.stringify(payload))
}

function startPayload(fixture: Fixture, sessionId: string): Record<string, unknown> {
  return { session_id: sessionId, cwd: fixture.project, hook_event_name: 'SessionStart', source: 'startup' }
}

function toolPayload(fixture: Fixture, sessionId: string): Record<string, unknown> {
  return { session_id: sessionId, cwd: fixture.project, hook_event_name: 'PostToolUse', tool_name: 'TgDeferredProbe', tool_input: {}, tool_response: { output: 'raw' } }
}

/** The text of every dirty.txt under the fixture root; the data directory's depth differs per platform, so it is searched for rather than spelled. */
function queuedPaths(fixture: Fixture): string {
  const found = readdirSync(fixture.root, { recursive: true, encoding: 'utf8' }).filter((entry) => entry.endsWith('dirty.txt') && entry.includes('queue'))
  return found.map((entry) => readFileSync(join(fixture.root, entry), 'utf8')).join('\n')
}

function occurrences(text: string): number {
  return text.split(REMINDER_PHRASE).length - 1
}

/** The shipping shim running a start that begins and never settles: it reads the payload inside its own live deadline (so it stamps the start as begun), then its helper entry hangs and the start fails open with `{}`. A past deadline would fail before any payload is read, a start no session key can be tied to. */
async function deferredStart(fixture: Fixture, sessionId: string): Promise<Run> {
  const hang = join(fixture.root, 'hang_entry.cjs')
  writeFileSync(hang, 'setInterval(() => {}, 1000)', 'utf8')
  const payload = { sessionId, workingDirectory: fixture.project, source: 'startup' }
  return exec([fixture.shim, 'sessionStart', hang], fixture, {}, JSON.stringify(payload))
}

async function doctorLine(fixture: Fixture): Promise<string> {
  const run = await exec([BUNDLE, 'doctor'], fixture, {}, '')
  const line = run.stdout.split(/\r?\n/).find((candidate) => candidate.includes('Deferred session starts'))
  expect(line, run.stdout + run.stderr).toBeDefined()
  return line as string
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('built bundle: deferred session start (R2, R5, R8, R9)', () => {
  it('R2: a start that failed open is delivered on the first copilot_cli tool call, with the drift sweep', async () => {
    expect(existsSync(BUNDLE), 'build dist/token-goat.mjs before this test').toBe(true)
    const fixture = makeFixture()
    writeFileSync(join(fixture.project, 'seen.ts'), 'export const seen = 1\n', 'utf8')
    for (const args of [['init', '--quiet'], ['add', 'seen.ts']]) {
      const git = spawnSync('git', args, { cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true })
      expect(git.status, git.stderr).toBe(0)
    }
    const indexed = await exec([BUNDLE, 'index', '.'], fixture, {}, '')
    expect(indexed.code, indexed.stdout + indexed.stderr).toBe(0)
    writeFileSync(join(fixture.project, 'seen.ts'), 'export const seen = 2222222\n', 'utf8')

    const sid = 'bundle-r2-session'
    const start = await deferredStart(fixture, sid)
    expect(start.stdout).toBe('{}')

    const first = await hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid))
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toContain('this project is indexed')
    expect(occurrences(first.stdout), first.stdout).toBe(1)
    expect(first.stdout).toContain('reindexing 1 file that changed outside this session')
    expect(queuedPaths(fixture)).toContain('seen.ts')

    const second = await hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid))
    expect(occurrences(second.stdout), second.stdout).toBe(0)
  }, 120_000)

  it('R5: two concurrent first tool calls for one owed session deliver the reminder exactly once', async () => {
    const fixture = makeFixture()
    const sid = 'bundle-r5-session'
    expect((await deferredStart(fixture, sid)).stdout).toBe('{}')
    const [a, b] = await Promise.all([
      hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid)),
      hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid)),
    ])
    expect(occurrences(a.stdout) + occurrences(b.stdout), `${a.stdout}\n---\n${b.stdout}`).toBe(1)
  }, 120_000)

  it('R8: doctor names the deferred count after one deferral', async () => {
    const fixture = makeFixture()
    const sid = 'bundle-r8-session'
    expect((await deferredStart(fixture, sid)).stdout).toBe('{}')
    const first = await hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid))
    expect(occurrences(first.stdout), first.stdout).toBe(1)
    await hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid))
    expect(await doctorLine(fixture)).toContain('1 session start missed the shim deadline and was delivered on the first tool call')
  }, 120_000)

  it('R9: a start that failed before it read its payload leaves no session start owed', async () => {
    const fixture = makeFixture()
    const sid = 'bundle-r9-session'
    const past = Date.now() - 60_000
    // No payload ever arrives: a payload that did arrive would have been stamped begun and owed, which tests/bridges/copilot_session_start_late_payload.test.ts pins.
    const start = await exec([fixture.shim, 'sessionStart', BUNDLE, `--session-start-deadline=${past}`], fixture, {}, '')
    expect(start.stdout).toBe('{}')
    const first = await hook(fixture, 'post_tool_use', 'copilot_cli', toolPayload(fixture, sid))
    expect(occurrences(first.stdout), first.stdout).toBe(0)
  }, 120_000)
})

// Hosts that install a session-start hook: claudecode (src/install.ts SessionStart), codex (src/bridges/codex.ts), copilot_cli and vscode (src/bridges/copilot_cli_install.ts, vscode_install.ts), kimi (src/bridges/kimi_install.ts KIMI_EVENT_ARG). copilot_cli and vscode are the two where sessionStartMayBeDeferred is true (src/harness_channels.ts).
const HOSTS: Array<{ host: string; mayDefer: boolean }> = [
  { host: 'copilot_cli', mayDefer: true },
  { host: 'vscode', mayDefer: true },
  { host: 'claudecode', mayDefer: false },
  { host: 'codex', mayDefer: false },
  { host: 'kimi', mayDefer: false },
]

describe('built bundle: the reminder is delivered exactly once per host (A-or-B)', () => {
  for (const { host, mayDefer } of HOSTS) {
    it(`${host}: session_start then the first post_tool_use carry the reminder once between them`, async () => {
      const fixture = makeFixture()
      const sid = `bundle-ab-${host}`
      const start = await hook(fixture, 'session_start', host, startPayload(fixture, sid))
      expect(start.code, start.stderr).toBe(0)
      const first = await hook(fixture, 'post_tool_use', host, toolPayload(fixture, sid))
      expect(first.code, first.stderr).toBe(0)
      expect(occurrences(start.stdout) + occurrences(first.stdout), `${start.stdout}\n---\n${first.stdout}`).toBe(1)
      if (!mayDefer) {
        expect(occurrences(start.stdout), start.stdout).toBe(1)
        expect(await doctorLine(fixture)).toContain(NONE_LINE)
      }
    }, 120_000)
  }
})
