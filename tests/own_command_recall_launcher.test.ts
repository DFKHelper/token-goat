/** token-goat spelled through its launchers (`node .../token-goat.mjs`, `npx token-goat`) is token-goat's own command: its recall must not be withheld as already served and its piped output must not be clipped by generic compression. Run through the built bundle's PostToolUse hook with a fresh home. Provenance: the stdout is CAPTURE, the first 60 lines of src/served_lines.ts read at run time. The launcher form is CAPTURE (live recalls 02b8a82b5281cbc3 and 03bae592be424a15 in a real session); the npx form is FORMAT-DERIVED from docs/install.md. The long-line body is HAND-DERIVED: one line past LONG_LINE_MAX_CHARS (1000) amid short ones. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'

const home = mkdtempSync(join(tmpdir(), 'tg-own-launcher-'))
const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '1' }

function post(command: string, sessionId: string, stdout: string): string {
  const payload = { session_id: sessionId, hook_event_name: 'PostToolUse', cwd: home, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false } }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  expect(res.status).toBe(0)
  return res.stdout
}

const BODY = readFileSync(join(ROOT, 'src', 'served_lines.ts'), 'utf-8').split('\n').slice(0, 60).join('\n') + '\n'
const SERVED = 'already served verbatim'
const LONG_BODY = Array.from({ length: 119 }, (_, i) => (i === 50 ? 'x'.repeat(1500) : `line ${i}: ${'z'.repeat(60)}`)).join('\n') + '\n'

describe('token-goat launcher spellings are token-goat commands', () => {
  const recalls = [
    ['node launcher', 'node C:/Projects/token-goat/dist/token-goat.mjs bash-output 0123456789abcdef --full'],
    ['npx', 'npx -y token-goat bash-output 0123456789abcdef --full'],
  ] as const

  for (const [label, recall] of recalls) {
    it(`does not withhold a ${label} --full recall as already served`, () => {
      const session = `recall-${label}`
      post('python gen.py --first', session, BODY)
      expect(post(recall, session, BODY)).not.toContain(SERVED)
    })
  }

  it('control: an arbitrary node script printing served lines is still withheld', () => {
    post('python gen.py --first', 'ctl-served', BODY)
    expect(post('node tools/report.mjs', 'ctl-served', BODY)).toContain(SERVED)
  })

  it('leaves a piped launcher read unchanged, long line included', () => {
    expect(post('node C:/Projects/token-goat/dist/token-goat.mjs read "src/served_lines.ts::elideServedShellLines" 2>&1 | head -40', 'pipe-own', LONG_BODY)).not.toContain('updatedToolOutput')
  })

  it('control: a piped foreign script with the same stdout is still compressed', () => {
    expect(post('python print_demo.py | head -40', 'pipe-foreign', LONG_BODY)).toContain('updatedToolOutput')
  })
})
