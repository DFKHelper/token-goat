/** Shared fixtures and helpers of tests/recovery_pairs*.test.ts. CAPTURED_FAILURE is FORMAT-DERIVED from tests/fixtures/claude_code_2_1_281/bash_failure.json (PROVENANCE.tsv); the other constants are HAND-DERIVED. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HookEvent } from '../../src/hook_registry.js'
import { sessionStateKey } from '../../src/hook_registry.js'
import { recoveryBashHandler, recoveryEditHandler } from '../../src/hooks_recovery.js'
import { postToolUseFailureWithExtras } from '../../src/hooks_tool_failure.js'
import { loadRecoveryPairs, recoveryProjectKey, recoveryStorePath } from '../../src/recovery_pairs.js'
import { sessionSidecarPath } from '../../src/session_store.js'
import type { HookOutput } from '../../src/types.js'

export const CAPTURED_FAILURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude_code_2_1_281', 'bash_failure.json'), 'utf8')) as Record<string, unknown>

export const MODULE_ERROR = 'Exit code 1\nModuleNotFoundError: No module named foo'
export const INSTALL = 'pip install -r requirements.txt'

export let counter = 0
export function freshProject(): { cwd: string } {
  counter += 1
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), `tg-recovery-${process.pid}-${counter}-`)))
  mkdirSync(cwd, { recursive: true })
  return { cwd }
}

export function gitProject(): { root: string } {
  const { cwd } = freshProject()
  execFileSync('git', ['init', '-q'], { cwd })
  return { root: cwd }
}

export function session(): string {
  counter += 1
  return `recovery-session-${process.pid}-${counter}`
}

export async function failed(sessionId: string, cwd: string, command: string, error = MODULE_ERROR): Promise<HookOutput> {
  const raw = { ...CAPTURED_FAILURE, session_id: sessionId, cwd, tool_input: { command }, error }
  const event: HookEvent = { eventName: 'post_tool_use_failure', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw }
  return postToolUseFailureWithExtras(event)
}

export async function succeeded(sessionId: string, cwd: string, command: string): Promise<void> {
  const raw = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } }
  await recoveryBashHandler({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw })
}

export async function edited(sessionId: string, cwd: string): Promise<void> {
  const raw = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwd, 'a.py') } }
  await recoveryEditHandler({ eventName: 'post_tool_use', toolName: 'Edit', toolInput: { file_path: join(cwd, 'a.py') }, sessionId, agentId: undefined, raw })
}

export function contextOf(out: HookOutput): string {
  return out.hookType === 'context' ? out.context : ''
}

/** One session that fails `command`, runs `between`, then re-runs `command` successfully: a pair learned once. */
export async function teach(cwd: string, command: string, between: string[], error = MODULE_ERROR, success = command): Promise<void> {
  const s = session()
  await failed(s, cwd, command, error)
  for (const step of between) await succeeded(s, cwd, step)
  await succeeded(s, cwd, success)
}

/** Two sessions teaching the same pair, which is what it takes to speak. */
export async function teachTwice(cwd: string, command: string, between: string[], error = MODULE_ERROR, success = command): Promise<void> {
  await teach(cwd, command, between, error, success)
  await teach(cwd, command, between, error, success)
}

export function pairState(cwd: string): Array<[number, number]> {
  return loadRecoveryPairs(cwd).map((p) => [p.helped, p.hurt])
}

export function sidecarPathOf(sessionId: string, suffix: string): string {
  const event: HookEvent = { eventName: 'post_tool_use', toolName: 'Bash', toolInput: {}, sessionId, agentId: undefined, raw: {} }
  return sessionSidecarPath(sessionStateKey(event), suffix) ?? ''
}

export function sidecarText(sessionId: string): string {
  const target = sidecarPathOf(sessionId, '.recovery-pending')
  return target !== '' && existsSync(target) ? readFileSync(target, 'utf8') : ''
}

/** Where the per-install digest key sits: beside the stores, as the module's header documents. */
export function installKeyPath(): string {
  return join(dirname(recoveryStorePath('any')), 'install.key')
}

export function storeText(cwd: string): string {
  const target = recoveryStorePath(recoveryProjectKey(cwd) ?? '')
  return existsSync(target) ? readFileSync(target, 'utf8') : ''
}


/** Every file under `dir`, concatenated: what a grep -r of the directory would see. With `tolerant`, a file that vanishes or can not be read while the walk runs (a sibling test writing under the same home) is skipped. */
export function treeText(dir: string, tolerant = false): string {
  if (!existsSync(dir)) return ''
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return treeText(path, tolerant)
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        if (tolerant) return ''
        throw error
      }
    })
    .join('\n')
}

/** Whether this account may create a symlink: some Windows accounts may not, and the symlink row has nothing to test there. */
export function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'tg-symlink-probe-'))
  try {
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
