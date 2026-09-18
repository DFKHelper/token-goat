/**
 * The 4KB uncompressed-output hint as the model receives it: through the built bundle's relay, which scrubs unsafe suggestions after the handler returns.
 *
 * Provenance: CAPTURE. The quoted command is the shape that produced 60 of 75 recorded emissions of this hint reading "run with 'token-goat (command omitted: the path contains shell metacharacters)" in real transcripts, with the `bash-output` pointer cut off. The own-command case replays the real output of the bundle's `read` command, the shape that drew the same gutted hint in those transcripts. The payload is the PostToolUse shape Claude Code sends for Bash.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'

const home = mkdtempSync(join(tmpdir(), 'tg-4k-hint-'))
const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '1' }

function hintFor(command: string, sessionId: string, stdout = 'y'.repeat(5000), cwd = home): string {
  const payload = { session_id: sessionId, hook_event_name: 'PostToolUse', cwd, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false } }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  expect(res.status).toBe(0)
  const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { additionalContext?: string } }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

describe('large uncompressed output hint', () => {
  it('keeps the bash-output pointer when the command holds double quotes', () => {
    const hint = hintFor('curl -H "Accept: text/html" http://example.com/api && echo done', 'quoted')
    expect(hint).toMatch(/`token-goat bash-output [0-9a-f]+`/)
    expect(hint).not.toContain('command omitted')
  })

  it('still offers compress -c for a command it can quote', () => {
    const hint = hintFor('curl http://example.com/api && echo done', 'plain')
    expect(hint).toContain('`token-goat compress -c "curl http://example.com/api && echo done"`')
  })

  it('stays silent on token-goat\'s own commands', () => {
    const targets = ['src/hooks_bash.ts@1370-1405', 'src/hint_suggestion_guard.ts@110-175']
    const stdout = targets.map((t) => spawnSync(process.execPath, [BUNDLE, 'read', t], { cwd: ROOT, encoding: 'utf-8', env }).stdout).join('')
    expect(stdout.length).toBeGreaterThan(4096)
    // Calibration: the same real output under a foreign command does draw the hint, so silence below is the own-command exemption and not a filter rewriting the output first.
    expect(hintFor('curl http://example.com/api && echo done', 'foreign', stdout, ROOT)).toContain('uncompressed')
    expect(hintFor(targets.map((t) => `token-goat read "${t}"`).join('; '), 'own', stdout, ROOT)).not.toContain('uncompressed')
  })
})
