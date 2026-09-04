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

import {
  checkSecurityPosture,
  envOverriddenSecuritySettings,
  lockedEnvOverridableKeys,
  runDoctor,
} from '../src/cli_doctor.js'
import {
  CONFIG_KEY_ENV_OVERRIDES,
  invalidateConfigCache,
  loadConfig,
  PROJECT_LOCKED_KEYS,
  PROJECT_LOCKED_SECTIONS,
} from '../src/config.js'
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
      'Security redaction',
      'Security mcp roots',
      'Security config overrides',
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

/**
 * The environment can reopen a setting a project config is forbidden to touch.
 *
 * PROVENANCE
 *
 * FORMAT-DERIVED. The setting names are read from `PROJECT_LOCKED_SECTIONS` in `src/config.ts`
 * (the sections a checked-in `.token-goat.toml` cannot write), and each variable name from the
 * `CONFIG_KEY_ENV_OVERRIDES` entry for that key in the same file. The pairing is restated here on
 * purpose rather than imported: a test that built its expectations from the same table the
 * implementation reads would agree with a renamed variable instead of catching it.
 */
describe('an environment variable that reopens a project-locked security setting', () => {
  /**
   * Every project-locked setting an environment variable can override, and a value that changes it.
   *
   * `weakened` settings are booleans with a safe side; the value listed turns the protection off.
   * `replaced` settings hold a list or a number, where there is no safe side to compare against and
   * the fact worth reporting is that the environment, not the file, decided the value.
   *
   * FORMAT-DERIVED. Each setting name is read from `PROJECT_LOCKED_SECTIONS` and
   * `PROJECT_LOCKED_KEYS` in `src/config.ts`, and each variable name from that key's
   * `CONFIG_KEY_ENV_OVERRIDES` entry in the same file. The pairing is restated here rather than
   * imported: a table built from the same source the implementation reads would agree with a
   * renamed variable instead of catching it.
   *
   * The first version of this held six of the fifteen. It was hand-written, it looked complete, and
   * the nine it omitted were reported as a clean posture. The implementation now derives its key set
   * from config, and the coverage assertion below fails if the two ever disagree in either
   * direction.
   */
  const LOCKED_AND_OVERRIDABLE: ReadonlyArray<
    [setting: string, envVar: string, value: string, kind: 'weakened' | 'replaced']
  > = [
    ['gdrive.enabled', 'TOKEN_GOAT_GDRIVE_ENABLED', 'true', 'weakened'],
    ['injection.enabled', 'TOKEN_GOAT_INJECTION_ENABLED', 'false', 'weakened'],
    ['redaction.strict', 'TOKEN_GOAT_REDACTION_STRICT', 'false', 'weakened'],
    ['mcp.confine_reads_to_project_root', 'TOKEN_GOAT_MCP_CONFINE_READS', 'false', 'weakened'],
    ['screenshot.block_private_targets', 'TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS', 'false', 'weakened'],
    ['network.offline', 'TOKEN_GOAT_OFFLINE', 'false', 'weakened'],
    ['indexing.cross_project_symbols', 'TOKEN_GOAT_CROSS_PROJECT_SYMBOLS', 'true', 'weakened'],
    ['webfetch.compress_bodies', 'TOKEN_GOAT_WEB_COMPRESS', 'false', 'weakened'],
    ['mcp.allowed_roots', 'TOKEN_GOAT_MCP_ALLOWED_ROOTS', '/', 'replaced'],
    ['redaction.custom_patterns', 'TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS', 'EMP-[0-9]{4,8}', 'replaced'],
    ['webfetch.allow', 'TOKEN_GOAT_WEBFETCH_ALLOW', 'example.com', 'replaced'],
    ['webfetch.deny', 'TOKEN_GOAT_WEBFETCH_DENY', 'example.com', 'replaced'],
    ['webfetch.max_bytes', 'TOKEN_GOAT_WEB_CACHE_MAX_BYTES', '999999999', 'replaced'],
    ['webfetch.max_file_count', 'TOKEN_GOAT_WEB_CACHE_MAX_FILES', '99999', 'replaced'],
    ['image_shrink.max_image_pixels', 'TOKEN_GOAT_MAX_IMAGE_PIXELS', '999999999', 'replaced'],
  ]

  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const [, envVar] of LOCKED_AND_OVERRIDABLE) {
      saved.set(envVar, process.env[envVar])
      delete process.env[envVar]
    }
  })

  afterEach(() => {
    for (const [envVar, prev] of saved) {
      if (prev === undefined) delete process.env[envVar]
      else process.env[envVar] = prev
    }
    saved.clear()
  })

  it.each(LOCKED_AND_OVERRIDABLE)('reports %s when %s is set to %s', (setting, envVar, value) => {
    process.env[envVar] = value
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')

    expect(line.status, `${envVar}=${value} was not reported`).toBe('warn')
    expect(line.message).toContain(setting)
    expect(line.message, 'the variable to unset is not named').toContain(envVar)
  })

  it.each(LOCKED_AND_OVERRIDABLE)('classifies %s as %s', (setting, envVar, value, kind) => {
    process.env[envVar] = value
    expect(envOverriddenSecuritySettings()).toContainEqual({ setting, envVar, kind })
  })

  // The defect this closes was an omission rather than a mistake, and an omission leaves no trace in
  // the output. Comparing the table against the derived set in both directions is the only
  // assertion here that fails when a locked setting gains an override upstream.
  it('covers every project-locked setting the environment can override', () => {
    expect(LOCKED_AND_OVERRIDABLE.map(([setting]) => setting).sort()).toEqual(lockedEnvOverridableKeys())
  })

  // `0`, `no` and `off` all switch a protection off in `_buildConfig`, so a check that only looked
  // for the literal `false` would miss three of the four spellings and report a clean posture.
  it.each(['0', 'no', 'off', 'FALSE', ' false '])('recognises %j as off', (spelling) => {
    process.env['TOKEN_GOAT_INJECTION_ENABLED'] = spelling
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')
    expect(line.status, `${JSON.stringify(spelling)} read as leaving injection scanning on`).toBe('warn')
  })

  it('stays quiet when the environment sets nothing', () => {
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')
    expect(line.status).toBe('ok')
  })

  // Reporting a variable that tightens a setting would train the reader to skim this line, which is
  // the one outcome that makes the real warning useless.
  it('says nothing when the environment makes a setting safer, not weaker', () => {
    process.env['TOKEN_GOAT_GDRIVE_ENABLED'] = 'false'
    process.env['TOKEN_GOAT_REDACTION_STRICT'] = 'true'
    process.env['TOKEN_GOAT_OFFLINE'] = 'true'
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')
    expect(line.status, `a tightening override was reported: ${line.message}`).toBe('ok')
  })

  // A variable set to blank decides nothing: `envStrList` falls back to the configured value for
  // one. Reporting it would put a line in front of an operator with nothing behind it.
  it('says nothing when a list variable is set to an empty string', () => {
    process.env['TOKEN_GOAT_WEBFETCH_ALLOW'] = '   '
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')
    expect(line.status, `a blank variable was reported: ${line.message}`).toBe('ok')
  })

  it('names every weakened setting rather than only the first', () => {
    process.env['TOKEN_GOAT_GDRIVE_ENABLED'] = 'true'
    process.env['TOKEN_GOAT_REDACTION_STRICT'] = '0'
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')

    expect(line.message).toContain('gdrive.enabled')
    expect(line.message, 'the second weakened setting was dropped').toContain('redaction.strict')
  })

  // A weakened boolean and a replaced list are described in different words, because "held open" is
  // wrong for a value with no safe side. Both have to survive the same message.
  it('describes a weakened setting and a replaced one in the same message', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = 'false'
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = '/'
    const line = find(checkSecurityPosture(baseConfig(), root), 'Security config overrides')

    expect(line.message).toContain('network.offline')
    expect(line.message, 'the replaced setting was dropped').toContain('mcp.allowed_roots')
    expect(line.message).toContain('held open')
    expect(line.message).toContain('set from the environment')
  })

  // The two lists this check straddles -- the settings a project config cannot write, and the
  // variables that override them -- live in `src/config.ts`. If a variable is renamed there and the
  // doctor's table is not updated, the lookup returns nothing and the check reports a clean posture
  // forever. Assert the join is non-empty rather than trusting that it resolved.
  it('resolves a variable name for every setting it claims to cover', () => {
    for (const [setting, envVar] of LOCKED_AND_OVERRIDABLE) {
      expect(CONFIG_KEY_ENV_OVERRIDES[setting], `${setting} has no env-override entry`).toContain(envVar)
      const section = setting.split('.')[0] as string
      const locked = PROJECT_LOCKED_SECTIONS.includes(section) || PROJECT_LOCKED_KEYS.includes(setting)
      expect(locked, `${setting} is not project-locked`).toBe(true)
    }
  })

  it('is reachable from the exported helper, not only through the doctor line', () => {
    process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = 'off'
    expect(envOverriddenSecuritySettings()).toEqual([
      { setting: 'mcp.confine_reads_to_project_root', envVar: 'TOKEN_GOAT_MCP_CONFINE_READS', kind: 'weakened' },
    ])
  })
})
