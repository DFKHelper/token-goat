/**
 * Kimi Code wire-format contract (real bundle, real shim, real handlers).
 *
 * Kimi's stdout parser reads exactly three things (`structuredOutput()` in
 * MoonshotAI/kimi-code `packages/agent-core-v2/src/agent/externalHooks/runner.ts`):
 * a top-level `message`, `hookSpecificOutput.message`, and
 * `hookSpecificOutput.permissionDecision` / `permissionDecisionReason`. It
 * understands none of token-goat's own Claude-Code-shaped fields, so these
 * tests drive the real KIMI_HOOK_SCRIPT against the real built bundle and
 * assert the literal bytes Kimi would actually receive.
 *
 * Every payload here uses Kimi's own key spelling (`tool_input.path`, not
 * `file_path`), which is what makes these tests also cover the kimi branch of
 * normalizePayload: if that rename regressed, the handler would see no path,
 * emit nothing, and the deny/hint assertions below would fail.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KIMI_HOOK_SCRIPT } from '../src/bridges/kimi.js'

import { BUNDLE, ROOT } from './helpers/bundle.js'

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Isolated data root shared by every run in this file. The bundle resolves its
 * config from here (dataDir() in src/constants.ts), and these fixtures re-read a
 * file once, immediately: hints.protect_recent_reads defaults to 4, which would
 * exempt exactly that shape from the re-read deny under test. Pinned to 0 for the
 * same reason tests/hook_event_harness_matrix.test.ts pins it.
 */
let dataBase: string

beforeAll(() => {
  dataBase = mkIsolated('tg-kimi-wire-data-')
  const configDir =
    process.platform === 'win32' ? path.join(dataBase, 'dfk-helper', 'token-goat') : path.join(dataBase, 'token-goat')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.toml'), `[hints]
protect_recent_reads = 0
`, 'utf8')
}, 30000)

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

/**
 * Isolated environment for a shim run. Deliberately does NOT set
 * TOKEN_GOAT_HARNESS_OVERRIDE: the shim is supposed to set it itself, because
 * Kimi Code publishes no ambient per-session variable identifying its hook
 * subprocesses. If the shim stopped doing that, the `path` -> `file_path`
 * remap would never run and these tests would fail.
 */
function kimiEnv(base: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: dataBase,
    XDG_DATA_HOME: dataBase,
    HOME: base,
    USERPROFILE: base,
  }
  delete env['TOKEN_GOAT_HARNESS_OVERRIDE']
  return env
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs the real Kimi shim exactly as Kimi Code would: event arg, baked entry path, payload on stdin. */
function runKimiShim(cwd: string, eventArg: string, payload: unknown, env: NodeJS.ProcessEnv, spawnCwd = cwd): RunResult {
  const scriptPath = path.join(cwd, 'token-goat-shim.js')
  fs.writeFileSync(scriptPath, KIMI_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg, BUNDLE], {
    cwd: spawnCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('Kimi wire format: deny', () => {
  it('reshapes a bundle deny into hookSpecificOutput.permissionDecision "deny" with a reason, which is the only block shape Kimi honours on exit 0', () => {
    const cwd = mkIsolated('tg-kimi-wire-deny-')
    const sessionId = 'kimi-wire-deny'
    const filePath = path.join(cwd, 'large.bin')
    // >50KB non-source file, denied outright on the second read -- the same fixture
    // tests/hook_event_harness_matrix.test.ts uses for its deny-shape cases, run with
    // the repository as the working directory for the same reason it does.
    fs.writeFileSync(filePath, 'x'.repeat(60 * 1024))
    const payload = { tool_name: 'Read', tool_input: { path: filePath }, session_id: sessionId }
    const env = kimiEnv(cwd)

    const first = runKimiShim(cwd, 'pre_tool_use', payload, env, ROOT)
    expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)
    const second = runKimiShim(cwd, 'pre_tool_use', payload, env, ROOT)
    expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)

    const parsed = JSON.parse(second.stdout) as {
      message?: string
      decision?: string
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
    }
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput?.permissionDecisionReason ?? '').toContain('was already read this session')
    expect(parsed.message ?? '').toContain('was already read this session')
    // Claude Code's own deny shape must not survive: Kimi ignores it outright.
    expect(parsed.decision).toBeUndefined()
  })
})

describe('Kimi wire format: hint', () => {
  it('maps a bundle context hint onto the top-level `message` field Kimi reads, dropping additionalContext', () => {
    const cwd = mkIsolated('tg-kimi-wire-hint-')
    const sessionId = 'kimi-wire-hint'
    const filePath = path.join(cwd, 'small.txt')
    fs.writeFileSync(filePath, 'hello from the kimi wire-format test\n')
    const payload = { tool_name: 'Read', tool_input: { path: filePath }, session_id: sessionId }
    const env = kimiEnv(cwd)

    const first = runKimiShim(cwd, 'pre_tool_use', payload, env)
    expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)

    const second = runKimiShim(cwd, 'pre_tool_use', payload, env)
    expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)

    const parsed = JSON.parse(second.stdout) as {
      message?: string
      systemMessage?: string
      hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string }
    }
    expect(typeof parsed.message).toBe('string')
    expect(parsed.message ?? '').toContain('already read this session')
    expect(parsed.hookSpecificOutput?.additionalContext).toBeUndefined()
    expect(parsed.systemMessage).toBeUndefined()
    // A hint must never read as a block.
    expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })
})

describe('Kimi wire format: no-op', () => {
  it('writes nothing at all for a pass, because Kimi injects raw stdout into the model context when a structured response carries no message', () => {
    const cwd = mkIsolated('tg-kimi-wire-noop-')
    const filePath = path.join(cwd, 'fresh.txt')
    fs.writeFileSync(filePath, 'first ever read\n')
    const payload = { tool_name: 'Read', tool_input: { path: filePath }, session_id: 'kimi-wire-noop' }

    const res = runKimiShim(cwd, 'pre_tool_use', payload, kimiEnv(cwd))

    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    expect(res.stdout).toBe('')
    // The literal two-character '{}' is the specific regression this guards:
    // on UserPromptSubmit Kimi would append it verbatim to the conversation.
    expect(res.stdout).not.toContain('{}')
  })

  it('writes nothing and exits 0 for an unknown event name, so a stale hook entry cannot break a turn', () => {
    const cwd = mkIsolated('tg-kimi-wire-badevent-')
    const res = runKimiShim(cwd, 'not_a_real_event', { tool_name: 'Read' }, kimiEnv(cwd))
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })
})
