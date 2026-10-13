// One isolated home through a failed check, its recovery, a Stop and a subagent receipt, then every file under it is searched for the secret. Provenance: the payload keys are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (PostToolUseFailure, PostToolUse, Stop, SubagentStop), the same shapes tests/hooks_stop.test.ts and tests/agent_receipt.test.ts use; the secret value is HAND-DERIVED.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
const SECRET = 'hunter2'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe('a secret in a failed check', () => {
  let root: string
  let project: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-secret-e2e-'))
    project = path.join(root, 'proj')
    for (const d of ['proj', 'tg', 'local', 'xdg', 'home', 'claude', 'codex']) fs.mkdirSync(path.join(root, d), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function hook(event: string, payload: Record<string, unknown>): { status: number; stdout: string } {
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', event], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      input: JSON.stringify({ cwd: project.replaceAll(path.sep, '/'), session_id: 'e2e-secret', permission_mode: 'default', ...payload }),
      env: {
        ...process.env,
        TOKEN_GOAT_HOME: path.join(root, 'tg'),
        LOCALAPPDATA: path.join(root, 'local'),
        XDG_DATA_HOME: path.join(root, 'xdg'),
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CODEX_HOME: path.join(root, 'codex'),
        TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
        TOKEN_GOAT_HOOK_SERVER: '0',
        TOKEN_GOAT_NATIVE_HOOKS: '0',
        TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      },
    })
    return { status: res.status ?? 1, stdout: res.stdout ?? '' }
  }

  it('reaches no file under the home through the failure ledger, the recovery, the Stop or the receipt', () => {
    const failed = `npm test --password ${SECRET}`
    hook('post_tool_use_failure', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: failed }, tool_use_id: 'toolu_f', error: `Exit code 1\nFAIL password=${SECRET}`, is_interrupt: false })
    hook('post_tool_use', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_ok', tool_response: 'ok' })
    const stop = hook('stop', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Done, ran ${failed}.` })
    expect(stop.status).toBe(0)
    const sub = hook('subagent_stop', { hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'sub1', agent_type: 'general-purpose', last_assistant_message: `Fixed it, ran ${failed} and it passed.` })
    expect(sub.status).toBe(0)
    const files = walk(root)
    expect(files.some((f) => f.includes('.tool-failures'))).toBe(true)
    const leaked = files.filter((f) => fs.readFileSync(f).toString('latin1').includes(SECRET))
    expect(leaked).toEqual([])
  })
})
