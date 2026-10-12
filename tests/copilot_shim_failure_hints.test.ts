/** The three failure hints (fix replay, edit near-miss, missing path) for a raw Copilot CLI payload, through the shim the installer writes and the built bundle's hook entry. Provenance: the envelope (sessionId, timestamp, cwd, toolName, toolArgs, toolResult, traceparent) and the success payloads are CAPTURE (tests/fixtures/copilot_cli_1_0_88/C6-006-postToolUse-powershell.json and C1a-005-postToolUse-view.json, Copilot CLI 1.0.88); no postToolUseFailure was ever captured, so the failure payloads are FORMAT-DERIVED: the same envelope plus `error`, per PostToolUseFailureHookInput (toolName, toolArgs, error) in @github/copilot-sdk types.d.ts as cited in tests/fixtures/harness_hook_payloads.ts, with `view` and `edit` argument keys (path, old_str, new_str) from the shim's cited tool list. The error wordings are HAND-DERIVED. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { HOOKS_SCRIPT_FILE, installCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-copilot-shim-hints-')))
const proj = join(home, 'proj')
const hooksDir = join(home, 'hooks')
mkdirSync(join(proj, 'src'), { recursive: true })
writeFileSync(join(proj, 'src', 'hooks_tool_failure.ts'), 'export const f = 1\n')
writeFileSync(join(proj, 'notes.md'), '# Title\n\n    indented text\n')
installCopilotHooksFile(hooksDir, 'copilot')
const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })
afterAll(() => rmSync(home, { recursive: true, force: true }))

function shim(event: string, payload: Record<string, unknown>): string {
  const res = spawnSync(process.execPath, [join(hooksDir, HOOKS_SCRIPT_FILE), event, BUNDLE], { cwd: proj, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 90_000 })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

const shellSuccess = copilotCapture('C6-006-postToolUse-powershell', { proj })
const ran = (sessionId: string, command: string): Record<string, unknown> => ({ ...shellSuccess, sessionId, toolArgs: { command, description: 'run' } })
const failed = (sessionId: string, toolName: string, toolArgs: Record<string, unknown>, error: string): Record<string, unknown> => ({ sessionId, timestamp: shellSuccess['timestamp'], cwd: proj, toolName, toolArgs, error, traceparent: shellSuccess['traceparent'] })

describe('Copilot CLI raw payloads through the shim and the built bundle', () => {
  it.each([
    ['the bare wording', 'Path does not exist'],
    ['the wording that names the path', 'Path does not exist: src/hooks_tool_failur.ts'],
  ])('offers the existing file for a view of a mistyped path, %s', (_name, error) => {
    const out = shim('postToolUseFailure', failed(`shim-view-${error.length}`, 'view', { path: join(proj, 'src', 'hooks_tool_failur.ts') }, error))
    expect(out).toContain('does not exist. Existing paths that look like it')
    expect(out).toContain('src/hooks_tool_failure.ts')
  })

  it('quotes the on-disk lines for an edit whose old_str was off by indentation', () => {
    const out = shim('postToolUseFailure', failed('shim-edit', 'edit', { path: join(proj, 'notes.md'), old_str: '        indented text', new_str: 'x' }, 'No match found for old_str in notes.md'))
    expect(out).toContain('line 3 matches, ignoring indentation')
    expect(out).toContain('    indented text')
  })

  it('hands a third session the fix two earlier sessions learned from a captured shell success', () => {
    const failure = (sid: string): Record<string, unknown> => failed(sid, 'powershell', { command: 'make lint', description: 'lint' }, 'Exit code 2\nmake: *** No rule to make target lint. Stop.')
    for (const sid of ['shim-k1', 'shim-k2']) {
      shim('postToolUseFailure', failure(sid))
      shim('postToolUse', ran(sid, 'make setup'))
      shim('postToolUse', ran(sid, 'make lint'))
    }
    expect(shim('postToolUseFailure', failure('shim-k3'))).toContain('In an earlier session this same failure was followed by: `make setup` (seen 2 times, not verified)')
  })
})
