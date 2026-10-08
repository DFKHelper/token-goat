/** A hook whose payload reaches stdin later than the old 5 s idle window must still be read. Under CPU starvation (50 busy processes, measured) a hook's idle timer fired before the first byte of a payload written at spawn, readStdinJson rejected, and relay turned that into `{}`: exit 0, no hint, one stderr line. The bundle is spawned for real, so this goes through the shipping hook entry, not an injected reader. */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
/** Past DEFAULT_STDIN_TIMEOUT_MS (5000), inside the widened first-byte window. */
const LATE_MS = 6500

let homeDir: string
let projectDir: string
let file: string

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-latestdin-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'tg-latestdin-'))
  file = join(projectDir, 'ordinary.ts')
  writeFileSync(file, 'export const ordinary = 1\n')
})

function lateHook(harness: string, payload: unknown): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], {
      cwd: projectDir,
      env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, HOME: homeDir, USERPROFILE: homeDir, TOKEN_GOAT_HARNESS_OVERRIDE: harness, TOKEN_GOAT_HOOK_SERVER: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin.on('error', () => undefined)
    setTimeout(() => child.stdin.end(JSON.stringify(payload)), LATE_MS)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

describe('the hook entry on a payload that arrives after the old idle window', () => {
  // FORMAT-DERIVED: Claude Code's PreToolUse input (tool_name, tool_input.file_path, session_id) per https://code.claude.com/docs/en/hooks.md
  it('reads a Claude Code payload', async () => {
    const res = await lateHook('claudecode', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, session_id: 'late-cc' })
    expect(res.status).toBe(0)
    expect(res.stderr).not.toMatch(/tool_name missing|timed out waiting for stdin/)
  }, 60_000)

  // FORMAT-DERIVED: Codex's PreToolUse input (hook_event_name, tool_name, tool_input.command, cwd, session_id) as src/bridges/codex.ts relays it
  it('reads a Codex payload', async () => {
    const res = await lateHook('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${file}` }, cwd: projectDir, session_id: 'late-cx' })
    expect(res.status).toBe(0)
    expect(res.stderr).not.toMatch(/tool_name missing|timed out waiting for stdin/)
  }, 60_000)

  // Copilot CLI is covered by construction rather than by this test: its shim (src/bridges/copilot_cli.ts) reads stdin with a blocking readFileSync(0) and has no idle timer to lose the race.
})
