/**
 * Regression: `formatCompression`'s withheld-payload notice hardcoded `--payload`, but that
 * flag only exists on `compress-text`. `handoff-resolve` shares `formatCompression` and does not
 * have `--payload`, so a losing handoff printed a suggestion that fails when actually run:
 *
 *   $ token-goat handoff-resolve losing            -> "...pass --payload to print it anyway"
 *   $ token-goat handoff-resolve losing --payload   -> error: unknown option '--payload'
 *
 * This is the same executable-suggestion defect class tests/guards/changed_ref_hint.test.ts
 * guards for `changed`'s hint text: a suggested command must actually resolve and run, not just
 * read plausibly. This test parses the flag out of the emitted notice and re-runs the exact
 * command it names, so a third caller of formatCompression regressing the same way fails here
 * too, rather than relying on a hardcoded string match.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

/** Low-compressibility text: pseudo-random words, deterministic so the size ratio never drifts across runs. */
function lowCompressibilityText(): string {
  let seed = 98765
  const words: string[] = []
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    words.push(seed.toString(36))
  }
  return words.join(' ')
}

let home: string
let envRoot: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(process.cwd(), '.tg-handoff-flag-'))
  process.env['TOKEN_GOAT_HOME'] = home
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

function runIsolated(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd: home })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('handoff-resolve withheld-payload suggestion is executable', () => {
  it('suggests a flag that handoff-resolve actually accepts, and running it succeeds', () => {
    const create = runIsolated(['handoff-create', 'losing', lowCompressibilityText()])
    expect(create.status, create.stderr).toBe(0)

    const resolve = runIsolated(['handoff-resolve', 'losing'])
    expect(resolve.status, resolve.stderr).toBe(0)
    expect(resolve.stdout).toContain('payload withheld')

    const match = /pass (--[a-z-]+) to /.exec(resolve.stdout)
    expect(match, `expected the withheld-payload notice to name a flag: ${resolve.stdout}`).not.toBeNull()
    const suggestedFlag = match![1]

    const rerun = runIsolated(['handoff-resolve', 'losing', suggestedFlag])
    expect(rerun.status, `suggested flag ${suggestedFlag} must actually run: ${rerun.stderr}`).toBe(0)
  })

  it('the suggested flag is --full, and it returns the original text back outright, not a base64 payload', () => {
    const create = runIsolated(['handoff-create', 'losing2', lowCompressibilityText()])
    expect(create.status, create.stderr).toBe(0)

    const resolve = runIsolated(['handoff-resolve', 'losing2'])
    expect(resolve.status, resolve.stderr).toBe(0)
    expect(resolve.stdout).toContain('pass --full to')
    expect(resolve.stdout, 'must not claim it prints a payload -- --full returns the original text instead').not.toContain('pass --payload to')

    const full = runIsolated(['handoff-resolve', 'losing2', '--full'])
    expect(full.status, full.stderr).toBe(0)
    expect(full.stdout.replace(/\n$/, '')).toBe(lowCompressibilityText())
  })
})
