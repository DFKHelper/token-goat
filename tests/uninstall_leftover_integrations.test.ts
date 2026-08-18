/**
 * `token-goat uninstall` removes the Claude Code hooks, the CLAUDE.md block, and the skill, and
 * leaves every other harness integration wired unless its flag is passed. It said nothing about
 * that: three "Removed" lines and a Codex or Copilot hook still pointing at the binary the operator
 * is about to delete. Confirmed live before the fix by installing --codex and running a plain
 * uninstall, which left config.toml, AGENTS.md, and the shim in place without a word. Offboarding a
 * machine is exactly when nobody looks twice, and a Copilot preToolUse hook whose target is gone
 * fails closed on every call in that session. Uninstall now names each one and the flag that
 * removes it, following the report-rather-than-delete rule the stray CLAUDE.md blocks already use.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { leftoverIntegrations } from '../src/cli.js'

let root: string
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'TOKEN_GOAT_HOME',
  'XDG_DATA_HOME',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-leftover-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['HOME'] = root
  process.env['USERPROFILE'] = root
  process.env['CODEX_HOME'] = path.join(root, '.codex')
  process.env['TOKEN_GOAT_HOME'] = path.join(root, 'home')
  process.env['XDG_DATA_HOME'] = path.join(root, 'share')
  process.env['LOCALAPPDATA'] = path.join(root, 'share')
  process.env['APPDATA'] = path.join(root, 'appdata')
  delete process.env['XDG_CONFIG_HOME']
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** The isolated environment every spawn below runs in, so no test ever reads the developer's own config. */
function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, '.codex'),
    TOKEN_GOAT_HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'share'),
    LOCALAPPDATA: path.join(root, 'share'),
    APPDATA: path.join(root, 'appdata'),
  }
}

function runOut(args: string[]): { status: number | null; out: string } {
  const bundle = path.resolve(process.cwd(), 'dist', 'token-goat.mjs')
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env: env() })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('leftoverIntegrations', () => {
  it('reports nothing when no other harness is installed, so an ordinary uninstall stays quiet', () => {
    process.env['CODEX_HOME'] = path.join(root, '.codex')
    process.env['HOME'] = root
    process.env['USERPROFILE'] = root

    expect(leftoverIntegrations({})).toEqual([])
  })

  it('never reports an integration whose flag was passed, since that one is being removed', () => {
    const all = leftoverIntegrations({
      codex: true,
      gemini: true,
      qwen: true,
      pi: true,
      openclaw: true,
      copilot: true,
      opencode: true,
      grok: true,
    })

    expect(all).toEqual([])
  })
})

describe('uninstall through the built bundle', () => {
  it('names the Codex integration it is leaving behind, and the command that removes it', () => {
    expect(runOut(['install', '--codex']).status).toBe(0)

    const { status, out } = runOut(['uninstall'])

    expect(status).toBe(0)
    expect(out).toContain('Codex CLI integration is still installed')
    expect(out).toContain('token-goat uninstall --codex')
    // The point of the notice is that it is true: the files really are still there.
    expect(fs.existsSync(path.join(root, '.codex', 'config.toml'))).toBe(true)
  })

  it('says nothing when the flag was passed, because there is nothing left to warn about', () => {
    expect(runOut(['install', '--codex']).status).toBe(0)

    const { status, out } = runOut(['uninstall', '--codex'])

    expect(status).toBe(0)
    expect(out).toContain('Removed token-goat Codex CLI integration.')
    expect(out).not.toContain('is still installed')
  })

  it('says nothing for a Claude-Code-only install, so the notice cannot cry wolf', () => {
    expect(runOut(['install']).status).toBe(0)

    const { status, out } = runOut(['uninstall'])

    expect(status).toBe(0)
    expect(out).not.toContain('is still installed')
  })
})
