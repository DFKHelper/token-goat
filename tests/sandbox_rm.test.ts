import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rmInSandbox, sandboxRmRefusal } from './helpers/sandbox-rm.js'

// HAND-DERIVED: the env objects below are built by hand to put each target on one side of each boundary; the real-home layout (run root under the real home's Temp) mirrors a Windows run, where TG_TEST_RUN_ROOT lands under %LOCALAPPDATA%\Temp.
const realHome = path.resolve('/users/dev')
const runRoot = path.join(realHome, 'AppData', 'Local', 'Temp', 'tg-test-run-x')
const env = { TG_TEST_RUN_ROOT: runRoot, TG_REAL_HOME: realHome, TG_REAL_USERPROFILE: realHome }

describe('sandboxRmRefusal', () => {
  it('admits a path strictly inside the run root', () => {
    expect(sandboxRmRefusal(path.join(runRoot, 'tg-test-data-1', '.claude'), env)).toBeNull()
  })

  it.each([
    ['the real home .claude', path.join(realHome, '.claude')],
    ['the real home itself', realHome],
    ['an ancestor of the real home', path.dirname(realHome)],
    ['the run root itself', runRoot],
    ['a sibling that shares the run root as a string prefix', `${runRoot}-other`],
    ['a dot-dot escape', path.join(runRoot, '..', 'elsewhere')],
  ])('refuses %s', (_label, target) => {
    expect(sandboxRmRefusal(target, env)).toMatch(/^refusing to delete/)
  })

  it('refuses everything when the run root is unset (setup did not run)', () => {
    expect(sandboxRmRefusal(path.join(runRoot, 'x'), { TG_REAL_HOME: realHome })).toMatch(/TG_TEST_RUN_ROOT is unset/)
  })

  it('refuses a target that contains the real home even when it sits under the run root', () => {
    const nestedHome = path.join(runRoot, 'home')
    expect(sandboxRmRefusal(runRoot + path.sep + 'x', { ...env, TG_REAL_HOME: path.join(runRoot, 'x', 'me') })).toMatch(/real HOME/)
    expect(sandboxRmRefusal(nestedHome, { ...env, TG_REAL_USERPROFILE: nestedHome })).toMatch(/real USERPROFILE/)
  })
})

describe('rmInSandbox under the live suite setup', () => {
  it('deletes the sandboxed ~/.claude the tests write into', () => {
    const dir = path.join(os.homedir(), '.claude', 'sandbox-rm-probe')
    fs.mkdirSync(dir, { recursive: true })
    rmInSandbox(path.join(os.homedir(), '.claude'))
    expect(fs.existsSync(path.join(os.homedir(), '.claude'))).toBe(false)
  })

  const real = process.env['TG_REAL_HOME'] ?? process.env['TG_REAL_USERPROFILE']
  it.skipIf(!real)('throws, deleting nothing, for the real home', () => {
    expect(() => rmInSandbox(path.join(real!, '.claude-token-goat-never-exists'))).toThrow(/refusing to delete/)
  })
})
