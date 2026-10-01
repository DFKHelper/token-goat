/** A line-range file read with an output pipeline, or a compound of such reads, must not draw the compress hint: compressing a file read saves nothing. Built bundle, fresh home. Provenance: the stdout is CAPTURE, the first 120 lines of src/served_lines.ts read at run time; the command shapes are CAPTURE from real transcripts (`sed -n A,Bp f | cut -c1-N`, `cd D && sed -n ... | cut`, `sed -n ...; echo ....; sed -n ...`). The mixed read-plus-script control is HAND-DERIVED. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'

const home = mkdtempSync(join(tmpdir(), 'tg-4k-fileread-'))
const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '1' }

function run(command: string, sessionId: string, stdout: string): { hint: string; rewritten: boolean; raw: string } {
  const payload = { session_id: sessionId, hook_event_name: 'PostToolUse', cwd: ROOT, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false } }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  expect(res.status).toBe(0)
  const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { additionalContext?: string; updatedToolOutput?: unknown } }
  return { hint: parsed.hookSpecificOutput?.additionalContext ?? '', rewritten: res.stdout.includes('updatedToolOutput'), raw: res.stdout }
}

const BODY = readFileSync(join(ROOT, 'src', 'served_lines.ts'), 'utf-8').split('\n').slice(0, 120).join('\n') + '\n'
const HINT = 'uncompressed'

describe('large-output hint on file reads', () => {
  it('precondition: this stdout draws the hint under a foreign command', () => {
    expect(Buffer.byteLength(BODY)).toBeGreaterThan(4096)
    expect(run('curl http://example.com/api && echo done', 'pre', BODY).hint).toContain(HINT)
  })

  it('stays silent on a line-range read with an output pipeline', () => {
    expect(run('sed -n 1,120p src/served_lines.ts | cut -c1-200', 'pipe', BODY).hint).not.toContain(HINT)
  })

  it('stays silent on a cd-prefixed line-range read with an output pipeline', () => {
    expect(run(`cd '${ROOT.replace(/\\/g, '/')}' && sed -n 1,120p src/served_lines.ts | cut -c1-200`, 'cd', BODY).hint).not.toContain(HINT)
  })

  it('stays silent on a compound of line-range reads', () => {
    expect(run('sed -n 1,60p src/served_lines.ts; echo ....; sed -n 61,120p src/served_lines.ts', 'multi', BODY).hint).not.toContain(HINT)
  })

  it('stays silent on a whole-file read with an output pipeline', () => {
    expect(run('cat src/served_lines.ts | head -200', 'cat', BODY).hint).not.toContain(HINT)
  })

  it('control: a bare line-range read stays silent', () => {
    expect(run('sed -n 1,120p src/served_lines.ts', 'bare', BODY).hint).not.toContain(HINT)
  })

  it('control: a read followed by a script still draws the hint', () => {
    expect(run('head -c 1500 x.mjs && curl http://example.com/api', 'mixed', BODY).hint).toContain(HINT)
  })
})
