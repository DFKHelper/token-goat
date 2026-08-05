import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { defaultConfig, loadConfig, saveConfig, invalidateConfigCache, type Config } from '../../src/config.js'

/**
 * Systematic guard against the saveConfig-omission bug class.
 *
 * This repo has shipped that same bug at least four separate times -- `reread_deny_min_bytes`,
 * `large_read_redirect_bytes`, `cache_min_bytes`, and a trio of `hints` fields -- each time
 * caught only in production and each time closed with its own hand-written, single-key
 * regression test. Those tests are all still valuable, but they only ever cover the key that
 * already broke: a section added tomorrow whose author forgets the `saveConfig` serialize arm
 * reintroduces the identical defect, silently resetting the user's value to the default on the
 * next unrelated `config set`.
 *
 * This walks every scalar leaf in the real Config object instead of naming any of them, so the
 * guard's coverage grows automatically with the schema. A new key wired through the interface,
 * defaults, and loader but NOT through saveConfig fails here on the commit that adds it.
 */
describe('config round-trip completeness (every scalar key survives saveConfig -> loadConfig)', () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-roundtrip-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    invalidateConfigCache()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    invalidateConfigCache()
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  // Nudging by one keeps every key inside its own per-key bounds, which is all this can guarantee: a key clamped against a SIBLING can still be rewritten by the loader no matter which direction it moves (bash_compress.cache_max_bytes_per_output defaults ABOVE its own cache_max_bytes ceiling, so every value it can take is clamped). Those keys are listed in CLAMPED_BY_DESIGN with their invariant rather than being papered over by a cleverer perturbation, so the exemption stays visible and gets staleness-checked.
  function perturb(value: number | boolean): number | boolean {
    if (typeof value === 'boolean') return !value
    if (!Number.isFinite(value)) return value
    if (Number.isInteger(value)) return value > 1 ? value - 1 : value + 1
    return Number((value / 2).toFixed(4))
  }

  function scalarLeaves(obj: unknown, prefix = ''): Array<[string, number | boolean]> {
    const found: Array<[string, number | boolean]> = []
    if (obj === null || typeof obj !== 'object') return found
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const dotted = prefix === '' ? key : `${prefix}.${key}`
      if (typeof value === 'number' || typeof value === 'boolean') found.push([dotted, value])
      else if (value !== null && typeof value === 'object' && !Array.isArray(value)) found.push(...scalarLeaves(value, dotted))
    }
    return found
  }

  function setAt(root: Record<string, unknown>, dotted: string, value: unknown): void {
    const parts = dotted.split('.')
    let cursor = root
    for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>
    cursor[parts[parts.length - 1]!] = value
  }

  function getAt(root: Record<string, unknown>, dotted: string): unknown {
    const parts = dotted.split('.')
    let cursor: unknown = root
    for (const part of parts) cursor = (cursor as Record<string, unknown>)[part]
    return cursor
  }

  // Keys the loader deliberately rewrites to satisfy a cross-key invariant, so a perturbed value legitimately does not survive verbatim. Each entry must state the invariant; anything else failing the round-trip is a real dropped key, not a clamp.
  const CLAMPED_BY_DESIGN: Record<string, string> = {
    'bash_compress.cache_max_bytes_per_output':
      'clamped to bash_compress.cache_max_bytes by _buildConfig -- a per-item cap above the whole-directory budget would let pruneBlobs() evict a just-written item',
  }

  it('finds a substantial number of scalar config keys (sanity check that the walk is not silently matching nothing)', () => {
    expect(scalarLeaves(defaultConfig()).length).toBeGreaterThan(30)
  })

  it('every CLAMPED_BY_DESIGN exemption is still needed (an exemption that outlives its clamp silently hides a real dropped key)', () => {
    for (const dotted of Object.keys(CLAMPED_BY_DESIGN)) {
      const cfg = defaultConfig()
      const current = getAt(cfg as unknown as Record<string, unknown>, dotted)
      expect(typeof current, `${dotted} no longer exists in Config -- drop its exemption`).not.toBe('undefined')
      setAt(cfg as unknown as Record<string, unknown>, dotted, perturb(current as number | boolean))
      saveConfig(cfg as Config)
      invalidateConfigCache()
      const got = getAt(loadConfig() as unknown as Record<string, unknown>, dotted)
      const wanted = perturb(current as number | boolean)
      expect(got, `${dotted} now round-trips cleanly -- its clamp is gone, so remove the exemption instead of letting it mask a future regression`).not.toBe(wanted)
    }
  })

  it('persists every perturbed scalar key through saveConfig and reads it back unchanged', () => {
    const cfg = defaultConfig()
    const leaves = scalarLeaves(cfg)
    const expected = new Map<string, number | boolean>()
    for (const [dotted, value] of leaves) {
      const next = perturb(value)
      setAt(cfg as unknown as Record<string, unknown>, dotted, next)
      expected.set(dotted, next)
    }

    saveConfig(cfg as Config)
    invalidateConfigCache()
    const reloaded = loadConfig() as unknown as Record<string, unknown>

    const dropped: string[] = []
    for (const [dotted, want] of expected) {
      if (dotted in CLAMPED_BY_DESIGN) continue
      if (getAt(reloaded, dotted) !== want) dropped.push(dotted)
    }
    // Naming the offenders matters more than the count here: the failure message IS the fix list for whoever adds a section and forgets an arm.
    expect(dropped, `config keys lost across saveConfig -> loadConfig (missing a saveConfig serialize arm or a loader arm): ${dropped.join(', ')}`).toEqual([])
  })
})
