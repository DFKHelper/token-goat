/** `doctor --json --fix` used to run the checks and drop the repair without a word, so a caller scripting a repair saw a clean-looking result and nothing fixed. It now refuses and names the two commands that do the job. Provenance: CAPTURE for the message and exit code (dist/token-goat.mjs run in an isolated lab home, 2026-10-08); the no-side-effect assertion is HAND-DERIVED from the contract. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')

let home: string

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: home,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, HOME: home, USERPROFILE: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1' },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctorjson-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('doctor --json with a repair flag', () => {
  it.each(['--fix', '--repair'])('%s is refused with the two commands that work, and prints no result', (flag) => {
    const r = run(['doctor', '--json', flag])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('doctor --json cannot repair')
    expect(r.stderr).toContain('token-goat doctor --fix')
    expect(r.stdout).toBe('')
  })

  it('plain --json still prints the checks', () => {
    const r = run(['doctor', '--json'])
    expect(() => JSON.parse(r.stdout)).not.toThrow()
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true)
  })
})
