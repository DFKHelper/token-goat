/**
 * Single source of truth for the package version.
 *
 * At build time esbuild replaces `__TG_VERSION__` with the literal version
 * string read from package.json (see esbuild.config.mjs `define`). When the
 * define is absent — e.g. running source directly under tsx/vitest — the value
 * is read from package.json at runtime via `createRequire`.
 */

import { createRequire } from 'node:module'

// Injected by esbuild's `define`. Declared so tsc accepts the reference; at
// runtime under tsx/vitest it is undefined and we fall back below.
declare const __TG_VERSION__: string | undefined

function resolveVersion(): string {
  if (typeof __TG_VERSION__ === 'string') {
    return __TG_VERSION__
  }
  // Runtime fallback: resolve package.json relative to this module's URL.
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}

export const VERSION: string = resolveVersion()
