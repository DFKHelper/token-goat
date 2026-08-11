/**
 * Unit tests for D3 commands: config, project, compact-doc, fetch-image, history.
 *
 * config set→get round-trip is the mutation-verify target (break nested-set → test fails).
 * All config tests use a vi.mock redirect of configPath() to an isolated temp file.
 * All project/history tests use TOKEN_GOAT_HOME for disk_cache isolation.
 */

import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type * as WebfetchModule from '../src/webfetch.js'
import type * as ImageShrinkModule from '../src/image_shrink.js'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE } from './helpers/bundle.js'

const performHttpFetchMock = vi.hoisted(() => vi.fn())
const shrinkImageMock = vi.hoisted(() => vi.fn())
const atomicWriteBytesMock = vi.hoisted(() => vi.fn())

// vi.mock is hoisted — stub image_shrink.js's shrinkImage so fetch-image extension-correction
// tests can force a format-changing shrink without needing a real decodable image. By default
// this delegates straight through to the real implementation, so any test that doesn't layer
// a mockImplementationOnce/mockResolvedValueOnce on top gets real behavior for free (which for
// the fake, non-image byte payloads used elsewhere in this file resolves to null / "not shrunk").
vi.mock('../src/image_shrink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageShrinkModule>()
  shrinkImageMock.mockImplementation((buf: Buffer) => actual.shrinkImage(buf))
  return { ...actual, shrinkImage: shrinkImageMock }
})

// vi.mock is hoisted — redirect configPath() for config tests.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

// vi.mock is hoisted — stub webfetch.js's performHttpFetch so fetch-image tests can control
// the response without opening a real socket. Mirrors tests/webfetch.test.ts's dnsLookupMock
// convention: by default this delegates straight through to the real implementation, so any
// test that doesn't layer a mockImplementationOnce on top -- including the SSRF-rejection
// test below, which needs the real ssrfPinnedLookup to run -- gets real behavior for free.
vi.mock('../src/webfetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WebfetchModule>()
  performHttpFetchMock.mockImplementation(
    (url: string, opts: Parameters<typeof actual.performHttpFetch>[1]) => actual.performHttpFetch(url, opts),
  )
  return { ...actual, performHttpFetch: performHttpFetchMock }
})

import type * as UtilModule from '../src/util.js'

// vi.mock is hoisted — spy on util.js's atomicWriteBytes (delegating straight through to the
// real implementation) so the fetch-image atomic-write regression test can assert cmdFetchImage
// routes its disk write through the shared atomic helper instead of a bare fs.writeFileSync.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  atomicWriteBytesMock.mockImplementation(actual.atomicWriteBytes)
  return { ...actual, atomicWriteBytes: atomicWriteBytesMock }
})

const _testConfigPath = tempConfigPath('tg-cfgcmd-test.toml')

import { cmdConfig, cmdProject, cmdCompactDoc, cmdHistory, cmdFetchImage } from '../src/config_commands.js'
import { globalDbPath } from '../src/constants.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { getDb } from '../src/db.js'
import { compactPathFor, isCompactFresh } from '../src/doc_compact.js'
import { invalidateConfigCache, loadConfig, loadPersistedConfig, saveConfig, defaultConfig } from '../src/config.js'
import { storeBlob } from '../src/disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from '../src/bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from '../src/web_cache.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// ── Setup/teardown ──────────────────────────────────────────────────────────

let tmpHome: string
let prevHome: string | undefined
let stdoutLines: string[]
let stderrLines: string[]
let writeSpy: WriteSpy
let errSpy: WriteSpy

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgcmd-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  stdoutLines = []
  stderrLines = []
  writeSpy = spyOnWrite(process.stdout, stdoutLines)
  errSpy = spyOnWrite(process.stderr, stderrLines)
  invalidateConfigCache()
  try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
})

afterEach(() => {
  writeSpy.mockRestore()
  errSpy.mockRestore()
  invalidateConfigCache()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ok */ }
})

afterAll(() => {
  try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
})

function captured(): string { return stdoutLines.join('') }
function capturedErr(): string { return stderrLines.join('') }

// ── config list ──────────────────────────────────────────────────────────────

describe('cmdConfig list', () => {
  it('emits flat key=value pairs covering known top-level sections', () => {
    cmdConfig({ action: 'list' })
    const out = captured()
    expect(out).toContain('compact_assist.enabled')
    expect(out).toContain('worker.blocked_roots')
  })

  it('--json outputs a valid object with expected top-level keys', () => {
    cmdConfig({ action: 'list', json: true })
    const parsed = JSON.parse(captured()) as Record<string, unknown>
    expect(typeof parsed['compact_assist']).toBe('object')
    expect(typeof parsed['worker']).toBe('object')
  })
})

/**
 * Run `fn` with cwd pointed at a throwaway project directory containing `.token-goat.toml`,
 * which is how both the `get` layer annotation and the `set` shadow warning are reached
 * (`resolveConfigProjectRoot()` keys off cwd).
 *
 * Cleanup is best-effort: on Windows, rmSync of a directory that was the process cwd moments
 * earlier intermittently throws EPERM while the handle is still settling. The directory lives
 * under the suite's isolated temp root, so leaking one on that race costs nothing, whereas
 * letting it throw fails the test for a reason unrelated to what it asserts.
 */
function inProjectDir<T>(toml: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-projcfg-'))
  const prevCwd = process.cwd()
  try {
    fs.writeFileSync(path.join(dir, '.token-goat.toml'), toml)
    process.chdir(dir)
    invalidateConfigCache()
    return fn(dir)
  } finally {
    process.chdir(prevCwd)
    invalidateConfigCache()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort -- see docstring
    }
  }
}

// ── config get ───────────────────────────────────────────────────────────────

describe('cmdConfig get', () => {
  it('returns the value for a known key', () => {
    cmdConfig({ action: 'get', key: 'compact_assist.enabled' })
    expect(captured()).toContain('true')
  })

  it('returns array as JSON for array-typed keys', () => {
    cmdConfig({ action: 'get', key: 'compact_assist.triggers' })
    const out = captured().trim()
    const parsed = JSON.parse(out) as unknown[]
    // Pin the real default content, not just "is a non-empty array" -- that shape check alone
    // would pass even if the returned array held the wrong section's values entirely.
    expect(parsed).toEqual(['manual', 'auto'])
  })

  it('throws with a key-not-found message for an unknown key, without also writing directly to stderr (regression: cmdConfig used to emitErr AND throw the same message, double-printing once the CLI guard() catch also prints the thrown error)', () => {
    expect(() => cmdConfig({ action: 'get', key: 'no_such_section.foo' })).toThrow('key not found')
    expect(capturedErr()).toBe('')
  })

  it('throws when key is missing', () => {
    expect(() => cmdConfig({ action: 'get' })).toThrow()
  })

  it('suggests a near-miss key ("did you mean") for a typo\'d known key', () => {
    expect(() => cmdConfig({ action: 'get', key: 'compact_assist.enabld' })).toThrow(/did you mean: compact_assist\.enabled/)
  })

  it('annotates a value that came from a project .token-goat.toml', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      cmdConfig({ action: 'get', key: 'compact_assist.min_events' })
      expect(captured()).toContain('500')
      expect(captured()).toContain('# from .token-goat.toml')
    })
  })

  it('leaves a globally-resolved value byte-identical even while a project .token-goat.toml exists for OTHER keys', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      cmdConfig({ action: 'get', key: 'compact_assist.enabled' })
      // The project file is present but does not pin this key, so the annotation must not appear -- otherwise every key in a project with any config at all would be mislabeled as overridden.
      expect(captured().trim()).toBe('true')
    })
  })

  it('--json names the resolving layer in both directions', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', (dir) => {
      cmdConfig({ action: 'get', key: 'compact_assist.min_events', json: true })
      const overridden = JSON.parse(captured()) as Record<string, unknown>
      expect(overridden['source']).toBe('project')
      expect(String(overridden['projectPath'])).toContain(path.basename(dir))
      stdoutLines.length = 0
      cmdConfig({ action: 'get', key: 'compact_assist.enabled', json: true })
      const global_ = JSON.parse(captured()) as Record<string, unknown>
      expect(global_['source']).toBe('global')
      expect('projectPath' in global_).toBe(false)
    })
  })
})

// ── config layer attribution ─────────────────────────────────────────────────

/**
 * Every state of "which layer decided this key's effective value", asserted for `get` AND
 * `list` in BOTH text and `--json`. The states are not independent: `raw project value !=
 * effective value` has two causes (validation rejected/clamped it, or an env var outranked it)
 * and reporting one as the other sends the reader to edit the wrong thing, so the pair is
 * pinned as producing different output rather than each being checked in isolation.
 *
 * `compact_assist.min_events` is the project-layer probe precisely because it has NO entry in
 * CONFIG_KEY_ENV_OVERRIDES -- no env var can confound it. `hints.min_file_lines_for_hint` is
 * the env probe because it has one.
 */
