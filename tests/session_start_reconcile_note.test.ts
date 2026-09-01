/**
 * The session_start hook runs the drift sweep and says so only when it found something.
 *
 * This is the wiring that makes reconciliation automatic rather than a command nobody remembers to
 * run, and it sits on the hook path this repo's own measurement says is dominated by startup cost.
 * So there are two failure directions, not one: a hook that never repairs anything, and a hook
 * that narrates on every session start and charges for the line. Both have cases here.
 *
 * The sweep is also the one piece of this hook that touches every tracked file, so "never throws"
 * is a property and not an aspiration: a session_start handler that threw would cost the agent the
 * routing reminder the hook exists to deliver, on every session, to fix a stale symbol lookup.
 *
 * Provenance: CAPTURE. Every expectation is measured from real `token-goat hook session_start`
 * runs against a real indexed temp project, driving the built bundle over the same stdin JSON
 * shape the harness sends. No expected string is transcribed from `hooks_session_start.ts`.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function cli(args: string[], extraEnv: Record<string, string> = {}): { out: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, ...extraEnv },
  })
  return { out: res.stdout ?? '', code: res.status ?? -1 }
}

/** Fire session_start the way the harness does, and return the injected context string. */
function sessionStartContext(extraEnv: Record<string, string> = {}): string {
  const payload = JSON.stringify({ cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' })
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'session_start'], {
    cwd: projectDir,
    encoding: 'utf-8',
    input: payload,
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, ...extraEnv },
  })
  expect(res.status, `the session_start hook exited ${res.status}; it must never fail the session`).toBe(0)
  const parsed = JSON.parse(res.stdout ?? '{}') as { hookSpecificOutput?: { additionalContext?: string } }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-ss-recon-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-ss-recon-home-'))

  writeFileSync(join(projectDir, 'alpha.ts'), 'export function alpha(): number {\n  return 1\n}\n')
  writeFileSync(join(projectDir, 'beta.ts'), 'export function beta(): number {\n  return 2\n}\n')
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  expect(cli(['index', '.']).code, 'indexing the fixture failed').toBe(0)
})

describe('session_start reconciliation', () => {
  it('delivers the routing reminder and no drift line when the index already matches disk', () => {
    const context = sessionStartContext()
    // Calibration: the hook is doing its normal job here, so a later "the drift line appeared"
    // assertion is measuring the sweep and not the hook simply always emitting the same text.
    expect(context, 'the hook injected no context at all').toContain('token-goat:')
    expect(context.toLowerCase(), 'a clean index produced a drift line anyway').not.toContain('changed outside this session')
  })

  it('names the drift after a file is edited with no hook watching', () => {
    // Written straight to disk, which is what an editor or a pull in another terminal does. No
    // token-goat code path sees this happen -- that absence is the whole point.
    writeFileSync(join(projectDir, 'alpha.ts'), 'export function alpha(): number {\n  return 4242\n}\n')
    const context = sessionStartContext()
    expect(context).toContain('changed outside this session')
    // The routing reminder still has to survive: the drift line is added to the hook's output, not
    // substituted for it.
    expect(context).toContain('symbol')
  })

  it('goes quiet again once the drift has been reconciled', () => {
    // The previous case queued the file; draining it and reindexing must return the hook to
    // silence. A note that never clears is a permanent tax and stops meaning anything.
    expect(cli(['index', '.']).code).toBe(0)
    const context = sessionStartContext()
    expect(context, 'the drift note persisted after the index was brought up to date').not.toContain('changed outside this session')
  })

  it('can be switched off entirely without breaking the hook', () => {
    writeFileSync(join(projectDir, 'beta.ts'), 'export function beta(): number {\n  return 9999\n}\n')
    const withSweep = sessionStartContext()
    expect(withSweep, 'the fixture produced no drift, so the opt-out case proves nothing').toContain('changed outside this session')

    const withoutSweep = sessionStartContext({ TOKEN_GOAT_RECONCILE: '0' })
    expect(withoutSweep).not.toContain('changed outside this session')
    // Still a working hook, not a silenced one: the reminder it exists to deliver is intact.
    expect(withoutSweep).toContain('token-goat:')
  })
})
