/** Single source of truth for the package's own manifest fields: its version, its npm name and where issues go. At build time esbuild replaces `__TG_MANIFEST__` with those fields read from package.json (scripts/build-options.mjs `buildDefines`), so a bundled process never opens the file; reading it cost 2.2ms of every CLI start and of every hook call a resident server answers. When the define is absent, running source under tsx/vitest, the fields are read from package.json at runtime. */

import { createRequire } from 'node:module'

interface Manifest {
  version?: string
  name?: string
  bugs?: { url?: string }
}

// Injected by esbuild's `define` as the manifest's JSON text: a string define inlines as a literal, where an object one becomes a module esbuild initializes from every lazily loaded module in the bundle. Declared so tsc accepts the reference; at runtime under tsx/vitest it is undefined and we fall back below.
declare const __TG_MANIFEST__: string | undefined

/** Fail-soft: a bundle built without the define, or source run from somewhere with no manifest beside it, must not take down whatever imported this module. Every field has a literal fallback below, and the test that pins each one runs from source, where the manifest is found, so a fallback cannot drift unnoticed. */
function readManifest(): Manifest {
  if (typeof __TG_MANIFEST__ === 'string') return JSON.parse(__TG_MANIFEST__) as Manifest
  try {
    return createRequire(import.meta.url)('../package.json') as Manifest
  } catch {
    return {}
  }
}

const manifest = readManifest()

export const VERSION: string = manifest.version ?? '0.0.0'

/** The published npm package name, for any message telling a user how to install this tool. Read from the manifest rather than written as a literal: `doctor`'s broken-install message once hardcoded `token-goat-ts`, which is not this package and is an unregistered npm name anyone could claim, printed exactly when a user's install is broken and asking for a global install. */
export const PACKAGE_NAME: string = manifest.name !== undefined && manifest.name !== '' ? manifest.name : 'token-goat'

/** Where users file an issue, read from the manifest's `bugs.url`. */
export const ISSUES_URL: string = manifest.bugs?.url !== undefined && manifest.bugs.url !== '' ? manifest.bugs.url : 'https://github.com/DFKHelper/token-goat/issues'

/** The contact address README.md publishes for requests that should not go through a public issue. */
export const SUPPORT_EMAIL = 'token-goat@dfkhelper.com'

/** One line inviting a request for support of a file type token-goat cannot extract symbols from. */
export function supportRequestLine(what: string): string {
  return `To ask for ${what} support, open an issue at ${ISSUES_URL} or email ${SUPPORT_EMAIL}.`
}