describe('cmdConfig layer attribution', () => {
  /** Both commands' text output for one key, so a test can assert they agree in a single place instead of two tests that could later be updated apart. */
  function bothText(key: string): { get: string; listLine: string; listAll: string } {
    stdoutLines.length = 0
    cmdConfig({ action: 'get', key })
    const get = captured().trim()
    stdoutLines.length = 0
    cmdConfig({ action: 'list' })
    const listAll = captured()
    const listLine = listAll.split('\n').find((l) => l.startsWith(`${key} =`)) ?? ''
    return { get, listLine, listAll }
  }

  /** The `--json` twin of {@link bothText}: `get`'s payload and `list`'s `_sources` entry for the same key. */
  function bothJson(key: string): { get: Record<string, unknown>; listSource: Record<string, unknown> | undefined; listAll: Record<string, unknown> } {
    stdoutLines.length = 0
    cmdConfig({ action: 'get', key, json: true })
    const get = JSON.parse(captured()) as Record<string, unknown>
    stdoutLines.length = 0
    cmdConfig({ action: 'list', json: true })
    const listAll = JSON.parse(captured()) as Record<string, unknown>
    const sources = listAll['_sources'] as Record<string, Record<string, unknown>> | undefined
    return { get, listSource: sources?.[key], listAll }
  }

  it('state global: no project file at all leaves both commands unannotated', () => {
    const text = bothText('compact_assist.min_events')
    expect(text.get).toBe('3')
    expect(text.listLine).toBe('compact_assist.min_events = 3')
    const json = bothJson('compact_assist.min_events')
    expect(json.get['source']).toBe('global')
    expect('projectPath' in json.get).toBe(false)
    // Absence from _sources is what "global" means in list --json; an entry here would mean list disagrees with get.
    expect(json.listSource).toBeUndefined()
  })

  it('state global: a project file setting only OTHER keys stays byte-identical for an untouched key', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      const text = bothText('compact_assist.max_manifest_tokens')
      expect(text.get).not.toContain('#')
      expect(text.listLine).not.toContain('#')
      const json = bothJson('compact_assist.max_manifest_tokens')
      expect(json.get['source']).toBe('global')
      expect(json.listSource).toBeUndefined()
    })
  })

  it('state project: an in-bounds project value took effect, and get and list say so identically', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', (dir) => {
      const text = bothText('compact_assist.min_events')
      expect(text.get).toBe('500  # from .token-goat.toml')
      expect(text.listLine).toBe('compact_assist.min_events = 500  # from .token-goat.toml')
      const json = bothJson('compact_assist.min_events')
      expect(json.get['source']).toBe('project')
      expect(String(json.get['projectPath'])).toContain(path.basename(dir))
      expect(json.listSource).toEqual({ source: 'project', projectPath: json.get['projectPath'] })
    })
  })

  it('state project: a project value that coincidentally equals the already-effective value is still project, not rejected', () => {
    // 1000 is what compact_assist.min_events resolves to with no project file at all (see the global test above). Equality with the effective value is exactly the took-effect condition, so this must NOT be reported as rejected -- an "it differs, therefore something rejected it" reading would be fine here and wrong; this pins the direction.
    inProjectDir('[compact_assist]\nmin_events = 1000\n', () => {
      expect(bothText('compact_assist.min_events').get).toBe('1000  # from .token-goat.toml')
      expect(bothJson('compact_assist.min_events').get['source']).toBe('project')
    })
  })

  it('state project-invalid: an out-of-bounds project value names both values and the violated range', () => {
    inProjectDir('[compact_assist]\nmin_events = 4321\n', () => {
      const text = bothText('compact_assist.min_events')
      // The three things the reader needs: the project file sets this key, that value is not what is in effect, and what is.
      expect(text.get).toBe('1000  # .token-goat.toml sets 4321 (outside the allowed range 0-1000), not in effect; using 1000')
      expect(text.listLine).toBe('compact_assist.min_events = 1000  # .token-goat.toml sets 4321 (outside the allowed range 0-1000), not in effect; using 1000')
      const json = bothJson('compact_assist.min_events')
      expect(json.get['source']).toBe('project_invalid')
      expect(json.get['projectValue']).toBe(4321)
      expect(json.get['reason']).toBe('outside the allowed range 0-1000')
      // Not overloaded onto source:'project' -- the value did not come from the project file as written.
      expect(json.get['source']).not.toBe('project')
      expect(json.listSource).toEqual({ source: 'project_invalid', projectPath: json.get['projectPath'], projectValue: 4321, reason: 'outside the allowed range 0-1000' })
    })
  })

  it('state project-invalid: a wrong-typed project value reports the type mismatch, not a range', () => {
    inProjectDir('[compact_assist]\nmin_events = "many"\n', () => {
      const text = bothText('compact_assist.min_events')
      expect(text.get).toContain('expected a number, got a string')
      expect(text.get).not.toContain('allowed range')
      expect(bothJson('compact_assist.min_events').get['reason']).toBe('expected a number, got a string')
    })
  })

  it('state env: a SET env var outranks a valid project value, and is reported as env rather than as a rejected project value', () => {
    expect(process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']).toBeUndefined()
    process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT'] = '42'
    try {
      inProjectDir('[hints]\nmin_file_lines_for_hint = 33\n', () => {
        const text = bothText('hints.min_file_lines_for_hint')
        expect(text.get).toBe('42  # from $TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
        expect(text.listLine).toBe('hints.min_file_lines_for_hint = 42  # from $TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
        // The project value is 33 and the effective value is 42, so a difference-only rule would call this a rejected project value and send the reader to edit a file that is not the problem.
        expect(text.get).not.toContain('.token-goat.toml')
        expect(text.get).not.toContain('not in effect')
        const json = bothJson('hints.min_file_lines_for_hint')
        expect(json.get['source']).toBe('env')
        expect(json.get['envVar']).toBe('TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
        expect(json.listSource).toEqual({ source: 'env', envVar: 'TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT' })
      })
    } finally {
      delete process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']
      invalidateConfigCache()
    }
  })

  /** Set `vars` for the duration of `fn`, restoring exactly (including previously-unset) afterwards. */
  function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
    Object.assign(process.env, vars)
    invalidateConfigCache()
    try {
      return fn()
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      invalidateConfigCache()
    }
  }

  it('state env-invalid: an out-of-range env var is reported as clamped, not as being in effect', () => {
    // The exact asymmetry this pair closes: an env var and a project file that both supply an out-of-range value are the same situation, and reading back "# from $VAR" tells someone who set 99999999 that 99999999 is what they got.
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: '99999999' }, () => {
      const text = bothText('hints.min_file_lines_for_hint')
      expect(text.get).toBe('1000000  # $TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT sets 99999999 (outside the allowed range 0-1000000), not in effect; using 1000000')
      expect(text.listLine).toBe('hints.min_file_lines_for_hint = 1000000  # $TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT sets 99999999 (outside the allowed range 0-1000000), not in effect; using 1000000')
      const json = bothJson('hints.min_file_lines_for_hint')
      expect(json.get['source']).toBe('env_invalid')
      expect(json.get['envValue']).toBe(99999999)
      expect(json.get['reason']).toBe('outside the allowed range 0-1000000')
      // Not overloaded onto source:'env' -- the value in effect is not what the variable asked for.
      expect(json.get['source']).not.toBe('env')
      expect(json.listSource).toEqual({ source: 'env_invalid', envVar: 'TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT', envValue: 99999999, reason: 'outside the allowed range 0-1000000' })
    })
  })

  it('state env-invalid: an unparseable or empty env var is reported as contributing nothing', () => {
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: 'abc' }, () => {
      const text = bothText('hints.min_file_lines_for_hint')
      // envInt rejects a non-integer string outright and falls back, so the variable is set and yet supplies nothing at all -- previously indistinguishable from it having been applied.
      expect(text.get).toContain('$TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT sets "abc"')
      expect(text.get).toContain('expected a number, got a string')
      expect(text.get).toContain('not in effect')
      expect(bothJson('hints.min_file_lines_for_hint').get['source']).toBe('env_invalid')
    })
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: '   ' }, () => {
      expect(bothText('hints.min_file_lines_for_hint').get).toContain('(empty)')
      expect(bothJson('hints.min_file_lines_for_hint').get['reason']).toBe('empty')
    })
  })

  it('state env-invalid: a boolean env var set to a non-boolean word is reported, not silently dropped', () => {
    withEnv({ TOKEN_GOAT_COMPACT_ASSIST: 'maybe' }, () => {
      const text = bothText('compact_assist.enabled')
      expect(text.get).toContain('$TOKEN_GOAT_COMPACT_ASSIST sets "maybe"')
      expect(text.get).toContain('expected a boolean, got a string')
      expect(bothJson('compact_assist.enabled').get['source']).toBe('env_invalid')
    })
  })

  it('state env: an env var whose value parses to exactly what is already in effect is in-effect, not rejected', () => {
    // The in-effect condition is equality with the effective value, not "the variable changed something". Reporting this as rejected would be the mirror-image false alarm of the bug being fixed.
    const already = bothText('hints.min_file_lines_for_hint').get
    expect(already).not.toContain('#')
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: already }, () => {
      expect(bothText('hints.min_file_lines_for_hint').get).toBe(`${already}  # from $TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT`)
      expect(bothJson('hints.min_file_lines_for_hint').get['source']).toBe('env')
    })
    // Same value, spelled with surrounding whitespace the way a shell export easily produces: envInt trims before parsing, so this is still the in-effect state.
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: ` ${already} ` }, () => {
      expect(bothJson('hints.min_file_lines_for_hint').get['source']).toBe('env')
    })
  })

  it('state global: an unset env var leaves an env-overridable key byte-identical', () => {
    expect(process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']).toBeUndefined()
    const text = bothText('hints.min_file_lines_for_hint')
    expect(text.get).not.toContain('#')
    expect(text.listLine).not.toContain('#')
    const json = bothJson('hints.min_file_lines_for_hint')
    expect(json.get['source']).toBe('global')
    expect(json.listSource).toBeUndefined()
  })

  it('config set names both values when a clamped env var still shadows the save', () => {
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: '99999999' }, () => {
      cmdConfig({ action: 'set', key: 'hints.min_file_lines_for_hint', value: '7' })
      expect(capturedErr()).toContain('TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT is currently set to 99999999')
      expect(capturedErr()).toContain('taking effect as 1000000')
      expect(capturedErr()).toContain('outside the allowed range 0-1000000')
    })
  })

  it('config validate reports a clamped env var, and stays clean when the env value is fine', () => {
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: '99999999' }, () => {
      cmdConfig({ action: 'validate', json: true })
      const findings = (JSON.parse(captured()) as { findings: Array<{ kind: string; key: string; suggestion?: string }> }).findings
      const f = findings.find((x) => x.kind === 'env_value_ignored')
      expect(f?.key).toBe('hints.min_file_lines_for_hint')
      expect(f?.suggestion).toBe('$TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT is 99999999 (outside the allowed range 0-1000000); in effect: 1000000')
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })
    stdoutLines.length = 0
    withEnv({ TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT: '42' }, () => {
      cmdConfig({ action: 'validate', json: true })
      const findings = (JSON.parse(captured()) as { findings: Array<{ kind: string }> }).findings
      // An in-range env var is not a finding -- flagging every env override would make the gate useless.
      expect(findings.some((x) => x.kind === 'env_value_ignored')).toBe(false)
    })
  })

  it('the two causes of "project raw value differs from effective value" produce different output', () => {
    // Both arms below have project raw != effective. If the implementation collapses them into one state, one of these two assertions must fail -- neither arm can pass with the other's rendering.
    const rejected = inProjectDir('[hints]\nmin_file_lines_for_hint = 99999999\n', () => bothText('hints.min_file_lines_for_hint').get)
    process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT'] = '42'
    let env: string
    try {
      env = inProjectDir('[hints]\nmin_file_lines_for_hint = 33\n', () => bothText('hints.min_file_lines_for_hint').get)
    } finally {
      delete process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']
      invalidateConfigCache()
    }
    expect(rejected).toContain('.token-goat.toml sets 99999999')
    expect(rejected).not.toContain('TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
    expect(env).toContain('$TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
    expect(env).not.toContain('.token-goat.toml')
    expect(rejected).not.toBe(env)
  })

  it('state project-unparsed: a malformed project file is reported once by list and inline by get, and never as a per-key project override', () => {
    inProjectDir('[compact_assist\nmin_events = 500\n', () => {
      const text = bothText('compact_assist.min_events')
      expect(text.get).toContain('failed to parse')
      expect(text.get.startsWith('3')).toBe(true)
      // A trailing `# ...` comment is a one-line suffix by construction; smol-toml's parse message is multi-line, and letting it through would make `VALUE=$(token-goat config get k)` capture several lines.
      expect(text.get.split('\n')).toHaveLength(1)
      // list states the file-level failure once in its footer; repeating it on every one of ~200 key lines would bury the per-key annotations it sits among.
      expect(text.listLine).toBe('compact_assist.min_events = 3')
      expect(text.listAll).toContain('failed to parse')
      const json = bothJson('compact_assist.min_events')
      expect(json.get['source']).toBe('project_unparsed')
      // The one-lining above is presentation only: --json still carries the parser's full multi-line message, so nothing is actually lost.
      expect(String(json.get['parseError'])).toContain('\n')
      expect(json.listSource).toBeUndefined()
      expect((json.listAll['_project_override'] as Record<string, unknown>)['parse_error']).not.toBeNull()
    })
  })

  it('config validate reports a project value that will be ignored, and stays clean when the project value is fine', () => {
    // Without this, a rejected project value is only discoverable by happening to `config get` that exact key.
    inProjectDir('[compact_assist]\nmin_events = 4321\n', () => {
      cmdConfig({ action: 'validate', json: true })
      const findings = (JSON.parse(captured()) as { findings: Array<{ kind: string; key: string; suggestion?: string }>; ok: boolean }).findings
      const f = findings.find((x) => x.kind === 'project_value_ignored')
      expect(f?.key).toBe('compact_assist.min_events')
      expect(f?.suggestion).toBe('4321 is outside the allowed range 0-1000; in effect: 1000')
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
      stdoutLines.length = 0
      cmdConfig({ action: 'validate' })
      // The explanation is not a near-miss key name, so it must not be rendered as "did you mean: <sentence>?".
      expect(captured()).toContain('[project_value_ignored] compact_assist.min_events (4321 is outside the allowed range 0-1000; in effect: 1000)')
      expect(captured()).not.toContain('did you mean: 4321')
    })
    stdoutLines.length = 0
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      cmdConfig({ action: 'validate', json: true })
      const parsed = JSON.parse(captured()) as { findings: Array<{ kind: string }>; ok: boolean }
      // An in-bounds project value is not a finding -- flagging every project override would make the gate useless.
      expect(parsed.findings.some((x) => x.kind === 'project_value_ignored')).toBe(false)
    })
  })

  it('config set warns about a project value that is clamped, naming both values, because the project layer still displaces the save', () => {
    // _buildConfig merges the project raw tree OVER the global one and validates the merged result, so a clamped project value still wins over config.toml -- the save is as much a no-op as in the clean case. Staying silent here would be the mirror of the mislabel this whole change removes.
    inProjectDir('[compact_assist]\nmin_events = 4321\n', () => {
      cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '77' })
      expect(capturedErr()).toContain('sets it to 4321')
      expect(capturedErr()).toContain('taking effect as 1000')
      expect(capturedErr()).toContain('outside the allowed range 0-1000')
    })
  })
})

