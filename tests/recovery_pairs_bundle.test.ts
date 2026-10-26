/** Failure-recovery pairs through the built bundle (spawns dist/token-goat.mjs). Split from recovery_pairs.test.ts by describe group. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { CAPTURED_FAILURE, MODULE_ERROR, INSTALL } from './helpers/recovery_pairs_fixtures.js'

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

  it('hands a third session the fix two earlier sessions learned', () => {
    const failure = (sid: string): Record<string, unknown> => ({ ...CAPTURED_FAILURE, session_id: sid, cwd: project, tool_input: { command: 'pytest' }, error: MODULE_ERROR })
    for (const sid of ['e2e-first', 'e2e-second']) {
      hook('post_tool_use_failure', failure(sid))
      hook('post_tool_use', ok(INSTALL, sid))
      hook('post_tool_use', ok('pytest', sid))
    }
    const out = hook('post_tool_use_failure', failure('e2e-third'))
    expect(out).toContain(`In an earlier session this same failure was followed by: \`${INSTALL}\` (seen 2 times, not verified)`)
  })

  it('does the same for the payload the Copilot adapter canonicalizes from postToolUseFailure', () => {
    // FORMAT-DERIVED: src/hook_adapters.ts copilotRun -- tool_name from copilotCanonicalToolName('bash'), tool_input from toolArgs, error verbatim, and no cwd key. The `Exit code 2` text is HAND-DERIVED and unverified for Copilot CLI (see the header): this proves the adapter-shaped payload is handled, not that Copilot sends it for a failed shell command.
    const failure = (sid: string): Record<string, unknown> => ({ session_id: sid, tool_name: 'Bash', tool_input: { command: 'make lint' }, error: 'Exit code 2\nmake: *** No rule to make target lint. Stop.' })
    for (const sid of ['copilot-first', 'copilot-second']) {
      hook('post_tool_use_failure', failure(sid))
      hook('post_tool_use', { session_id: sid, tool_name: 'Bash', tool_input: { command: 'make setup' }, tool_response: 'ok' })
      hook('post_tool_use', { session_id: sid, tool_name: 'Bash', tool_input: { command: 'make lint' }, tool_response: 'ok' })
    }
    expect(hook('post_tool_use_failure', failure('copilot-third'))).toContain('`make setup`')
  })

  it('does not open a pair for a failure of a command it should not learn from', () => {
    const failure = (sid: string): Record<string, unknown> => ({ session_id: sid, tool_name: 'Bash', tool_input: { command: 'deploy --token abc123def' }, error: 'Exit code 1\nError: nope' })
    hook('post_tool_use_failure', failure('secret-first'))
    hook('post_tool_use', ok('deploy --token abc123def', 'secret-first'))
    expect(hook('post_tool_use_failure', failure('secret-second'))).not.toContain('earlier session')
  })
})

