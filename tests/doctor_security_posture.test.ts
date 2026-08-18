/**
 * `token-goat doctor` is the first command an evaluation runs, and it said nothing about what the
 * tool is allowed to reach or who else can read what it stored: the answers were spread across the
 * config file, the README, and a directory mode nobody looks at. These pin the reporting rules --
 * a default install stays quiet, and every protection that ships on warns when it is switched off.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkSecurityPosture, runDoctor } from '../src/cli_doctor.js'
import { invalidateConfigCache, loadConfig } from '../src/config.js'
import type { Config } from '../src/config.js'
import type { DoctorResult } from '../src/doctor_result.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-sec-'))
  invalidateConfigCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  invalidateConfigCache()
})

// loadConfig hands back a frozen object, so each variant is a deep copy rather than a mutation.
function baseConfig(): Config {
  return structuredClone(loadConfig(root)) as Config
}

function find(results: DoctorResult[], name: string): DoctorResult {
  const hit = results.find((r) => r.name === name)
  expect(hit, `no ${name} line`).toBeDefined()
  return hit as DoctorResult
}

describe('checkSecurityPosture', () => {
  it('reports every part of the posture, so nothing is answered by omission', () => {
    const names = checkSecurityPosture(baseConfig(), root).map((r) => r.name)

    expect(names).toEqual([
      'Security network',
      'Security injection',
      'Security gdrive',
      'Security fetch policy',
      'Security mcp roots',
      'Security data dir',
    ])
  })

  it('stays quiet on a default install, so a warning means something', () => {
    // The data dir here is a fresh mkdtemp, which on POSIX takes 0700 already.
    const warned = checkSecurityPosture(baseConfig(), root).filter((r) => r.status !== 'ok')

    expect(warned.map((r) => `${r.name}: ${r.message}`)).toEqual([])
  })

  it('warns when injection scanning is off, and names the setting', () => {
    const cfg = baseConfig()
    cfg.injection.enabled = false

    const line = find(checkSecurityPosture(cfg, root), 'Security injection')

    expect(line.status).toBe('warn')
    expect(line.message).toContain('injection.enabled')
  })

  it('warns when MCP reads are no longer confined to the project root', () => {
    const cfg = baseConfig()
    cfg.mcp.confine_reads_to_project_root = false

    const line = find(checkSecurityPosture(cfg, root), 'Security mcp roots')

    expect(line.status).toBe('warn')
    expect(line.message).toContain('mcp.confine_reads_to_project_root')
  })

  it('counts the extra roots rather than reporting plain confinement when there are some', () => {
    const cfg = baseConfig()
    cfg.mcp.allowed_roots = ['/srv/shared']

    const line = find(checkSecurityPosture(cfg, root), 'Security mcp roots')

    expect(line.status).toBe('ok')
    expect(line.message).toContain('plus 1 configured root')
  })

  it('says offline mode is on in terms of what it stops, not just that a flag is set', () => {
    const cfg = baseConfig()
    cfg.network.offline = true

    const line = find(checkSecurityPosture(cfg, root), 'Security network')

    expect(line.message).toContain('offline mode is on')
    expect(line.message).toContain('Drive')
  })

  // Google Drive ships on. Warning about the shipped default would make the section noise, so the
  // rule is that it reports both ways and never warns; both directions are pinned so a later edit
  // cannot quietly turn it into a nag or drop the state from the message.
  it.each([
    [true, 'enabled'],
    [false, 'disabled'],
  ])('reports Drive as %s without warning', (enabled, word) => {
    const cfg = baseConfig()
    cfg.gdrive.enabled = enabled as boolean

    const line = find(checkSecurityPosture(cfg, root), 'Security gdrive')

    expect(line.status).toBe('ok')
    expect(line.message).toContain(word as string)
  })

  it('distinguishes an allow list from a deny-only policy, since they differ in what they permit', () => {
    const open = baseConfig()
    const closed = baseConfig()
    closed.webfetch.allow = ['example.com', 'docs.example.com']

    expect(find(checkSecurityPosture(open, root), 'Security fetch policy').message).toContain('any host not denied')
    expect(find(checkSecurityPosture(closed, root), 'Security fetch policy').message).toContain('2 allowed host patterns')
  })

  it('warns when the data directory is readable by other local users', () => {
    if (process.platform === 'win32') return
    fs.chmodSync(root, 0o755)

    const line = find(checkSecurityPosture(baseConfig(), root), 'Security data dir')

    expect(line.status).toBe('warn')
    expect(line.message).toContain('755')
  })

  it('reports a directory it cannot stat as unknown rather than as fine', () => {
    if (process.platform === 'win32') return
    const line = find(checkSecurityPosture(baseConfig(), path.join(root, 'gone')), 'Security data dir')

    expect(line.status).toBe('warn')
    expect(line.message).toContain('unknown')
  })

  // Windows has no POSIX mode to read, so the line says what does govern access there rather than
  // reporting a mode it made up or staying silent about the directory altogether.
  it('says the directory follows the parent ACL on Windows', () => {
    if (process.platform !== 'win32') return
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security data dir')

    expect(line.status).toBe('ok')
    expect(line.message).toContain('ACL')
  })
})

// The helper above is only half of it. A posture report the doctor command never calls is a stub,
// so this drives the real entrypoint and then the shipped bundle: the section has to survive both
// the wiring and the build.
describe('the doctor command reports the posture', () => {
  it('includes the security lines in runDoctor output', () => {
    const names = runDoctor(root, path.join(root, 'config.toml'), root, []).map((r) => r.name)

    expect(names).toContain('Security network')
    expect(names).toContain('Security data dir')
  })

  it('prints them through the built bundle', () => {
    const bundle = path.resolve(process.cwd(), 'dist', 'token-goat.mjs')
    const result = spawnSync(process.execPath, [bundle, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root, TOKEN_GOAT_HOME: root },
    })

    expect(`${result.stdout}${result.stderr}`).toContain('Security injection')
  })
})