// ── config set → get round-trip (mutation-verify target) ─────────────────────

describe('cmdConfig set', () => {
  it('warns that a project .token-goat.toml shadows the key it just saved', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '77' })
      expect(capturedErr()).toContain('.token-goat.toml')
      expect(capturedErr()).toContain('overrides it in this project')
    })
  })

  it('stays silent when a project .token-goat.toml exists but does not pin the key being set', () => {
    inProjectDir('[compact_assist]\nmin_events = 500\n', () => {
      cmdConfig({ action: 'set', key: 'compact_assist.max_manifest_tokens', value: '123' })
      // A project config that sets unrelated keys shadows nothing; warning here would train the reader to ignore the warning entirely.
      expect(capturedErr()).toBe('')
    })
  })

  it('does not blame an unset env var when a project .token-goat.toml is what shadows the key', () => {
    // The env-shadow guard keys off "effective value differs from what was just written", which is equally true of the project layer; it used to fall back to naming the first REGISTERED env var, so a project-file override told the reader to unset a variable that was never set.
    expect(process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']).toBeUndefined()
    inProjectDir('[hints]\nmin_file_lines_for_hint = 33\n', () => {
      cmdConfig({action: 'set', key: 'hints.min_file_lines_for_hint', value: '77'})
      expect(capturedErr()).not.toContain('TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT')
      expect(capturedErr()).toContain('overrides it in this project')
    })
  })

  it('still warns about a genuinely set env var, naming it', () => {
    process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT'] = '42'
    try {
      cmdConfig({action: 'set', key: 'hints.min_file_lines_for_hint', value: '7'})
      expect(capturedErr()).toContain('TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT is currently set')
    } finally {
      delete process.env['TOKEN_GOAT_MIN_FILE_LINES_FOR_HINT']
      invalidateConfigCache()
    }
  })

  it('round-trip: set a value then get it back', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '99' })
    invalidateConfigCache()
    cmdConfig({ action: 'get', key: 'compact_assist.min_events' })
    expect(captured()).toContain('99')
  })

  it('coerces boolean values correctly', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'false' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.enabled).toBe(false)
  })

  it('throws on invalid boolean values', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'True' })).toThrow()
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'yes' })).toThrow()
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled', value: 'maybe' })).toThrow()
  })

  it('coerces number values correctly', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.max_manifest_tokens', value: '777' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.max_manifest_tokens).toBe(777)
  })

  it('rejects an empty or whitespace-only value for a numeric field instead of silently coercing it to 0 (regression: Number(\'\') === 0 is finite, so a blank --value slipped past the Number.isFinite guard)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '' })).toThrow(/expected a number/)
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '   ' })).toThrow(/expected a number/)
  })

  it('still accepts an explicit "0" for a numeric field', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '0' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(0)
  })

  it('persists the change to disk (verifying nested-set actually writes)', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '42' })
    const raw = fs.readFileSync(_testConfigPath, 'utf8')
    expect(raw).toContain('min_events')
  })

  it('rejects a JSON array of non-string elements for a string-list field instead of silently persisting it, only for it to validate to empty on next load (regression: coerce() only type-checked JSON-array elements when the field was a number list, so a string-list key set to a JSON array of numbers reported success here but validatedStrList later silently filtered it down to [])', () => {
    expect(() => cmdConfig({ action: 'set', key: 'indexing.skip_dirs', value: '[1,2,3]' })).toThrow(/expected a JSON array of strings/)
  })

  it('rejects malformed JSON array syntax with a friendly "expected a JSON array" message instead of a raw JSON.parse SyntaxError (regression: the JSON.parse(raw) call in coerce()\'s array branch had no try/catch, unlike every other rejection path in the same function)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '[1,2,' })).toThrow(/expected a JSON array/)
    expect(() => cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '[1,2,' })).not.toThrow(/Unexpected/)
  })

  it('still accepts a JSON array of strings for a string-list field', () => {
    cmdConfig({ action: 'set', key: 'indexing.skip_dirs', value: '["node_modules","dist"]' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.indexing.skip_dirs).toEqual(['node_modules', 'dist'])
  })

  it('throws with a key-not-found message for an unknown key, without also writing directly to stderr (regression: double-print via emitErr + throw)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'no_such.key', value: 'x' })).toThrow('key not found')
    expect(capturedErr()).toBe('')
  })

  it('suggests a near-miss key ("did you mean") for a typo\'d known key', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabld', value: 'true' })).toThrow(/did you mean: compact_assist\.enabled/)
  })

  it('throws when key is missing', () => {
    expect(() => cmdConfig({ action: 'set' })).toThrow()
  })

  it('throws when value is missing', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.enabled' })).toThrow()
  })

  it('--json returns the set value', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '7', json: true })
    const parsed = JSON.parse(captured()) as { key: string; value: unknown }
    expect(parsed.key).toBe('compact_assist.min_events')
    expect(parsed.value).toBe(7)
  })

  it('restores default after mutation-verify test', () => {
    const def = defaultConfig()
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: String(def.compact_assist.min_events) })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(def.compact_assist.min_events)
  })
})

