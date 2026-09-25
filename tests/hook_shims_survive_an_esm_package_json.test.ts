// Regression: the Claude Code, Codex, Grok and Kimi hook shims were written as `token-goat-shim.js` and open with `require(...)`. Node decides a `.js` file's module system from the nearest ancestor package.json, so a user whose home directory (or any directory above the harness config) carries `{"type":"module"}` got an ES module where `require` is undefined: every hook died with a ReferenceError before it could print the `{}` that lets the tool call through.
//
// FIXTURE PROVENANCE: HAND-DERIVED from Node's documented module-type rule (nodejs.org/api/packages.html, "Determining module system": a `.js` file is ESM when the nearest parent package.json has `"type": "module"`, a `.cjs` file is always CommonJS). The `{}` expectation is the shims' own contract for an event name outside the closed hook-event set.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { codexHookScriptPath, installCodex, uninstallCodex } from '../src/bridges/codex_install.js'
import { grokConfigPath, grokHookScriptPath, installGrok, uninstallGrok } from '../src/bridges/grok_install.js'
import { installKimi, kimiHookScriptPath, uninstallKimi } from '../src/bridges/kimi_install.js'
import { claudeHookScriptPath, installHooks, settingsPath, uninstallHooks } from '../src/install.js'

const homedirMock = vi.mocked(os.homedir)
const SAVED = ['CLAUDE_CONFIG_DIR', 'KIMI_CODE_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const
let saved: Record<string, string | undefined>
let tmp: string
let home: string

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]))
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-esm-shim-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  // The one line that turns every `.js` file below it into an ES module.
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"module"}\n')
  homedirMock.mockReturnValue(home)
  process.env['CLAUDE_CONFIG_DIR'] = path.join(home, '.claude')
  delete process.env['KIMI_CODE_HOME']
  process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
})

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  homedirMock.mockReset()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Run `script` the way a harness does, with an event name outside the closed set, which every shim answers with `{}` before doing any work. */
function runShim(script: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [script, 'not_an_event'], { input: '{}', encoding: 'utf8', timeout: 30_000, windowsHide: true })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

// `noOp` is what each shim prints for an event it does not handle: Kimi prints nothing, because its prompt hook reads a bare `{}` as text to add to the context (see src/bridges/kimi.ts).
const HARNESSES = [
  { name: 'Claude Code', install: () => installHooks('user'), scriptPath: claudeHookScriptPath, noOp: '{}' },
  { name: 'Codex', install: installCodex, scriptPath: codexHookScriptPath, noOp: '{}' },
  { name: 'Grok', install: installGrok, scriptPath: grokHookScriptPath, noOp: '{}' },
  { name: 'Kimi', install: installKimi, scriptPath: kimiHookScriptPath, noOp: '' },
] as const

describe('hook shims under a home directory whose package.json says "type": "module"', () => {
  for (const h of HARNESSES) {
    it(`${h.name}: the wired shim loads and answers its no-op`, () => {
      h.install()
      expect(path.extname(h.scriptPath())).toBe('.cjs')
      const res = runShim(h.scriptPath())
      expect(res.stderr).toBe('')
      expect(res.stdout).toBe(h.noOp)
      expect(res.status).toBe(0)
    })

    it(`${h.name}: the .js path an older install wired still answers, through a forwarder`, () => {
      h.install()
      const legacy = h.scriptPath().replace(/\.cjs$/, '.js')
      expect(fs.existsSync(legacy)).toBe(true)
      const res = runShim(legacy)
      expect(res.stderr).toBe('')
      expect(res.stdout).toBe(h.noOp)
      expect(res.status).toBe(0)
    })

    // The answer above is also the forwarder's own fallback, so it cannot tell a forward from a failed one. A shim that answers something only it could proves the call reached it, with the harness's argv and stdin intact.
    it(`${h.name}: the forwarder runs the .cjs shim with the event and payload it was given`, () => {
      h.install()
      fs.writeFileSync(h.scriptPath(), "process.stdout.write('FORWARDED ' + process.argv[2] + ' ' + require('node:fs').readFileSync(0, 'utf8'))\n")
      const res = runShim(h.scriptPath().replace(/\.cjs$/, '.js'))
      expect(res.stderr).toBe('')
      expect(res.stdout).toBe('FORWARDED not_an_event {}')
      expect(res.status).toBe(0)
    })

    it(`${h.name}: the forwarder still answers the no-op when the shim it forwards to is gone`, () => {
      h.install()
      fs.rmSync(h.scriptPath())
      const res = runShim(h.scriptPath().replace(/\.cjs$/, '.js'))
      expect(res.stdout).toBe(h.noOp)
      expect(res.status).toBe(0)
    })
  }

  it('Grok wires its hook config to the .cjs shim', () => {
    installGrok()
    expect(fs.readFileSync(grokConfigPath(), 'utf8')).toContain('token-goat-shim.cjs')
  })

  it('uninstall removes both the shim and its forwarder, for every harness', () => {
    installHooks('user')
    installCodex()
    installGrok()
    installKimi()
    uninstallHooks('user')
    uninstallCodex()
    uninstallGrok()
    uninstallKimi()
    for (const h of HARNESSES) {
      expect(fs.existsSync(h.scriptPath())).toBe(false)
      expect(fs.existsSync(h.scriptPath().replace(/\.cjs$/, '.js'))).toBe(false)
    }
  })

  it('uninstalling the project scope keeps the shim while the user scope is still wired to the old .js path', () => {
    const project = path.join(tmp, 'project')
    fs.mkdirSync(project)
    const cwd = process.cwd()
    process.chdir(project)
    try {
      installHooks('user')
      installHooks('project')
      // The user scope as an install from before the rename left it: every command names the .js path.
      const p = settingsPath('user')
      const cjs = claudeHookScriptPath()
      const js = cjs.replace(/\.cjs$/, '.js')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(JSON.stringify(cjs).slice(1, -1)).join(JSON.stringify(js).slice(1, -1)))
      uninstallHooks('project')
      expect(fs.existsSync(js)).toBe(true)
      expect(fs.existsSync(cjs)).toBe(true)
      expect(runShim(js).stdout).toBe('{}')
    } finally {
      process.chdir(cwd)
    }
  })

  it('a Claude Code install over settings wired to the old .js shim rewires every event to the .cjs one', () => {
    installHooks('user')
    const p = settingsPath('user')
    const cjs = claudeHookScriptPath()
    const js = cjs.replace(/\.cjs$/, '.js')
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(JSON.stringify(cjs).slice(1, -1)).join(JSON.stringify(js).slice(1, -1)))
    expect(fs.readFileSync(p, 'utf8')).not.toContain('token-goat-shim.cjs')
    installHooks('user')
    const text = fs.readFileSync(p, 'utf8')
    expect(text).not.toContain('token-goat-shim.js')
    expect(text).toContain('token-goat-shim.cjs')
  })
})
