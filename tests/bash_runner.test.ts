/**
 * Tests for the `token-goat compress` subprocess wrapper (src/bash_runner.ts).
 *
 * Two layers, per the project's injected-seam discipline:
 *   1. In-process unit tests of `run`/`runRaw` — filter application, the
 *      compression body, the token cap, and exit-code passthrough.
 *   2. A built-bundle e2e that drives `dist/token-goat.mjs compress` in a
 *      separate process. This is the authoritative coverage: it fails if the
 *      `compress` command is unregistered or tree-shaken out of the shipped
 *      artifact, which a mock-callback unit test could never catch.
 *
 * `run` records a savings stat via the global DB, whose path (DATA_DIR) is
 * frozen at constants.ts import time. We point LOCALAPPDATA/XDG_DATA_HOME at a
 * temp dir BEFORE dynamically importing bash_runner so the stat lands in the
 * temp DB, never the developer's real ~/.local global.db, then restore the env
 * so the override does not leak to other test files sharing this worker.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const DATA_DIR_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-br-data-'))
const _savedLocal = process.env['LOCALAPPDATA']
const _savedXdg = process.env['XDG_DATA_HOME']
process.env['LOCALAPPDATA'] = DATA_DIR_TMP
process.env['XDG_DATA_HOME'] = DATA_DIR_TMP
const { run, runRaw } = await import('../src/bash_runner.js')
const { defaultConfig, invalidateConfigCache, saveConfig } = await import('../src/config.js')
const { configPath } = await import('../src/constants.js')
// DATA_DIR is now frozen to the temp dir; restore env to avoid leaking the override into sibling test modules that run in the same worker.
if (_savedLocal === undefined) delete process.env['LOCALAPPDATA']
else process.env['LOCALAPPDATA'] = _savedLocal
if (_savedXdg === undefined) delete process.env['XDG_DATA_HOME']
else process.env['XDG_DATA_HOME'] = _savedXdg

/** Quote a path for embedding in a shell command string (no embedded quote). */
function q(p: string): string {
  return `"${p}"`
}

let scriptDir: string

/** Write a tiny node script and return its path. */
function script(name: string, body: string): string {
  const p = path.join(scriptDir, name)
  fs.writeFileSync(p, body)
  return p
}

/** A shell command string that runs a node script cross-platform. */
function nodeCmd(scriptPath: string): string {
  return `${q(process.execPath)} ${q(scriptPath)}`
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-br-scripts-'))
})

afterAll(() => {
  // Best-effort: on Windows the still-open SQLite handle on the temp global.db keeps the dir locked (EPERM); the OS reclaims it later.
  for (const dir of [scriptDir, DATA_DIR_TMP]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore — temp dir, reclaimed by the OS
    }
  }
})

describe('bash_runner.run (in-process)', () => {
  it('applies the named filter and dedupes consecutive lines', () => {
    // 60 repeats (not 6): dedupe collapses ~900 bytes down to one line, clearing
    // the net-benefit floor (bash_compress.min_net_savings_bytes) by a wide
    // margin. A handful of repeats saves only marker-sized bytes and would now
    // legitimately fall back to the untouched original — this fixture exercises
    // the real dedupe logic, not that trivial-savings edge case.
    const s = script('dup.js', "for (let i = 0; i < 60; i++) console.log('compiling...')\nconsole.log('done')\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    expect(out).toContain('×60')
    expect(out).toContain('done')
    expect(out).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })

  it('returns the wrapped command exit code through the compression path', () => {
    const s = script('fail.js', "console.log('partial output')\nprocess.exit(3)\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(3)
  })

  it('caps output to --max-tokens while keeping the savings marker', () => {
    const s = script('many.js', "for (let i = 0; i < 300; i++) console.log('unique-line-' + i)\n")
    let out = ''
    run(nodeCmd(s), { filterName: 'generic', maxTokens: 20, writeStdout: (x) => (out += x) })
    expect(out).toContain('capped at ~20 tokens')
    expect(out).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })

  it('streams a command through untouched when no filter matches', () => {
    // `exit` is a shell builtin that no tool filter will ever claim, so this exercises the filter===null passthrough branch and its exit-code mapping.
    expect(run('exit 9')).toBe(9)
  })

  it('still applies --max-tokens when no tool filter matches the command', () => {
    // Regression: run() routed straight to passthrough() (stdio: 'inherit') whenever
    // resolveFilter returned null, and passthrough() never looked at opts.maxTokens -- the cap
    // logic only lived inside wrapAndCompress. A plain shell `for` loop has no matching tool
    // filter (no registered filter claims "for"), so pre-fix this printed all 300 lines
    // uncapped despite --max-tokens.
    let out = ''
    const code = run("for i in $(seq 1 300); do echo unfiltered-unique-line-$i; done", {
      maxTokens: 20,
      writeStdout: (x) => (out += x),
    })
    expect(code).toBe(0)
    expect(out).toContain('capped at ~20 tokens')
    expect(out).not.toContain('unfiltered-unique-line-299')
  })

  it('runRaw streams raw output and returns the exit code', () => {
    expect(runRaw('exit 4')).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Config-driven bash_compress.max_lines / max_bytes. Before this fix,
// wrapAndCompress never passed maxLines/maxBytes to compressOutput at all, so
// changing these config.ts knobs had zero effect on the real compression path
// — it silently used the tool-filter layer's own internal defaults instead.
// ---------------------------------------------------------------------------
describe('bash_runner.run — config-driven compress limits (bash_compress.max_lines / max_bytes)', () => {
  // saveConfig does not create configPath()'s parent directory itself; when
  // this describe block runs in isolation (e.g. via -t filtering) no earlier
  // test has created it as a side effect, so do it explicitly here.
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })

  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(path.join(DATA_DIR_TMP, 'config.toml'))
    } catch {
      // ok — may not exist
    }
  })

  it('honors a configured max_lines well below the default (unconfigured) line count', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.max_lines = 50 // config.ts's validated floor for this field
    saveConfig(cfg)

    const s = script('manylines.js', "for (let i = 0; i < 300; i++) console.log('unique-line-' + i)\n")
    let out = ''
    run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    const lineCount = out.split('\n').filter((l) => l.startsWith('unique-line-')).length
    // Unconfigured, the 'balanced' profile cap (200) would leave ~200 lines; a
    // configured max_lines=50 should cut that down well below that.
    expect(lineCount).toBeLessThanOrEqual(55)
  })

  it('honors a configured max_bytes well below the built-in 64KB default', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.max_bytes = 200
    saveConfig(cfg)

    const s = script('bigout.js', "console.log('x'.repeat(50000))\n")
    let out = ''
    run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    // Unconfigured, the output would be capped at the built-in 64KB default;
    // a configured max_bytes=200 should cut that down to a few hundred bytes.
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(2000)
  })
})