// ── config set concurrent read-modify-write safety (Fix 6) ──────────────────
//
// cmdConfig's in-process tests above can't exercise the actual race: within one
// Node process, two synchronous cmdConfig() calls never interleave, so the load
// -> mutate -> save section always completes atomically regardless of locking.
// The race only exists across real OS processes racing on the same config.toml,
// so this spawns two real `token-goat config set` child processes against the
// built bundle, each setting a *different* key, kicked off back-to-back (no
// await between the two spawns) so their read-modify-write windows can overlap.
// Before the fix, the loser's write is silently dropped; after the fix, both
// keys survive.
describe('config set concurrent writes (regression: unlocked read-modify-write can drop a key)', () => {
  it('both keys survive when two `config set` calls race on different keys', async () => {
    // configPath() resolves off LOCALAPPDATA (Windows) / XDG_DATA_HOME (Linux/macOS) via
    // DATA_DIR, not TOKEN_GOAT_HOME — see src/constants.ts's defaultDataDir(). Isolate both
    // so this spawns against a fresh config.toml instead of the developer's real one.
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-race-'))
    const env = { ...process.env, LOCALAPPDATA: tmpDataDir, XDG_DATA_HOME: tmpDataDir }
    const configFile = process.platform === 'win32'
      ? path.join(tmpDataDir, 'dfk-helper', 'token-goat', 'config.toml')
      : path.join(tmpDataDir, 'token-goat', 'config.toml')

    const spawnOne = (key: string, value: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BUNDLE, 'config', 'set', key, value], { env: { ...env, ...extraEnv } })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stderr }))
      })

    // Relying on bare `spawn` timing to make two full Node cold-starts collide inside the
    // narrow synchronous load->save window is not reliable (observed 0/5 collisions in
    // practice -- one process's whole set finishes before the other even starts reading).
    // TOKEN_GOAT_TEST_RMW_DELAY_MS is a test-only seam in config_commands.ts's applySet that
    // widens the slow process's load->save window so the fast process is guaranteed to run
    // its own full load+mutate+save inside it, deterministically forcing the collision this
    // test exists to catch instead of hoping for one.
    const slow = spawnOne('compact_assist.enabled', 'false', { TOKEN_GOAT_TEST_RMW_DELAY_MS: '500' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const fast = spawnOne('bash_compress.enabled', 'false')
    const [r1, r2] = await Promise.all([slow, fast])

    expect(r1.code, r1.stderr).toBe(0)
    expect(r2.code, r2.stderr).toBe(0)

    const raw = fs.readFileSync(configFile, 'utf8')
    // Both writers' keys must be present -- neither should have clobbered the other.
    expect(raw).toMatch(/compact_assist[\s\S]*enabled\s*=\s*false/)
    expect(raw).toMatch(/bash_compress[\s\S]*enabled\s*=\s*false/)
  })

  // Regression for the withFileLock(lockPath, applySet) call omitting `waitMs`, which fell
  // back to util.ts's LOCK_WAIT_MS default (2s) instead of the hardened budget applied to
  // session_store.ts's analogous saveSessionState call site (LOCK_WAIT_MS_HARDENED, 15s). A
  // lock holder taking longer than 2s but well under 15s (e.g. this test's own
  // TOKEN_GOAT_TEST_RMW_DELAY_MS seam simulating machine load, not a crash) is entirely
  // legitimate -- it must never be treated as abandoned. Before the fix, the waiter's
  // withFileLock call above timed out at 2s, fell through to an unprotected `applySet()`, and
  // raced the still-lock-holding slow process's eventual write: the slow process's snapshot
  // (captured before the fast process's unprotected write landed) then silently clobbered it
  // on save. After the fix, the waiter's much larger budget covers the full 3s hold, so it
  // waits for the real lock release instead of falling back, and both keys survive.
  it('key set by the fast process survives a slow holder past the pre-fix 2s default wait (regression: missing waitMs falls back to an unprotected write)', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-race-'))
    const env = { ...process.env, LOCALAPPDATA: tmpDataDir, XDG_DATA_HOME: tmpDataDir }
    const configFile = process.platform === 'win32'
      ? path.join(tmpDataDir, 'dfk-helper', 'token-goat', 'config.toml')
      : path.join(tmpDataDir, 'token-goat', 'config.toml')

    const spawnOne = (key: string, value: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BUNDLE, 'config', 'set', key, value], { env: { ...env, ...extraEnv } })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stderr }))
      })

    const slow = spawnOne('compact_assist.enabled', 'false', { TOKEN_GOAT_TEST_RMW_DELAY_MS: '3000' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const fast = spawnOne('bash_compress.enabled', 'false')
    const [r1, r2] = await Promise.all([slow, fast])

    expect(r1.code, r1.stderr).toBe(0)
    expect(r2.code, r2.stderr).toBe(0)

    const raw = fs.readFileSync(configFile, 'utf8')
    // Both writers' keys must be present -- pre-fix, the fast process's unprotected fallback
    // write was clobbered by the slow process's later, lock-protected write.
    expect(raw).toMatch(/compact_assist[\s\S]*enabled\s*=\s*false/)
    expect(raw).toMatch(/bash_compress[\s\S]*enabled\s*=\s*false/)
  }, 20_000)
})

// ── config set input validation hardening (#M23, #M24, #M28) ────────────────

