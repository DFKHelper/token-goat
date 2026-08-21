/**
 * Regression: `token-goat hook <event>` with an event name the relay does not know wrote `{}` to
 * stdout, exited 0, and said nothing anywhere. That is a wiring mistake rather than a runtime
 * hazard -- a settings.json left behind by an older build, a hand-edited entry, or a bridge shim
 * passing its own spelling -- and the silence made it invisible: image shrinking, read dedup and
 * the dirty-queue enqueue all stopped while the index went stale, with nothing to show why. It
 * also gives a false green to anyone verifying a hook change by hand.
 *
 * The `{}` on stdout has to stay (a hook must never wedge the tool call), so the diagnostic goes to
 * stderr, where hooks_cli already reports a bad payload and where the harness will not read it as
 * the response.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(REPO, 'dist', 'token-goat.mjs')

const PAYLOAD = JSON.stringify({
  session_id: 'relay-unknown',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  cwd: REPO,
  tool_input: { command: 'ls' },
})

function runHook(event: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [BUNDLE, 'hook', event], {
    input: PAYLOAD,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

describe('token-goat hook <event> with an unknown event name', () => {
  it('says so on stderr rather than passing silently', () => {
    const { stderr } = runHook('post-edit')
    expect(stderr, `expected a stderr diagnostic naming the bad event, got: ${JSON.stringify(stderr)}`).toContain(
      "unknown hook event 'post-edit'",
    )
  })

  it('names the valid events so the mistake is fixable from the message alone', () => {
    const { stderr } = runHook('totally-bogus')
    expect(stderr).toContain('post_tool_use')
    expect(stderr).toContain('pre_tool_use')
  })

  it('still writes a bare pass to stdout and exits 0, so it never wedges the harness', () => {
    const { stdout, status } = runHook('post-edit')
    expect(stdout).toBe('{}')
    expect(status).toBe(0)
  })

  it('stays silent on stderr for an event it does know', () => {
    const { stdout, stderr, status } = runHook('post_tool_use')
    expect(stderr).not.toContain('unknown hook event')
    expect(status).toBe(0)
    expect(() => JSON.parse(stdout === '' ? '{}' : stdout)).not.toThrow()
  })
})
