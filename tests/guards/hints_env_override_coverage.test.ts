/**
 * Guard: every scalar `hints.*` field readable from config.toml must also be settable from the
 * environment.
 *
 * The gap this exists to prevent is quiet: a field added with only a `validated*` line works
 * perfectly through config.toml, so nothing fails -- but the only way to change it for a single
 * run (a dogfood check, a one-off CLI invocation, a test) becomes "write a config.toml into the
 * data dir and remember to delete it". Twelve fields had drifted into that state before this
 * guard existed, including `protect_recent_reads` and `diff_hint_min_tokens_saved`, both of which
 * gate re-read behavior and are exactly what someone reaches for when checking hook behavior by
 * hand.
 *
 * Derives both sides from the source rather than from a hand-maintained list, so it cannot go
 * stale the way the list it replaces did.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'config.ts')

/**
 * Fields intentionally reachable only through config.toml, each with the reason it cannot follow
 * the scalar pattern. Keep this list minimal: an entry here is an admission that one config field
 * behaves differently from every other, so it needs a reason a reader can check, not just a name.
 */
const EXEMPT = new Map<string, string>([
  ['backoff_thresholds', 'number[] -- no env helper parses a list, so an override would have to invent a serialization format'],
])

function readConfigSrc(): string {
  return fs.readFileSync(CONFIG_SRC, 'utf8')
}

/** Fields assigned from config.toml via any `validated*` helper (validatedBool/validatedInt/validatedIntWithLegacySentinel/...). */
function fieldsFromConfigToml(src: string): Set<string> {
  return new Set([...src.matchAll(/\bhi\.([a-z_0-9]+) = validated[A-Za-z]*\(/g)].map(m => m[1]!))
}

/** Fields assigned from the environment via any `env*` helper. */
function fieldsFromEnv(src: string): Set<string> {
  return new Set([...src.matchAll(/\bhi\.([a-z_0-9]+) = env[A-Za-z]*\(/g)].map(m => m[1]!))
}

describe('hints env-override coverage', () => {
  it('finds both sides in config.ts (self-check: a rename that breaks these patterns must fail loudly, not silently pass with two empty sets)', () => {
    const src = readConfigSrc()
    expect(fieldsFromConfigToml(src).size).toBeGreaterThan(20)
    expect(fieldsFromEnv(src).size).toBeGreaterThan(20)
  })

  it('every scalar hints field settable from config.toml is also settable from the environment', () => {
    const src = readConfigSrc()
    const missing = [...fieldsFromConfigToml(src)].filter(f => !fieldsFromEnv(src).has(f) && !EXEMPT.has(f)).sort()
    expect(missing, `hints fields readable from config.toml but not from the environment: ${missing.join(', ')}. Add an env*() override in _buildConfig and register the var in CONFIG_KEY_ENV_OVERRIDES (which feeds allEnvKeys(), so cache invalidation and the persist-strip follow automatically). If the field genuinely cannot take one, add it to EXEMPT above with a reason.`).toEqual([])
  })

  it('every exempt field still exists and is still config.toml-settable, so a stale exemption cannot silently mask a later regression', () => {
    const configTomlFields = fieldsFromConfigToml(readConfigSrc())
    for (const [field, reason] of EXEMPT) {
      expect(configTomlFields.has(field), `EXEMPT lists '${field}' (${reason}) but no 'hi.${field} = validated*(' assignment exists any more -- drop the stale exemption`).toBe(true)
    }
  })

  it('every env var registered for a hints key is actually consulted in _buildConfig', () => {
    const src = readConfigSrc()
    const registered = [...src.matchAll(/'hints\.([a-z_0-9]+)': \[([^\]]+)\]/g)]
    expect(registered.length).toBeGreaterThan(20)
    const dead = registered
      .filter(m => !new RegExp(`\\bhi\\.${m[1]!} = env[A-Za-z]*\\(`).test(src))
      .map(m => `hints.${m[1]!}`)
      .sort()
    expect(dead, `CONFIG_KEY_ENV_OVERRIDES registers these hints keys but nothing reads their env var in _buildConfig, so setting it does nothing: ${dead.join(', ')}`).toEqual([])
  })
})