describe('cmdConfig set input validation hardening', () => {
  it('coerces a comma-separated number list into actual numbers, not strings (#M23)', () => {
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '1,3,10' })
    invalidateConfigCache()
    const cfg = loadConfig()
    // Pre-fix, the comma-split segments stayed strings and the load-time int-list validator
    // silently filtered them all out, leaving an empty array instead of the intended values.
    expect(cfg.hints.backoff_thresholds).toEqual([1, 3, 10])
  })

  it('still coerces a comma-separated number list after the field was previously emptied to []', () => {
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '[]' })
    invalidateConfigCache()
    cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '1,3,10' })
    invalidateConfigCache()
    const cfg = loadConfig()
    // Pre-fix, coerce() decided "is this a number list?" purely from existing.length > 0.
    // Once the field was emptied to [], that check saw length 0 and treated the field as a
    // plain string list, so the comma-split segments stayed strings and the load-time
    // int-list validator silently filtered them all out to [] again.
    expect(cfg.hints.backoff_thresholds).toEqual([1, 3, 10])
  })

  it('rejects a JSON-array value with non-numeric elements on a number-list key instead of silently discarding it', () => {
    // Pre-fix, the JSON-array branch in coerce() returned JSON.parse(raw) unchecked, so
    // `config set hints.backoff_thresholds '["a","b"]'` reported success and echoed the bad
    // value, but the load-time int-list validator (validatedIntList) then silently filtered
    // it down to [] on the very next load -- a value that "succeeded" but silently vanished.
    expect(() => cmdConfig({ action: 'set', key: 'hints.backoff_thresholds', value: '["a","b"]' })).toThrow()
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.hints.backoff_thresholds).not.toEqual([])
  })

  it('rejects setting an entire config section to a scalar value instead of corrupting it (#M24)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist', value: 'oops' })).toThrow('section')
    expect(capturedErr()).toBe('')
    invalidateConfigCache()
    const cfg = loadConfig()
    // The section must still be a valid object with its documented fields intact, not
    // silently replaced with the raw string (which would serialize every field as undefined).
    expect(typeof cfg.compact_assist).toBe('object')
    expect(cfg.compact_assist.min_events).toBe(3)
  })

  it('rejects a config set value above the documented max instead of silently clamping on disk (#M28)', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '2000' })).toThrow('outside the allowed range')
    expect(capturedErr()).toBe('')
    // The out-of-range value must never reach disk in the first place.
    expect(fs.existsSync(_testConfigPath)).toBe(false)
  })

  it('accepts a config set value exactly at the documented max instead of rejecting the boundary itself (regression: an off-by-one clamp would silently reject/alter the exact max, not just values past it)', () => {
    // compact_assist.min_events bounds are {min: 0, max: 1000} -- 1000 itself must be a legal, unclamped value.
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '1000' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.compact_assist.min_events).toBe(1000)
  })

  it('accepts a cross-field clampTo value exactly equal to the field it must not exceed (regression: an off-by-one on the clampTo comparison would reject/alter the exact boundary, not just values past it)', () => {
    // bash_compress.cache_max_bytes_per_output has clampTo: 'bash_compress.cache_max_bytes' -- setting
    // it to exactly the current cache_max_bytes value must be accepted unclamped, not rejected.
    cmdConfig({ action: 'set', key: 'bash_compress.cache_max_bytes', value: '20971520' })
    invalidateConfigCache()
    cmdConfig({ action: 'set', key: 'bash_compress.cache_max_bytes_per_output', value: '20971520' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.bash_compress.cache_max_bytes_per_output).toBe(20971520)
  })

  it('rejects a typo\'d compression.profile value instead of silently persisting it and falling back at runtime (#237)', () => {
    // Pre-fix, coerce() returned the raw string unchanged for any non-boolean/number/array
    // field with no revalidation, so `config set compression.profile agressive` reported
    // success and wrote the typo to disk. At runtime, bash_runner.ts's resolveProfile() and
    // dispatch.ts's PROFILE_CAPS[profile] ?? 200 lookup would then silently fall back to the
    // 'balanced' cap with no signal the setting had no effect.
    expect(() => cmdConfig({ action: 'set', key: 'compression.profile', value: 'agressive' })).toThrow('must be one of')
    expect(capturedErr()).toBe('')
    // The invalid value must never reach disk in the first place.
    expect(fs.existsSync(_testConfigPath)).toBe(false)
  })

  it('accepts every valid compression.profile value', () => {
    for (const value of ['auto', 'aggressive', 'balanced', 'minimal']) {
      expect(() => cmdConfig({ action: 'set', key: 'compression.profile', value })).not.toThrow()
      invalidateConfigCache()
      expect(loadConfig().compression.profile).toBe(value)
    }
  })

  it('rejects an unrecognized compact_assist.harness value the same way', () => {
    expect(() => cmdConfig({ action: 'set', key: 'compact_assist.harness', value: 'claudecodex' })).toThrow('must be one of')
    invalidateConfigCache()
    expect(loadConfig().compact_assist.harness).not.toBe('claudecodex')
  })
})

// ── config set warns when an active env var shadows the just-written value ──

describe('cmdConfig set warns when an active env var shadows the write', () => {
  function withEnv(key: string, value: string | undefined, fn: () => void): void {
    const orig = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    invalidateConfigCache()
    try {
      fn()
    } finally {
      if (orig === undefined) delete process.env[key]
      else process.env[key] = orig
      invalidateConfigCache()
    }
  }

  it('emits a stderr warning naming the env var when it forces a different value than what was just written', () => {
    withEnv('TOKEN_GOAT_BASH_COMPRESS', '0', () => {
      cmdConfig({ action: 'set', key: 'bash_compress.enabled', value: 'true' })
      expect(capturedErr()).toContain('warning')
      expect(capturedErr()).toContain('TOKEN_GOAT_BASH_COMPRESS')
      expect(capturedErr()).toContain('bash_compress.enabled')
    })
    // The write to disk must still have gone through despite the active env var —
    // only the runtime effect is shadowed, not the persisted value.
    withEnv('TOKEN_GOAT_BASH_COMPRESS', undefined, () => {
      expect(loadConfig().bash_compress.enabled).toBe(true)
    })
  })

  it('does not warn when the key being set has no env-var override at all', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '55' })
    expect(capturedErr()).toBe('')
  })

  it('does not warn when an env var is active but its value matches what was just written', () => {
    withEnv('TOKEN_GOAT_BASH_COMPRESS', '1', () => {
      cmdConfig({ action: 'set', key: 'bash_compress.enabled', value: 'true' })
      expect(capturedErr()).toBe('')
    })
  })
})

// ── config set against a corrupt config.toml (#249 regression) ──────────────

describe('cmdConfig set backs up a corrupt config.toml instead of silently clobbering it', () => {
  it('copies the unreadable original to config.toml.bak, warns on stderr, and still applies the requested set', () => {
    const corruptContent = 'this is not [ valid toml ===\n'
    fs.writeFileSync(_testConfigPath, corruptContent, 'utf8')
    invalidateConfigCache()

    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '77' })

    expect(capturedErr()).toContain('config.toml.bak')
    expect(capturedErr()).toMatch(/failed to parse|parse/i)

    const backupPath = `${_testConfigPath}.bak`
    expect(fs.existsSync(backupPath)).toBe(true)
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(corruptContent)

    invalidateConfigCache()
    expect(loadConfig().compact_assist.min_events).toBe(77)

    try { fs.unlinkSync(backupPath) } catch { /* ok */ }
  })

  it('does not create a backup or warn when config.toml is simply absent (not corrupt)', () => {
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '33' })
    expect(capturedErr()).toBe('')
    expect(fs.existsSync(`${_testConfigPath}.bak`)).toBe(false)
  })

  it('does not create a backup or warn when config.toml is valid', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nmin_events = 5\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '9' })
    expect(capturedErr()).toBe('')
    expect(fs.existsSync(`${_testConfigPath}.bak`)).toBe(false)
  })
})

// ── config validate exit code (#249 regression) ──────────────────────────────

describe('cmdConfig validate sets a non-zero exit code on findings', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('leaves process.exitCode unset (success) when there are no findings', () => {
    process.exitCode = undefined
    cmdConfig({ action: 'validate' })
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true)
  })

  it('sets process.exitCode = 1 when an unknown section is found', () => {
    fs.writeFileSync(_testConfigPath, '[unknown_xyz]\nfoo = true\n', 'utf8')
    invalidateConfigCache()
    process.exitCode = undefined
    cmdConfig({ action: 'validate' })
    expect(process.exitCode).toBe(1)
  })

  it('sets process.exitCode = 1 when config.toml fails to parse, and reports a parse_error finding', () => {
    fs.writeFileSync(_testConfigPath, 'this is not [ valid toml ===\n', 'utf8')
    invalidateConfigCache()
    process.exitCode = undefined
    cmdConfig({ action: 'validate', json: true })
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(captured()) as { findings: Array<{ kind: string }>; ok: boolean }
    expect(parsed.ok).toBe(false)
    expect(parsed.findings.some((f) => f.kind === 'parse_error')).toBe(true)
  })

  it('sets process.exitCode = 1 with --json too, not just the human-readable path', () => {
    fs.writeFileSync(_testConfigPath, '[bogus_section]\nfoo = 1\n', 'utf8')
    invalidateConfigCache()
    process.exitCode = undefined
    cmdConfig({ action: 'validate', json: true })
    expect(process.exitCode).toBe(1)
  })
})

// ── mutate-then-save commands must not bake env overrides into disk (#M21) ───