// ---------------------------------------------------------------------------
// Net-benefit floor (bash_compress.min_net_savings_bytes). A rewrite whose
// bytesSaved doesn't clear the marker's own byte cost plus this configured
// floor destabilises the bytes (breaks provider prefix caching) for a saving
// too small to be worth it. Below the floor the ORIGINAL output ships
// untouched with no marker; above it, compression proceeds exactly as before.
// ---------------------------------------------------------------------------
describe('bash_runner.run — net-benefit floor (bash_compress.min_net_savings_bytes)', () => {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })

  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(path.join(DATA_DIR_TMP, 'config.toml'))
    } catch {
      // ok — may not exist
    }
  })

  it('a below-floor saving passes through the ORIGINAL output untouched with no marker', () => {
    // Two repeats of "compiling..." dedupe to a couple dozen bytes of saving —
    // smaller than the ~70-byte marker plus the default 100-byte floor, so this
    // must fall all the way back to the untouched original.
    const s = script('tiny-dup.js', "for (let i = 0; i < 2; i++) console.log('compiling...')\nconsole.log('done')\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    expect(out).not.toContain('×2')
    expect(out).not.toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
    expect(out.trim()).toBe('compiling...\ncompiling...\ndone')
  })

  it('an above-floor saving still compresses exactly as today, marker included', () => {
    // 60 repeats produces a large, unambiguous dedupe win that clears the
    // default 100-byte floor by a wide margin.
    const s = script('big-dup.js', "for (let i = 0; i < 60; i++) console.log('compiling...')\nconsole.log('done')\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    expect(out).toContain('×60')
    expect(out).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })

  it('the config key actually moves the threshold: lowering it ships a rewrite that the default floor would have suppressed', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.min_net_savings_bytes = 0
    saveConfig(cfg)

    // 10 repeats dedupes under the default floor's own math (bytesSaved clears
    // the marker cost) but not the default's extra 100-byte margin -- with
    // min_net_savings_bytes=0 it should ship.
    const s = script('tiny-dup2.js', "for (let i = 0; i < 10; i++) console.log('compiling...')\nconsole.log('done')\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    expect(out).toContain('×10')
  })

  it('the config key actually moves the threshold: raising it suppresses a rewrite the default floor would have shipped', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.min_net_savings_bytes = 100_000
    saveConfig(cfg)

    const s = script('big-dup2.js', "for (let i = 0; i < 60; i++) console.log('compiling...')\nconsole.log('done')\n")
    let out = ''
    const code = run(nodeCmd(s), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    expect(out).not.toContain('×60')
    expect(out).not.toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })
})

describe('compress command (built-bundle e2e)', () => {
  let dataBase: string

  beforeAll(() => {
    dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-br-e2e-data-'))
  })

  afterAll(() => {
    fs.rmSync(dataBase, { recursive: true, force: true })
  })

  function compress(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [BUNDLE, 'compress', ...args], {
      // Child re-imports constants → DATA_DIR resolves to the isolated temp dir.
      env: { ...process.env, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase },
      encoding: 'utf8',
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  it('is reachable from the shipped registry and compresses output', () => {
    // 60 repeats -- see the in-process test above for why 6 is no longer enough
    // to clear the net-benefit floor.
    const s = script('e2e-dup.js', "for (let i = 0; i < 60; i++) console.log('compiling...')\nconsole.log('done')\n")
    const r = compress(['--filter', 'generic', '--cmd', nodeCmd(s)])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('×60')
    expect(r.stdout).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })

  it('preserves the wrapped command exit code', () => {
    const s = script('e2e-fail.js', "console.log('partial')\nprocess.exit(3)\n")
    const r = compress(['--filter', 'generic', '--cmd', nodeCmd(s)])
    expect(r.status).toBe(3)
  })

  it('--no-compress streams raw output and preserves the exit code', () => {
    const s = script('e2e-raw.js', "console.log('raw-line')\nprocess.exit(5)\n")
    const r = compress(['--no-compress', '--cmd', nodeCmd(s)])
    expect(r.status).toBe(5)
    expect(r.stdout).toContain('raw-line')
  })
})
