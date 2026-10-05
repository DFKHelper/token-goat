/** A line-range file read with an output pipeline, or a compound of such reads, must not draw the compress hint: compressing a file read saves nothing. Built bundle, fresh home. Provenance: the stdout is CAPTURE, the leading lines of src/served_lines.ts read at run time, as many as it takes to pass 4500 bytes, so it sits above the 4 KB hint floor and below the generic filter's 2000-token cap (about 7000 characters) however that file's comments are wrapped; a fixed 120 lines grew past the cap once its comments were folded, and the control below was then compressed instead of hinted. The comment-free stdout in the whole-file pipeline case is HAND-DERIVED. The command shapes are CAPTURE from real transcripts (`sed -n A,Bp f | cut -c1-N`, `cd D && sed -n ... | cut`, `sed -n ...; echo ....; sed -n ...`). The mixed read-plus-script control is HAND-DERIVED. */
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

function leadingLinesPast(text: string, bytes: number): string {
  const kept: string[] = []
  let size = 0
  for (const line of text.split('\n')) {
    if (size > bytes) break
    kept.push(line)
    size += Buffer.byteLength(line) + 1
  }
  return kept.join('\n') + '\n'
}

const BODY = leadingLinesPast(readFileSync(join(ROOT, 'src', 'served_lines.ts'), 'utf-8'), 4500)
// Nothing in it for the file-read branch's comment fold to collapse, which is the case where a whole-file pipeline read used to fall through to the compress hint.
const PLAIN_BODY = Array.from({ length: 100 }, (_, i) => `export const value${i} = compute(${i}, 'segment-${i}')`).join('\n') + '\n'
const HINT = 'uncompressed'

describe('large-output hint on file reads', () => {
  it('precondition: this stdout draws the hint under a foreign command', () => {
    expect(Buffer.byteLength(BODY)).toBeGreaterThan(4096)
    expect(BODY.length / 3.5).toBeLessThan(2000)
    expect(Buffer.byteLength(PLAIN_BODY)).toBeGreaterThan(4096)
    expect(run('curl http://example.com/api && echo plain', 'pre-plain', PLAIN_BODY).hint).toContain(HINT)
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

  it('stays silent on a whole-file read with an output pipeline when there is nothing to fold', () => {
    expect(run('cat src/served_lines.ts | head -200', 'cat-plain', PLAIN_BODY).hint).not.toContain(HINT)
  })

  it('control: a bare line-range read stays silent', () => {
    expect(run('sed -n 1,120p src/served_lines.ts', 'bare', BODY).hint).not.toContain(HINT)
  })

  it('control: a read followed by a script still draws the hint', () => {
    expect(run('head -c 1500 x.mjs && curl http://example.com/api', 'mixed', BODY).hint).toContain(HINT)
  })
})