describe('config set / project exclude / prune do not persist transient env overrides (#M21)', () => {
  function withBashCompressEnvOff(fn: () => void): void {
    const prevEnv = process.env['TOKEN_GOAT_BASH_COMPRESS']
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    invalidateConfigCache()
    try {
      fn()
    } finally {
      if (prevEnv === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
      else process.env['TOKEN_GOAT_BASH_COMPRESS'] = prevEnv
      invalidateConfigCache()
    }
  }

  it('config set does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdConfig({ action: 'set', key: 'compact_assist.min_events', value: '50' })
    })
    // The env override is gone again now, so loadConfig() reflects disk only.
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })

  it('project exclude does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdProject({ action: 'exclude', pathArg: '/tmp/env-test-proj' })
    })
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })

  it('project prune does not bake a TOKEN_GOAT_BASH_COMPRESS override into bash_compress.enabled on disk', () => {
    withBashCompressEnvOff(() => {
      cmdProject({ action: 'prune' })
    })
    expect(loadConfig().bash_compress.enabled).toBe(true)
  })
})

// ── config validate ──────────────────────────────────────────────────────────

describe('cmdConfig validate', () => {
  it('reports no issues for an absent config (defaults only)', () => {
    cmdConfig({ action: 'validate' })
    expect(captured()).toContain('no issues found')
  })

  it('detects an unknown top-level section', () => {
    fs.writeFileSync(_testConfigPath, '[unknown_xyz]\nfoo = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    const out = captured()
    expect(out).toContain('unknown_section')
    expect(out).toContain('unknown_xyz')
  })

  it('detects an unknown key within a known section', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assist]\nno_such_key_xyz = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    const out = captured()
    expect(out).toContain('unknown_key')
    expect(out).toContain('no_such_key_xyz')
  })

  it('suggests a close match for an unknown section', () => {
    fs.writeFileSync(_testConfigPath, '[compact_assit]\nenabled = true\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate' })
    expect(captured()).toContain('compact_assist')
  })

  it('--json returns findings array', () => {
    fs.writeFileSync(_testConfigPath, '[bogus_section]\nfoo = 1\n', 'utf8')
    invalidateConfigCache()
    cmdConfig({ action: 'validate', json: true })
    const parsed = JSON.parse(captured()) as { findings: unknown[]; ok: boolean }
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(parsed.ok).toBe(false)
  })
})

// ── config unknown action ────────────────────────────────────────────────────

describe('cmdConfig unknown action', () => {
  it('throws on an unknown action, without also writing directly to stderr (regression: double-print via emitErr + throw)', () => {
    expect(() => cmdConfig({ action: 'bogus_action' })).toThrow('unknown action')
    expect(capturedErr()).toBe('')
  })
})

// ── project list ─────────────────────────────────────────────────────────────

describe('cmdProject list', () => {
  it('lists blocked roots from config', () => {
    const cfg = loadPersistedConfig()
    cfg.worker.blocked_roots = ['/some/excluded/path']
    saveConfig(cfg)
    invalidateConfigCache()
    cmdProject({ action: 'list' })
    const out = captured()
    expect(out).toContain('/some/excluded/path')
  })

  it('--json includes blocked_roots array', () => {
    cmdProject({ action: 'list', json: true })
    const parsed = JSON.parse(captured()) as { blocked_roots: string[] }
    expect(Array.isArray(parsed.blocked_roots)).toBe(true)
  })
})

// ── project exclude ───────────────────────────────────────────────────────────

describe('cmdProject exclude', () => {
  it('appends the path to blocked_roots', () => {
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    const cfg = loadConfig()
    expect(cfg.worker.blocked_roots.some((r) => r.includes('fake-proj'))).toBe(true)
  })

  it('is idempotent — does not duplicate', () => {
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    cmdProject({ action: 'exclude', pathArg: '/tmp/fake-proj' })
    invalidateConfigCache()
    const cfg = loadConfig()
    const count = cfg.worker.blocked_roots.filter((r) => r.includes('fake-proj')).length
    expect(count).toBe(1)
  })

  it('is idempotent on a case-insensitive filesystem even when the re-excluded path differs only in casing (regression: the dedup check was a bare string-equality .includes(), not folded through foldPath/normalizePath like every other blocked_roots consumer, e.g. isUnderBlockedRoot)', () => {
    const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
    try {
      cmdProject({ action: 'exclude', pathArg: '/tmp/Fold-Case-Proj' })
      invalidateConfigCache()
      cmdProject({ action: 'exclude', pathArg: '/tmp/fold-case-proj' })
      invalidateConfigCache()
      const cfg = loadConfig()
      const count = cfg.worker.blocked_roots.filter((r) => r.toLowerCase().includes('fold-case-proj')).length
      expect(count).toBe(1)
    } finally {
      if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
    }
  })

  it('throws when path is missing', () => {
    expect(() => cmdProject({ action: 'exclude' })).toThrow()
  })
})

// ── project prune ─────────────────────────────────────────────────────────────

describe('cmdProject prune', () => {
  it('removes non-existent roots and keeps existing ones', () => {
    const real = tmpHome
    const fake = '/this/does/not/exist/ever'
    const cfg = loadPersistedConfig()
    cfg.worker.blocked_roots = [real, fake]
    saveConfig(cfg)
    invalidateConfigCache()
    cmdProject({ action: 'prune' })
    invalidateConfigCache()
    const after = loadConfig()
    expect(after.worker.blocked_roots).toContain(real)
    expect(after.worker.blocked_roots).not.toContain(fake)
  })

  it('--json includes pruned count', () => {
    cmdProject({ action: 'prune', json: true })
    const parsed = JSON.parse(captured()) as { pruned: number; blocked_roots: string[] }
    expect(typeof parsed.pruned).toBe('number')
    expect(Array.isArray(parsed.blocked_roots)).toBe(true)
  })

  it('--dry-run reports what would be pruned without touching the config file', () => {
    const real = tmpHome
    const fake = '/this/does/not/exist/ever'
    const cfg = loadPersistedConfig()
    cfg.worker.blocked_roots = [real, fake]
    saveConfig(cfg)
    invalidateConfigCache()

    cmdProject({ action: 'prune', dryRun: true })

    invalidateConfigCache()
    const after = loadConfig()
    expect(after.worker.blocked_roots).toContain(real)
    expect(after.worker.blocked_roots).toContain(fake)
  })

  it('--dry-run --json reports the would-be-pruned entries without persisting', () => {
    const real = tmpHome
    const fake = '/this/does/not/exist/ever'
    const cfg = loadPersistedConfig()
    cfg.worker.blocked_roots = [real, fake]
    saveConfig(cfg)
    invalidateConfigCache()

    cmdProject({ action: 'prune', dryRun: true, json: true })
    const parsed = JSON.parse(captured()) as { dryRun: boolean; wouldPrune: number; stale: string[]; blocked_roots: string[] }
    expect(parsed.dryRun).toBe(true)
    expect(parsed.wouldPrune).toBe(1)
    expect(parsed.stale).toEqual([fake])
    expect(parsed.blocked_roots).toEqual([real, fake])

    invalidateConfigCache()
    const after = loadConfig()
    expect(after.worker.blocked_roots).toContain(fake)
  })
})

