/** Failure-recovery pairs (src/recovery_pairs.ts). Fixtures: the failed Bash payload is CAPTURE (tests/fixtures/claude_code_2_1_281/bash_failure.json, PROVENANCE.tsv); the successful Bash payload is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (PostToolUse: tool_name, tool_input.command, tool_response); the Copilot payload is FORMAT-DERIVED from tests/fixtures/harness_hook_payloads.ts (COPILOT_SCHEMA, PostToolUseFailureHookInput) as src/hook_adapters.ts canonicalizes it; command strings, error texts and expected fixes are HAND-DERIVED from the pairing rule. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

import type { HookEvent } from '../src/hook_registry.js'
import { recoveryBashHandler, recoveryEditHandler } from '../src/hooks_recovery.js'
import { postToolUseFailureWithExtras } from '../src/hooks_tool_failure.js'
import { isLearnableCommand, isRetired, learnableFix, loadRecoveryPairs, MAX_FIX_CHARS, recoveryProjectKey, recoveryStorePath, splitCommandPrefix } from '../src/recovery_pairs.js'
import type { HookOutput } from '../src/types.js'

const CAPTURED_FAILURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude_code_2_1_281', 'bash_failure.json'), 'utf8')) as Record<string, unknown>

let counter = 0
function freshProject(): { cwd: string } {
  counter += 1
  const cwd = mkdtempSync(join(tmpdir(), `tg-recovery-${process.pid}-${counter}-`))
  mkdirSync(cwd, { recursive: true })
  return { cwd }
}

function session(): string {
  counter += 1
  return `recovery-session-${process.pid}-${counter}`
}

async function failed(sessionId: string, cwd: string, command: string, error = 'Exit code 1\nModuleNotFoundError: No module named foo'): Promise<HookOutput> {
  const raw = { ...CAPTURED_FAILURE, session_id: sessionId, cwd, tool_input: { command }, error }
  const event: HookEvent = { eventName: 'post_tool_use_failure', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw }
  return postToolUseFailureWithExtras(event)
}

async function succeeded(sessionId: string, cwd: string, command: string): Promise<void> {
  const raw = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } }
  await recoveryBashHandler({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw })
}

async function edited(sessionId: string, cwd: string): Promise<void> {
  const raw = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwd, 'a.py') } }
  await recoveryEditHandler({ eventName: 'post_tool_use', toolName: 'Edit', toolInput: { file_path: join(cwd, 'a.py') }, sessionId, agentId: undefined, raw })
}

function contextOf(out: HookOutput): string {
  return out.hookType === 'context' ? out.context : ''
}

describe('splitCommandPrefix', () => {
  it('splits at the last top-level && or ; and peels wrappers off the core', () => {
    expect(splitCommandPrefix('source .venv/bin/activate && pytest -q')).toMatchObject({ prefix: 'source .venv/bin/activate &&', core: 'pytest -q' })
    expect(splitCommandPrefix('npx vitest run')).toMatchObject({ prefix: '', run: 'npx vitest run', core: 'vitest run' })
    expect(splitCommandPrefix('FOO=1 uv run pytest')).toMatchObject({ core: 'pytest' })
    expect(splitCommandPrefix('env CI=1 npx -y tsc')).toMatchObject({ core: 'tsc' })
  })

  it('does not split on || or on a separator inside quotes', () => {
    expect(splitCommandPrefix('false || pytest')).toMatchObject({ prefix: '', core: 'false || pytest' })
    expect(splitCommandPrefix('echo "a && b"')).toMatchObject({ prefix: '', core: 'echo "a && b"' })
  })
})

describe('learnableFix', () => {
  it('learns the commands run between the failure and the success', () => {
    expect(learnableFix('pytest', 'pytest', ['pip install foo'])).toBe('pip install foo')
    expect(learnableFix('pytest', 'pytest', ['pip install foo', 'pip install bar', 'pip install baz'])).toBe('pip install bar && pip install baz')
  })

  it('learns the prefix when the success is the same command behind one', () => {
    expect(learnableFix('pytest -q', 'source .venv/bin/activate && pytest -q', [])).toBe('source .venv/bin/activate && pytest -q')
    expect(learnableFix('vitest run', 'npx vitest run', [])).toBe('npx vitest run')
    expect(learnableFix('pytest', 'env PYTHONPATH=src pytest', [])).toBe('env PYTHONPATH=src pytest')
  })

  it('learns nothing from a rerun with nothing in between', () => {
    expect(learnableFix('pytest', 'pytest', [])).toBeNull()
    expect(learnableFix('npx vitest run', 'npx   vitest run', [])).toBeNull()
  })

  it('learns nothing when the only commands between only read state', () => {
    expect(learnableFix('pytest', 'pytest', ['ls', 'cat setup.cfg', 'git status', 'python --version'])).toBeNull()
  })

  it('learns nothing when the success is a different command', () => {
    expect(learnableFix('pytest', 'npm test', ['pip install foo'])).toBeNull()
  })

  it('refuses a destructive, token-goat, fence-breaking or oversized fix', () => {
    expect(learnableFix('make', 'make', ['rm -rf build'])).toBeNull()
    expect(learnableFix('make', 'make', ['git reset --hard HEAD'])).toBeNull()
    expect(learnableFix('make', 'make', ['git push --force origin main'])).toBeNull()
    expect(learnableFix('make', 'make', ['token-goat doctor --repair'])).toBeNull()
    expect(learnableFix('make', 'make', ['echo `id`'])).toBeNull()
    expect(learnableFix('make', 'make', [`pip install ${'x'.repeat(MAX_FIX_CHARS)}`])).toBeNull()
  })

  it('refuses a fix carrying a credential', () => {
    expect(learnableFix('deploy', 'deploy', ['export GH_TOKEN=ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'])).toBeNull()
  })

  it('refuses a fix whose generic secret assignment redaction rewrites, though no precise credential pattern matches it', () => {
    // HAND-DERIVED: a password assignment is the recall-tuned kind in src/secret_redact.ts, which hasPreciseSecret skips and redactSecrets masks, so only the redaction check on the joined fix can refuse it.
    expect(learnableFix('deploy', 'deploy', ['export DB_PASSWORD=correcthorsebatterystaple'])).toBeNull()
  })

  it('refuses to learn from a failed command that carries a credential, though the fix itself is clean', () => {
    // HAND-DERIVED: the credential sits in a leading assignment that splitCommandPrefix peels off, so the cores match and the fix is only the clean install between the two runs.
    expect(learnableFix('GH_TOKEN=ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 pytest', 'pytest', ['pip install foo'])).toBeNull()
    expect(learnableFix('pytest', 'pytest', ['pip install foo'])).toBe('pip install foo')
  })
})

describe('isLearnableCommand', () => {
  it('rejects multi-line commands, control characters and the empty command', () => {
    expect(isLearnableCommand('a\nb')).toBe(false)
    expect(isLearnableCommand('a\u001b[0m')).toBe(false)
    expect(isLearnableCommand('  ')).toBe(false)
    expect(isLearnableCommand('pytest -q')).toBe(true)
  })
})

describe('the pending pair through the hooks', () => {
  it('learns an intervening install, then tells a later session', async () => {
    const { cwd } = freshProject()
    const first = session()
    expect(contextOf(await failed(first, cwd, 'pytest'))).toBe('')
    await succeeded(first, cwd, 'pip install foo')
    await succeeded(first, cwd, 'pytest')
    const second = session()
    const line = contextOf(await failed(second, cwd, 'pytest'))
    expect(line).toContain('This failed before; it was fixed by running: `pip install foo` (seen 1 time)')
  })

  it('counts a second learning of the same fix and speaks once per session', async () => {
    const { cwd } = freshProject()
    for (let i = 0; i < 2; i++) {
      const s = session()
      await failed(s, cwd, 'pytest')
      await succeeded(s, cwd, 'pip install foo')
      await succeeded(s, cwd, 'pytest')
    }
    const third = session()
    expect(contextOf(await failed(third, cwd, 'pytest'))).toContain('(seen 2 times)')
    expect(contextOf(await failed(third, cwd, 'pytest', 'Exit code 1\nModuleNotFoundError: No module named foo'))).not.toContain('This failed before')
  })

  it('learns a prefix delta from the captured Bash failure shape', async () => {
    const { cwd } = freshProject()
    const first = session()
    const raw = { ...CAPTURED_FAILURE, session_id: first, cwd }
    await postToolUseFailureWithExtras({ eventName: 'post_tool_use_failure', toolName: 'Bash', toolInput: { command: 'ls nonexistent_dir' }, sessionId: first, agentId: undefined, raw })
    await succeeded(first, cwd, 'cd src && ls nonexistent_dir')
    const second = session()
    const line = contextOf(await postToolUseFailureWithExtras({ eventName: 'post_tool_use_failure', toolName: 'Bash', toolInput: { command: 'ls nonexistent_dir' }, sessionId: second, agentId: undefined, raw: { ...raw, session_id: second } }))
    expect(line).toContain('`cd src && ls nonexistent_dir`')
  })

  it('learns nothing when an edit landed in between', async () => {
    const { cwd } = freshProject()
    const first = session()
    await failed(first, cwd, 'pytest')
    await succeeded(first, cwd, 'pip install foo')
    await edited(first, cwd)
    await succeeded(first, cwd, 'pytest')
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('learns nothing from a flaky rerun', async () => {
    const { cwd } = freshProject()
    const first = session()
    await failed(first, cwd, 'pytest')
    await succeeded(first, cwd, 'pytest')
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('learns nothing once the window has passed', async () => {
    const { cwd } = freshProject()
    const first = session()
    await failed(first, cwd, 'pytest')
    for (let i = 0; i < 7; i++) await succeeded(first, cwd, `pip install pkg${i}`)
    await succeeded(first, cwd, 'pytest')
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('keeps projects apart', async () => {
    const a = freshProject()
    const b = freshProject()
    const first = session()
    await failed(first, a.cwd, 'pytest')
    await succeeded(first, a.cwd, 'pip install foo')
    await succeeded(first, a.cwd, 'pytest')
    expect(contextOf(await failed(session(), b.cwd, 'pytest'))).toBe('')
  })

  it('never stores a credential, even one straddling a truncation point', async () => {
    const { cwd } = freshProject()
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const first = session()
    await failed(first, cwd, 'pytest', `Exit code 1\n${'x'.repeat(40)} ${token}`)
    await succeeded(first, cwd, 'pip install foo')
    await succeeded(first, cwd, 'pytest')
    const stored = readFileSync(recoveryStorePath(recoveryProjectKey(cwd) ?? ''), 'utf8')
    expect(stored).toContain('pip install foo')
    expect(stored).not.toContain('ghp_')
    expect(stored).not.toContain(token)
  })

  it('retires a pair only when it hurt at least twice and hurt more than it helped', () => {
    // HAND-DERIVED: the three boundaries of hurt >= 2 && hurt > helped.
    const pair = { signature: 's', commandShape: 'c', fix: 'f', count: 1, lastSeen: 0 }
    expect(isRetired({ ...pair, helped: 1, hurt: 2 })).toBe(true)
    expect(isRetired({ ...pair, helped: 2, hurt: 2 })).toBe(false)
    expect(isRetired({ ...pair, helped: 0, hurt: 1 })).toBe(false)
  })

  it('scores an offered fix, retires one that keeps failing, and stops offering it', async () => {
    const { cwd } = freshProject()
    const seed = session()
    await failed(seed, cwd, 'pytest')
    await succeeded(seed, cwd, 'pip install foo')
    await succeeded(seed, cwd, 'pytest')
    const helped = session()
    expect(contextOf(await failed(helped, cwd, 'pytest'))).toContain('`pip install foo`')
    await succeeded(helped, cwd, 'pip install foo')
    await succeeded(helped, cwd, 'pytest')
    expect(loadRecoveryPairs(cwd).map((p) => [p.helped, p.hurt])).toEqual([[1, 0]])
    for (let i = 0; i < 2; i++) {
      const s = session()
      expect(contextOf(await failed(s, cwd, 'pytest'))).toContain('`pip install foo`')
      await succeeded(s, cwd, 'pip install foo')
      await failed(s, cwd, 'pytest')
    }
    expect(loadRecoveryPairs(cwd).map((p) => [p.helped, p.hurt])).toEqual([[1, 2]])
    expect(contextOf(await failed(session(), cwd, 'pytest'))).toBe('')
  })

  it('does not open a pair for a Copilot-shaped failure of a command it should not learn from', async () => {
    const { cwd } = freshProject()
    const s = session()
    const raw = { session_id: s, cwd, tool_name: 'Bash', tool_input: { command: 'rm -rf build && make' }, error: 'command not found: make' }
    await postToolUseFailureWithExtras({ eventName: 'post_tool_use_failure', toolName: 'Bash', toolInput: { command: 'rm -rf build && make' }, sessionId: s, agentId: undefined, raw })
    await succeeded(s, cwd, 'rm -rf build && make')
    expect(loadRecoveryPairs(cwd)).toEqual([])
  })
})

describe('the built bundle', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-recovery-e2e-'))
  const project = join(home, 'proj')
  mkdirSync(project, { recursive: true })
  const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function hook(event: string, payload: Record<string, unknown>): string {
    const res = runBundle(['hook', event], { cwd: project, env, input: JSON.stringify(payload), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    return res.stdout
  }

  function ok(command: string, sid: string): Record<string, unknown> {
    return { session_id: sid, cwd: project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } }
  }

  it('hands a second session the fix a first session learned', () => {
    const first = { ...CAPTURED_FAILURE, session_id: 'e2e-first', cwd: project, tool_input: { command: 'pytest' }, error: 'Exit code 1\nModuleNotFoundError: No module named foo' }
    hook('post_tool_use_failure', first)
    hook('post_tool_use', ok('pip install foo', 'e2e-first'))
    hook('post_tool_use', ok('pytest', 'e2e-first'))
    const out = hook('post_tool_use_failure', { ...first, session_id: 'e2e-second' })
    expect(out).toContain('This failed before; it was fixed by running: `pip install foo` (seen 1 time)')
  })

  it('does the same for the payload the Copilot adapter canonicalizes from postToolUseFailure', () => {
    // FORMAT-DERIVED: src/hook_adapters.ts copilotRun -- tool_name from copilotCanonicalToolName('bash'), tool_input from toolArgs, error verbatim, and no cwd key.
    const failure = (sid: string): Record<string, unknown> => ({ session_id: sid, tool_name: 'Bash', tool_input: { command: 'make lint' }, error: 'Exit code 2\nmake: *** No rule to make target lint. Stop.' })
    hook('post_tool_use_failure', failure('copilot-first'))
    hook('post_tool_use', { session_id: 'copilot-first', tool_name: 'Bash', tool_input: { command: 'make setup' }, tool_response: 'ok' })
    hook('post_tool_use', { session_id: 'copilot-first', tool_name: 'Bash', tool_input: { command: 'make lint' }, tool_response: 'ok' })
    expect(hook('post_tool_use_failure', failure('copilot-second'))).toContain('`make setup`')
  })
})
