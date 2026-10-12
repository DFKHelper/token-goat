/** `read --cwd P f.ts --lines 2-3` through the built bundle, run from a directory that is not P. The rewrite of a `--lines` flag into an `f.ts@2-3` spec counted the value of `--cwd` as a second spec and gave up, so the reader saw an unknown option; the unit cases are in tests/option_intent.test.ts. Provenance: HAND-DERIVED, the file is generated here and the expected lines are the ones the generator wrote at those line numbers; the Note wording is read off the output of the same command run by hand. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const bundle = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'token-goat.mjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lines-cwd-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const project = path.join(scratch, 'proj')
const elsewhere = path.join(scratch, 'elsewhere')
fs.mkdirSync(project)
fs.mkdirSync(elsewhere)
fs.writeFileSync(path.join(project, 'f.ts'), 'const line1 = 1\nconst line2 = 2\nconst line3 = 3\nconst line4 = 4\n')

function read(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const home = path.join(scratch, 'home')
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: elsewhere,
    encoding: 'utf8',
    env: { ...process.env, TOKEN_GOAT_HOME: home, XDG_DATA_HOME: path.join(home, 'xdg'), LOCALAPPDATA: path.join(home, 'lad'), USERPROFILE: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '0' },
  })
}

describe('read with --cwd after the command and a --lines flag', () => {
  it.each([
    ['--cwd P', (p: string) => ['read', '--cwd', p, 'f.ts', '--lines', '2-3']],
    ['--cwd=P', (p: string) => ['read', `--cwd=${p}`, 'f.ts', '--lines', '2-3']],
  ])('reads lines 2-3 and says how it ran it, with %s', (_form, argv) => {
    const res = read(...argv(project))
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('const line2 = 2')
    expect(res.stdout).toContain('const line3 = 3')
    expect(res.stdout).not.toContain('const line1 = 1')
    expect(res.stdout).not.toContain('const line4 = 4')
    expect(res.stderr).toContain('Note: ran as `token-goat read "f.ts@2-3"` (--lines is not an option')
  }, 60_000)
})