// Regression: `project prune`'s help text has always described "prune = remove stale entries",
// but the implementation only ever touched cfg.worker.blocked_roots -- it never purged already-
// indexed rows for files under the OS system temp directory (scratch checkouts, ad hoc debugging
// copies). These cover the retroactive-cleanup half now wired in alongside the existing
// blocked_roots pruning.
describe('cmdProject prune retroactively removes indexed system-temp files', () => {
  let tempDir: string
  let nonTempDir: string

  function symbolCount(key: string): number {
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_path = ?').get(key) as { n: number }
    return row.n
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdproject-prune-'))
    nonTempDir = fs.mkdtempSync(path.join(process.cwd(), 'tg-cmdproject-prune-nontemp-'))
  })

  afterEach(() => {
    const db = getDb(globalDbPath())
    for (const d of [tempDir, nonTempDir]) {
      const prefix = normalizePath(d)
      try { db.prepare('DELETE FROM symbols WHERE file_path LIKE ?').run(`${prefix}%`) } catch { /* ok */ }
      try { db.prepare('DELETE FROM files WHERE path LIKE ?').run(`${prefix}%`) } catch { /* ok */ }
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ok */ }
    try { fs.rmSync(nonTempDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('non-json prune purges indexed rows under system temp and keeps real-project rows', () => {
    const tempFile = path.join(tempDir, 'scratch.ts')
    fs.writeFileSync(tempFile, 'export const scratchSym = 1\n')
    const tempKey = normalizePath(tempFile)
    indexFileSync(tempKey, globalDbPath())

    const realFile = path.join(nonTempDir, 'real.ts')
    fs.writeFileSync(realFile, 'export const realSym = 1\n')
    const realKey = normalizePath(realFile)
    indexFileSync(realKey, globalDbPath())

    // Each fixture file declares exactly one export -- pin the exact symbol count instead of
    // just ">0", so a regression that indexed the same file's symbol twice (still non-empty)
    // is caught too.
    expect(symbolCount(tempKey)).toBe(1)
    expect(symbolCount(realKey)).toBe(1)

    cmdProject({ action: 'prune' })

    expect(symbolCount(tempKey)).toBe(0)
    expect(symbolCount(realKey)).toBe(1)
  })

  it('--json reports a prunedTempFiles count', () => {
    const tempFile = path.join(tempDir, 'scratch2.ts')
    fs.writeFileSync(tempFile, 'export const scratchSym2 = 1\n')
    const tempKey = normalizePath(tempFile)
    indexFileSync(tempKey, globalDbPath())

    cmdProject({ action: 'prune', json: true })
    const parsed = JSON.parse(captured()) as { pruned: number; blocked_roots: string[]; prunedTempFiles: number }
    // Exactly one temp file was indexed in this test's scope -- pin the exact count instead of
    // just ">0", so a regression that double-counted or over-pruned unrelated files is caught.
    expect(parsed.prunedTempFiles).toBe(1)
    expect(symbolCount(tempKey)).toBe(0)
  })

  it('--dry-run reports staleTempFiles without deleting them', () => {
    const tempFile = path.join(tempDir, 'scratch3.ts')
    fs.writeFileSync(tempFile, 'export const scratchSym3 = 1\n')
    const tempKey = normalizePath(tempFile)
    indexFileSync(tempKey, globalDbPath())

    cmdProject({ action: 'prune', dryRun: true, json: true })
    const parsed = JSON.parse(captured()) as { wouldPruneTempFiles: number; staleTempFiles: string[] }
    expect(parsed.wouldPruneTempFiles).toBe(1)
    expect(parsed.staleTempFiles).toContain(tempKey)
    expect(symbolCount(tempKey)).toBe(1)
  })
})

// ── compact-doc ──────────────────────────────────────────────────────────────

describe('cmdCompactDoc', () => {
  it('emits a compact for a markdown file with a COMPACT_END marker', () => {
    const md = path.join(tmpHome, 'test.md')
    fs.writeFileSync(md, '# Title\n\n<!-- COMPACT_END -->\n\n## Section\n\nAnother paragraph here. More text here.\n', 'utf8')
    cmdCompactDoc({ filePath: md })
    // The message embeds tmpHome's own randomly-generated path, so an exact-string pin isn't
    // possible here -- pin the real structural content instead of just ">0" so a regression
    // that dropped the sidecar-path confirmation text (still non-empty) is caught too.
    expect(captured()).toMatch(/^Compact sidecar built at .+\(source: .+\)\. Use --show to print it, --force to rebuild\.\n$/)
  })

  it('throws when file does not exist', () => {
    expect(() => cmdCompactDoc({ filePath: '/no/such/file.md' })).toThrow()
    expect(capturedErr()).toContain('compact-doc')
  })

  it('--heading filters to a specific section', () => {
    const md = path.join(tmpHome, 'multi.md')
    fs.writeFileSync(md, '# Title\n\nIntro text.\n\n## Install\n\nRun npm install to set up.\n\n## Usage\n\nRun it to use.\n', 'utf8')
    cmdCompactDoc({ filePath: md, heading: 'Install' })
    const out = captured()
    expect(out.toLowerCase()).toContain('install')
    expect(out.toLowerCase()).not.toContain('usage')
  })

  it('--json wraps the compact', () => {
    const md = path.join(tmpHome, 'j.md')
    fs.writeFileSync(md, '# Doc\n\nIntro text.\n\n<!-- COMPACT_END -->\n\nBody text here.\n', 'utf8')
    cmdCompactDoc({ filePath: md, json: true })
    const parsed = JSON.parse(captured()) as { path: string; compact: string }
    expect(typeof parsed.compact).toBe('string')
    // Pin the exact deterministic compact text (everything up to and including the
    // COMPACT_END marker) instead of just ">0", so a regression that truncated too early/late
    // or dropped the marker itself (still non-empty) is caught too.
    expect(parsed.compact).toBe('# Doc\nIntro text.\n<!-- COMPACT_END -->\n')
  })
})

// ── compact-doc: extractive sidecar pipeline (--force/--sentences/--show) ─────

describe('cmdCompactDoc extractive sidecar pipeline', () => {
  function writeDoc(name: string): string {
    const md = path.join(tmpHome, name)
    fs.writeFileSync(
      md,
      '# Title\nLine 1\nLine 2\nLine 3\nLine 4\n\n## Section 2\nOther 1\nOther 2\nOther 3\n',
      'utf8',
    )
    return md
  }

  it('builds a sidecar on disk and prints a short confirmation (no full body) by default', () => {
    const md = writeDoc('default.md')
    const compactPath = compactPathFor(md)

    cmdCompactDoc({ filePath: md })

    expect(fs.existsSync(compactPath)).toBe(true)
    expect(isCompactFresh(compactPath, md)).toBe(true)
    const out = captured()
    expect(out).toContain(compactPath)
    expect(out).not.toContain('Line 3')
  })

  it('--show prints the built sidecar content to stdout', () => {
    const md = writeDoc('show.md')
    cmdCompactDoc({ filePath: md, show: true })

    const out = captured()
    expect(out).toContain('# Title')
    expect(out).toContain('## Section 2')
  })

  it('--sentences controls how many lines per section are kept', () => {
    const md1 = writeDoc('sentences1.md')
    cmdCompactDoc({ filePath: md1, show: true, sentences: '1' })
    const out1 = captured()

    stdoutLines.length = 0
    const md2 = writeDoc('sentences4.md')
    cmdCompactDoc({ filePath: md2, show: true, sentences: '4' })
    const out2 = captured()

    expect(out1).toContain('Line 1')
    expect(out1).not.toContain('Line 2')
    expect(out2).toContain('Line 1')
    expect(out2).toContain('Line 4')
  })

  it(
    '--sentences forces a rebuild even when a fresh cache already exists from a prior call ' +
      'with a different --sentences value (regression: opts.sentences was only applied inside ' +
      'the `opts.force === true || !fresh` branch, so a fresh cache silently ignored an ' +
      'explicit --sentences and returned the stale sentence count instead of rebuilding)',
    () => {
      const md = writeDoc('sentences-refresh.md')
      cmdCompactDoc({ filePath: md, show: true, sentences: '1' })
      const out1 = captured()
      expect(out1).toContain('Line 1')
      expect(out1).not.toContain('Line 2')

      stdoutLines.length = 0
      cmdCompactDoc({ filePath: md, show: true, sentences: '4' })
      const out2 = captured()
      expect(out2).toContain('Line 1')
      expect(out2).toContain('Line 4')
    },
  )

  it('rejects a non-positive --sentences value', () => {
    const md = writeDoc('bad-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: '0' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  it('rejects a non-numeric --sentences value', () => {
    const md = writeDoc('nan-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: 'abc' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  // #232 regression: the old `Number.parseInt(opts.sentences, 10)` accepted trailing garbage
  // ("3x" -> 3) and exponential notation ("1e1" -> 1) instead of rejecting them.
  it('rejects trailing garbage in --sentences instead of silently truncating', () => {
    const md = writeDoc('garbage-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: '3x' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  it('rejects exponential notation in --sentences instead of silently truncating', () => {
    const md = writeDoc('exp-sentences.md')
    expect(() => cmdCompactDoc({ filePath: md, sentences: '1e1' })).toThrow()
    expect(capturedErr()).toContain('--sentences')
  })

  it('reuses a fresh sidecar without --force (rebuilt: false)', () => {
    const md = writeDoc('reuse.md')
    cmdCompactDoc({ filePath: md, json: true })
    const first = JSON.parse(captured()) as { rebuilt: boolean; compact: string }
    expect(first.rebuilt).toBe(true)

    stdoutLines.length = 0
    cmdCompactDoc({ filePath: md, json: true })
    const second = JSON.parse(captured()) as { rebuilt: boolean; compact: string }
    expect(second.rebuilt).toBe(false)
    expect(second.compact).toBe(first.compact)
  })

  it('--force rebuilds even when a fresh sidecar already exists', () => {
    const md = writeDoc('force.md')
    cmdCompactDoc({ filePath: md, json: true })
    const first = JSON.parse(captured()) as { rebuilt: boolean }
    expect(first.rebuilt).toBe(true)

    stdoutLines.length = 0
    cmdCompactDoc({ filePath: md, json: true, force: true })
    const second = JSON.parse(captured()) as { rebuilt: boolean }
    expect(second.rebuilt).toBe(true)
  })

  it('--json includes path, compactPath, rebuilt, and compact fields', () => {
    const md = writeDoc('json-shape.md')
    cmdCompactDoc({ filePath: md, json: true })
    const parsed = JSON.parse(captured()) as {
      path: string
      compactPath: string
      rebuilt: boolean
      compact: string
    }
    expect(parsed.path).toBe(path.resolve(md))
    expect(parsed.compactPath).toBe(compactPathFor(md))
    expect(parsed.rebuilt).toBe(true)
    // Pin the exact deterministic extractive-sidecar output instead of just ">0", so a
    // regression in the sentence-selection/truncation logic (still non-empty) is caught too.
    expect(parsed.compact).toBe('# Title\nLine 1\nLine 2\n\n## Section 2\nOther 1\nOther 2\n')
  })
})

// ── fetch-image (fetchBuffer redirect cap) ────────────────────────────────────

describe('cmdFetchImage security hardening (regression: fetchBuffer now routes through webfetch.ts\'s SSRF/size/redirect-capped performHttpFetch instead of a bare, unguarded http.get)', () => {
  it('rejects a loopback/private-IP URL with a clear SSRF error, using the real (unmocked) SSRF check', async () => {
    const out = path.join(tmpHome, 'ssrf-blocked.bin')
    await expect(cmdFetchImage({ url: 'http://127.0.0.1:1/image.png', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/blocked by ssrf safety check/i)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('still fetches a normal public URL (network mocked) and writes the returned bytes to disk', async () => {
    const fakeBytes = Buffer.from('fake-image-bytes')
    performHttpFetchMock.mockImplementationOnce(
      async (url: string, opts: { maxSizeBytes: number; timeoutSec: number; redirectsLeft: number }) => {
        expect(url).toBe('http://example.test/image.png')
        // Pin the real named constants (FETCH_IMAGE_MAX_SIZE_BYTES/FETCH_IMAGE_TIMEOUT_SEC)
        // instead of just ">0", so a typo (e.g. dropping a `* 1024` factor, still non-zero)
        // is caught too.
        expect(opts.maxSizeBytes).toBe(50 * 1024 * 1024)
        expect(opts.timeoutSec).toBe(30)
        expect(opts.redirectsLeft).toBe(5)
        return { status: 200, statusText: 'OK', headers: {}, body: fakeBytes }
      },
    )
    const out = path.join(tmpHome, 'happy-path.bin')
    await cmdFetchImage({ url: 'http://example.test/image.png', out })
    expect(fs.readFileSync(out)).toEqual(fakeBytes)
  })

  it('rejects with the HTTP status when performHttpFetch resolves a non-2xx response', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => ({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: Buffer.alloc(0),
    }))
    const out = path.join(tmpHome, 'not-found.bin')
    await expect(cmdFetchImage({ url: 'http://example.test/missing.png', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/HTTP 404/)
  })

  it('propagates a too-many-redirects rejection from performHttpFetch instead of swallowing it', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => {
      throw new Error('Too many redirects fetching http://redirect-loop.example.test/start')
    })
    const out = path.join(tmpHome, 'redirect-loop.bin')
    await expect(cmdFetchImage({ url: 'http://redirect-loop.example.test/start', out })).rejects.toThrow()
    expect(capturedErr()).toMatch(/too many redirects/i)
  })

  // Regression: with no --out, the default destination was always `.bin` regardless of the
  // response's actual content-type, so e.g. a JPEG response landed under a name that hid its
  // real format. The default extension should come from the content-type header instead.
  it('derives the default (no --out) extension from the response content-type header', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from('fake-jpeg-bytes'),
    }))
    await cmdFetchImage({ url: 'http://example.test/photo.jpg', json: true })
    const parsed = JSON.parse(captured()) as { out: string }
    expect(parsed.out.endsWith('.jpg')).toBe(true)
    expect(fs.existsSync(parsed.out)).toBe(true)
  })

  // Regression: same root bug as screenshot.ts's takeScreenshot -- shrinkImage may re-encode
  // the fetched bytes to a different container format (JPEG/WebP), but the shrunk bytes were
  // written verbatim under the originally-requested (or default) extension, mislabeling the
  // file's real format.
  it('renames the destination extension to match a format-changing shrink', async () => {
    performHttpFetchMock.mockImplementationOnce(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('fake-png-bytes'),
    }))
    shrinkImageMock.mockResolvedValueOnce({
      data: Buffer.from('fake-jpeg-bytes'),
      format: 'jpeg',
      shrunkBytes: 15,
      width: 10,
      height: 10,
    })
    const requestedOut = path.join(tmpHome, 'shrink-format-change.png')
    await cmdFetchImage({ url: 'http://example.test/image.png', out: requestedOut })
    const expectedOut = path.join(tmpHome, 'shrink-format-change.jpg')
    expect(fs.existsSync(expectedOut)).toBe(true)
    expect(fs.existsSync(requestedOut)).toBe(false)
    expect(fs.readFileSync(expectedOut).toString()).toBe('fake-jpeg-bytes')
    expect(captured()).toContain(expectedOut)
  })

  // Regression: cmdFetchImage wrote the fetched/shrunk bytes to the destination path via a
  // bare fs.writeFileSync instead of the atomic temp-file+rename helper every other disk-cache
  // write path in this codebase uses (webfetch.ts's cachePath/shrunkPath, screenshot.ts's
  // takeScreenshot). A direct writeFileSync truncates the destination in place, so a concurrent
  // reader of the same --out path (e.g. two overlapping `fetch-image` invocations targeting the
  // same file, or a hook reading the file while a second fetch is mid-write) can observe a
  // truncated/partial file instead of either the old or the new complete content.
  it('writes the fetched image to disk via the atomic write helper, not a direct truncating write', async () => {
    const fakeBytes = Buffer.from('atomic-write-regression-bytes')
    performHttpFetchMock.mockImplementationOnce(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: fakeBytes,
    }))
    const out = path.join(tmpHome, 'atomic-write-check.bin')

    await cmdFetchImage({ url: 'http://example.test/atomic.png', out })

    expect(fs.readFileSync(out)).toEqual(fakeBytes)
    expect(atomicWriteBytesMock).toHaveBeenCalledWith(out, fakeBytes)
    // No temp-file sibling should be left behind by the atomic write.
    const dir = path.dirname(out)
    const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftoverTmp).toEqual([])
  })
})

// ── history ───────────────────────────────────────────────────────────────────

describe('cmdHistory', () => {
  it('reports empty when no blobs exist', () => {
    cmdHistory({})
    expect(captured()).toContain('No history entries found')
  })

  it('shows bash entries when bash blobs are present', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'abc123', { command: 'npm run build', storedAt: Date.now(), exitCode: 0, sizeBytes: 100 })
    cmdHistory({})
    expect(captured()).toContain('npm run build')
  })

  it('shows web entries when web blobs are present', () => {
    storeBlob(WEB_OUTPUT_SUBDIR, 'web001', { url: 'https://example.com/api', content: 'body text' })
    cmdHistory({})
    expect(captured()).toContain('https://example.com/api')
  })

  it('--limit restricts output count', () => {
    for (let i = 0; i < 5; i++) {
      storeBlob(BASH_OUTPUT_SUBDIR, `cmd${i}`, { command: `echo ${i}`, storedAt: Date.now() + i, exitCode: 0, sizeBytes: 10 })
    }
    cmdHistory({ limit: '2' })
    const lines = captured().split('\n').filter((l) => l.includes('bash'))
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('rejects a non-numeric --limit instead of silently returning empty output', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'abc123', { command: 'npm run build', storedAt: Date.now(), exitCode: 0, sizeBytes: 100 })
    // Pre-fix, Number.parseInt('abc', 10) produced NaN, Math.max(1, NaN) stayed NaN, and
    // Array.prototype.slice(0, NaN) returns [] — so an invalid --limit silently printed "No
    // history entries found" even though entries existed, instead of raising a clear error.
    expect(() => cmdHistory({ limit: 'abc' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  // #232 regression: trailing garbage ("30x" -> 30 via Number.parseInt), exponential notation
  // ("1e3" -> 1), and a negative value (silently clamped up to 1 by the old Math.max(1, n)) must
  // all be rejected instead of silently coerced.
  it('rejects trailing garbage in --limit instead of silently truncating', () => {
    expect(() => cmdHistory({ limit: '30x' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  it('rejects exponential notation in --limit instead of silently truncating', () => {
    expect(() => cmdHistory({ limit: '1e3' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  // A --limit of 0 would slice the merged bash/web list down to zero entries and print "No
  // history entries found" -- an absolute claim about the cache's contents -- even when
  // entries genuinely exist. Reject explicitly instead of silently rendering that false-clean
  // result, matching runFind's own --limit validation (read_commands.ts) and
  // graph_commands.ts's --top validation for the same failure mode.
  it('rejects --limit 0 instead of silently reporting an empty history', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'real1', { command: 'npm run build', storedAt: Date.now(), exitCode: 0, sizeBytes: 100 })
    expect(() => cmdHistory({ limit: '0' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  it('rejects a negative --limit instead of silently clamping to 1', () => {
    expect(() => cmdHistory({ limit: '-5' })).toThrow()
    expect(capturedErr()).toContain('--limit')
  })

  it('--json emits an array', () => {
    storeBlob(BASH_OUTPUT_SUBDIR, 'xyz', { command: 'ls', storedAt: Date.now(), exitCode: 0, sizeBytes: 10 })
    cmdHistory({ json: true })
    const arr = JSON.parse(captured()) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
    // Exactly one blob was stored in this test's isolated tmpHome -- pin the exact count
    // instead of just ">0", so a regression that double-listed the same entry is caught too.
    expect(arr.length).toBe(1)
  })
})
