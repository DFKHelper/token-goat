/** The `typescript` compiler API behind ts_refs.ts (the type-resolved `refs` tier) and dep_docs.ts (the `.d.ts` outline), required on first use. It is null, never a throw, when the package is missing or fails to load. It is an optional dependency kept out of dist/token-goat.mjs (scripts/build-options.mjs), so it resolves next to the bundle at run time, and a synchronous require because both callers are synchronous. */

import { createRequire } from 'node:module'
import type TsModule from 'typescript'
import { registerReset } from './reset.js'

const _require = createRequire(import.meta.url)

let _ts: typeof TsModule | null = null
let _tsError: Error | null = null
let _tsLoadAttempted = false
// `undefined` = no override (use the real module); `null` or a module = forced value. Lets tests exercise the "typescript is unavailable" fallback path deterministically without needing to actually uninstall the package.
let _tsOverride: typeof TsModule | null | undefined = undefined

/** The `typescript` module, or null when it cannot be loaded. The require is attempted once per process, and a failure is kept for {@link loadError} rather than retried. */
export function loadTs(): typeof TsModule | null {
  if (_tsOverride !== undefined) return _tsOverride
  if (!_tsLoadAttempted) {
    _tsLoadAttempted = true
    try {
      _ts = _require('typescript') as typeof TsModule
    } catch (e) {
      _tsError = e instanceof Error ? e : new Error(String(e))
    }
  }
  return _ts
}

/** True when the `typescript` compiler API is loadable (installed and requires cleanly). */
export function isAvailable(): boolean {
  return loadTs() !== null
}

/** Last load error, for diagnostics (`token-goat doctor` style callers). Null when never attempted or loaded successfully. */
export function loadError(): Error | null {
  return _tsError
}

/** Test-only: force {@link loadTs} to return `mod` (or `null` to simulate "not installed") instead of the real lazily-`require`d module. Pass `undefined` to clear the override. */
export function setTsModuleForTesting(mod: typeof TsModule | null | undefined): void {
  _tsOverride = mod
}

registerReset(() => {
  _tsOverride = undefined
})
