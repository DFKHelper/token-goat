/**
 * The suite must run on token-goat's defaults, not on the settings of the shell it was launched from. CAPTURE, 2026-09-29: with `TOKEN_GOAT_BASH_COMPRESS=0` exported in the developer's shell, `npm test` failed three guards that pass in CI (tests/guards/fold_pointer_notices_round_trip.test.ts twice and tests/guards/rewritten_output_never_carries_a_secret.test.ts), because the product read the inherited setting and turned output compression off under them. The same shell also exported `TOKEN_GOAT_ASK_MODEL`.
 *
 * Provenance: the scrub cases are HAND-DERIVED from the variable names alone. The list of variables CI and the git hooks set is read live from those files on every run (FORMAT-DERIVED from the files themselves), so it cannot go stale. The end-to-end case spawns the real vitest with the real vitest.config.ts, so it proves the setup file actually runs the scrub, not that the helper works when called.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { KEPT_TOKEN_GOAT_ENV_PREFIX, KEPT_TOKEN_GOAT_ENV_VARS, scrubTokenGoatUserEnv } from '../helpers/token-goat-env.js'
import { removeProbe, writeProbe } from '../helpers/vitest-probe.js'
import { pinnedPopulation } from './population.js'

const KEPT = KEPT_TOKEN_GOAT_ENV_VARS as readonly string[]
const isKept = (name: string): boolean => name.startsWith(KEPT_TOKEN_GOAT_ENV_PREFIX) || KEPT.includes(name)
const SETTING_RE = /\b(?:TOKEN_GOAT|TOKENWISE)_[A-Z0-9_]+/g

const PROBE_NAME = 'zz_generated_env_probe.test.ts'
let probe: string | undefined

afterAll(() => {
  if (probe !== undefined) removeProbe(probe)
})

/** Every file outside src/ that sets or reads a token-goat variable on purpose. */
function toolingFiles(): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'hooks' && path.basename(dir) === '.github') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  for (const dir of ['.github', '.lefthook-scripts', path.join('tests', 'setup')]) walk(path.resolve(dir))
  for (const file of ['lefthook.yml', 'vitest.config.ts']) out.push(path.resolve(file))
  // 25 files when this was written. The anchors are the three that set a kept variable today: the CI workflow, the commit-msg hook and the setup file's own pins.
  return pinnedPopulation({
    what: 'tooling files that may name a token-goat variable',
    items: out,
    floor: 20,
    mustInclude: ['ci.yml', 'check-commit-msg.sh', 'isolate-home.ts', 'vitest.config.ts'],
  })
}

describe('the test process inherits no token-goat setting', () => {
  it('scrubs product settings under both prefixes and keeps the infrastructure ones', () => {
    const env: NodeJS.ProcessEnv = {
      TOKEN_GOAT_BASH_COMPRESS: '0',
      TOKEN_GOAT_ASK_MODEL: 'some-model',
      TOKENWISE_COMPACT_ASSIST: 'false',
      TOKEN_GOAT_HOME: '/kept/home',
      TOKEN_GOAT_REQUIRE_EMBED_MODEL: '1',
      TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD: '1',
      PATH: '/usr/bin',
      TG_TEST_RUN_ROOT: '/run',
    }
    scrubTokenGoatUserEnv(env)
    expect(env).toEqual({
      TOKEN_GOAT_HOME: '/kept/home',
      TOKEN_GOAT_REQUIRE_EMBED_MODEL: '1',
      TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD: '1',
      PATH: '/usr/bin',
      TG_TEST_RUN_ROOT: '/run',
    })
  })

  it('keeps every variable CI, the git hooks and the test setup name', () => {
    const named = new Set<string>()
    for (const file of toolingFiles()) for (const match of fs.readFileSync(file, 'utf8').matchAll(SETTING_RE)) named.add(match[0])
    expect(named.size, 'found no token-goat variable in the tooling files, so the comparison below is empty').toBeGreaterThan(5)
    expect([...named].filter((name) => !isKept(name)).sort(), 'named by tooling but scrubbed by tests/helpers/token-goat-env.ts').toEqual([])
  })

  it('carries none of the scrubbed ones into this process', () => {
    // Only non-vacuous when the launching shell exported one, which is exactly the case this guards.
    expect(Object.keys(process.env).filter((name) => /^(?:TOKEN_GOAT|TOKENWISE)_/i.test(name) && !isKept(name.toUpperCase()))).toEqual([])
  })

  it('a test run launched with product settings exported sees none of them', () => {
    probe = writeProbe(PROBE_NAME, [
      "import { expect, it } from 'vitest'",
      "it('generated probe: inherited token-goat settings are gone', () => {",
      "  expect(process.env['TOKEN_GOAT_BASH_COMPRESS']).toBeUndefined()",
      "  expect(process.env['TOKEN_GOAT_ASK_MODEL']).toBeUndefined()",
      "  expect(process.env['TOKENWISE_COMPACT_ASSIST']).toBeUndefined()",
      "  expect(process.env['TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD']).toBe('1')",
      '})',
      '',
    ])
    const res = spawnSync(process.execPath, [path.resolve('node_modules', 'vitest', 'vitest.mjs'), 'run', probe], {
      encoding: 'utf8',
      // The bundle build this config runs in globalSetup would race the outer run's readers of the same artifact.
      env: { ...process.env, CI: '', TOKEN_GOAT_BASH_COMPRESS: '0', TOKEN_GOAT_ASK_MODEL: 'some-model', TOKENWISE_COMPACT_ASSIST: 'false', TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD: '1' },
    })
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`
    expect(res.status, combined.slice(-2000)).toBe(0)
    expect(combined).toMatch(/1 passed/)
  }, 120_000)
})
