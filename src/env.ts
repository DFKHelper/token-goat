/**
 * Environment-variable parsers with safe fallbacks.
 *
 * Ports the env_float / env_int contract from `util.py`: read a variable,
 * strip whitespace, parse, and return the supplied default on anything that is
 * absent, empty, or malformed. No imports from other local modules.
 */

/** Canonical falsy env-var values (matches util.py FALSY_ENV_VALUES). */
export const FALSY_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off'])

/** Canonical truthy env-var values (matches util.py TRUTHY_ENV_VALUES). */
export const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on'])

/**
 * Read a string env var, returning `defaultVal` when unset or empty (after trim).
 */
export function envStr(key: string, defaultVal: string): string {
  const raw = process.env[key]
  if (raw === undefined) return defaultVal
  const trimmed = raw.trim()
  return trimmed === '' ? defaultVal : trimmed
}

/**
 * Read a boolean env var.
 *
 * Recognizes the canonical truthy/falsy spellings case-insensitively. Any
 * value outside those sets (including unset/empty) yields `defaultVal`.
 */
export function envBool(key: string, defaultVal: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined) return defaultVal
  const norm = raw.trim().toLowerCase()
  if (norm === '') return defaultVal
  if (TRUTHY_ENV_VALUES.has(norm)) return true
  if (FALSY_ENV_VALUES.has(norm)) return false
  return defaultVal
}

/**
 * Read an integer env var, falling back to `defaultVal` on any parse failure.
 *
 * Uses a strict `^[+-]?\d+$` regex so floats (`1.5`) and scientific notation
 * (`1e3`) are rejected rather than silently truncated by `parseInt`.
 *
 * When `min`/`max` are supplied, the parsed value is clamped into that range —
 * matching `validatedInt`'s file-value clamp — so an out-of-range env var
 * (e.g. `TOKEN_GOAT_MCP_DEDUP_TTL_SECS=99999999`) can't bypass the bounds the
 * file value is already validated against.
 */
export function envInt(key: string, defaultVal: number, min?: number, max?: number): number {
  const raw = process.env[key]
  if (raw === undefined) return defaultVal
  const norm = raw.trim()
  if (norm === '') return defaultVal
  if (!/^[+-]?\d+$/.test(norm)) return defaultVal
  const val = parseInt(norm, 10)
  if (!Number.isFinite(val)) return defaultVal
  let clamped = val
  if (min !== undefined) clamped = Math.max(min, clamped)
  if (max !== undefined) clamped = Math.min(max, clamped)
  return clamped
}
