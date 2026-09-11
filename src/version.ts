/**
 * Single source of truth for the package version.
 *
 * At build time esbuild replaces `__TG_VERSION__` with the literal version
 * string read from package.json (see esbuild.config.mjs `define`). When the
 * define is absent — e.g. running source directly under tsx/vitest — the value
 * is read from package.json at runtime via `createRequire`.
 */

import { createRequire } from 'node:module'

// Injected by esbuild's `define`. Declared so tsc accepts the reference; at runtime under tsx/vitest it is undefined and we fall back below.
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

/**
 * The published npm package name, for any message telling a user how to install this tool.
 *
 * Read from the manifest rather than written as a literal. `doctor`'s broken-install message
 * hardcoded `token-goat-ts`, which is not this package and is an unregistered npm name anyone
 * could claim -- an install instruction pointing at a package that does not exist yet, printed
 * exactly when a user's install is broken, and asking for a global install.
 */
function resolvePackageName(): string {
  // Fail-soft, unlike resolveVersion's bare require: this module gets bundled into the in-process hook chunk, which is written to a temp directory with no package.json beside it, so the require throws there and a throw at module load takes the whole hook down. The name is only ever used in an advisory install line, so a literal fallback costs nothing -- and the fallback cannot silently drift, because the test that pins this constant runs from source, where the manifest is found.
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { name?: string }
    if (typeof pkg.name === 'string' && pkg.name !== '') return pkg.name
  } catch {
    /* bundled somewhere with no manifest beside it */
  }
  return 'token-goat'
}

export const PACKAGE_NAME: string = resolvePackageName()

/** Where users file an issue, read from the manifest's `bugs.url`; fail-soft like resolvePackageName, for the same bundled-without-a-manifest reason. */
function resolveIssuesUrl(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { bugs?: { url?: string } }
    if (typeof pkg.bugs?.url === 'string' && pkg.bugs.url !== '') return pkg.bugs.url
  } catch {
    /* bundled somewhere with no manifest beside it */
  }
  return 'https://github.com/DFKHelper/token-goat/issues'
}

export const ISSUES_URL: string = resolveIssuesUrl()

/** The contact address README.md publishes for requests that should not go through a public issue. */
export const SUPPORT_EMAIL = 'token-goat@dfkhelper.com'

/** One line inviting a request for support of a file type token-goat cannot extract symbols from. */
export function supportRequestLine(what: string): string {
  return `To ask for ${what} support, open an issue at ${ISSUES_URL} or email ${SUPPORT_EMAIL}.`
}
