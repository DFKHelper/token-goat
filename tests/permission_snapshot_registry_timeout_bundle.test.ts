/** A hint-emitting hook on Windows asks the registry for the machine policy, and a `reg query` that times out fails closed, which drops the hint. The test suite confines the permission sources a spawned bundle reads (tests/setup/permission-source-filter.cjs), so a loaded machine's slow reg.exe cannot lose the hint a test waits for; this proves that with a reg that always times out, independent of machine speed. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(repoRoot, 'dist', 'token-goat.mjs')
const filterPreload = path.join(repoRoot, 'tests', 'setup', 'permission-source-filter.cjs').replaceAll('\\', '/')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-regto-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

// HAND-DERIVED: a spawnSync result for a child killed at its timeout carries status null, signal SIGTERM and error.code ETIMEDOUT (Node child_process docs, spawnSync); returning it for every call whose file name is reg or reg.exe (the bundle now spawns reg.exe by absolute path, so a match on the bare command alone never fires) stands in for a reg.exe slower than the 5 s cap, whatever the machine speed.
const regTimesOut = path.join(scratch, 'reg-times-out.cjs')
fs.writeFileSync(
  regTimesOut,
  [
    "const cp = require('node:child_process')",
    'const real = cp.spawnSync',
    'cp.spawnSync = function (cmd, ...rest) {',
    "  if (String(cmd).toLowerCase().split(/[\\\\/]/).pop().replace(/[.]exe$/, '') === 'reg') {",
    "    return { status: null, signal: 'SIGTERM', pid: 0, output: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync reg ETIMEDOUT'), { code: 'ETIMEDOUT' }) }",
    '  }',
    '  return real.apply(this, [cmd, ...rest])',
    '}',
    "require('node:module').syncBuiltinESMExports()",
    '',
  ].join('\n'),
)

function hintFor(nodeOptions: string): string {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    TOKEN_GOAT_HOME: home,
    XDG_DATA_HOME: path.join(home, 'xdg'),
    LOCALAPPDATA: path.join(home, 'lad'),
    USERPROFILE: home,
    TOKEN_GOAT_BASH_COMPRESS: '0',
    TG_TEST_PERMISSION_ROOT: scratch,
  }
  const event = { session_id: 'reg-timeout', cwd: repoRoot, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat "${path.join(repoRoot, 'src', 'parser.ts').replaceAll('\\', '/')}"` } }
  const res = spawnSync(process.execPath, [bundle, 'hook', 'pre_tool_use'], { cwd: scratch, input: JSON.stringify(event), encoding: 'utf8', env, timeout: 120_000 })
  return res.stdout ?? ''
}

describe.skipIf(process.platform !== 'win32')('the built bundle on Windows when reg.exe times out', () => {
  it('loses the hint to the fail-closed policy read without the test filter (the flake being closed)', () => {
    const nodeOptions = `--require "${regTimesOut.replaceAll('\\', '/')}"`
    expect(hintFor(nodeOptions)).not.toContain('token-goat outline')
  }, 120_000)

  it('keeps the hint when the suite filter skips the registry', () => {
    const nodeOptions = `--require "${regTimesOut.replaceAll('\\', '/')}" --require "${filterPreload}"`
    expect(hintFor(nodeOptions)).toContain('token-goat outline')
  }, 120_000)
})
