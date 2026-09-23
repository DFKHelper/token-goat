import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** The npm supply-chain attacks worth defending against here no longer run at install time. The install-script hooks that `preinstall`/`postinstall` blocking was built for are the previous generation; the current one ships a package that installs cleanly, passes a static scan, and puts its payload inside a method the host application is guaranteed to call during normal operation. Nothing about the install is anomalous, so nothing at install time can catch it. What that class still requires is a package in the tree. It cannot execute in a user's process unless its name appears in our lockfile, so the control that actually bites is refusing to let the set of names change without someone deciding it should. That is what this guard does: a transitive dependency arriving through a routine version bump becomes a build failure naming the package, rather than code that silently starts running in every install. The strongest fact here is how small the required surface is. Exactly one package -- `jsonc-parser` -- is guaranteed to load in a user's process; it is bundled into `dist/token-goat.mjs` at build time. Every other production package is `optional` and lazily resolved, so it only ever executes if the feature that needs it is actually used, on an install that actually has it. Keeping that number at one is worth more than any scanner. Provenance: CAPTURE. Both lists were read out of the real `package-lock.json` resolved by `npm install` in this repository, not transcribed from `package.json` or from any producer's own source. The guard recomputes them from that same file on every run, so it compares the tree as resolved against the tree as reviewed. This is deliberately not a `ignore-scripts=true` recommendation. All 18 install-script packages in this tree are native builds we require (tree-sitter grammars, sqlite-vec, esbuild, better-sqlite3); disabling scripts would break the build while doing nothing about the runtime-trigger class this guard exists for. */

const lockPath = fileURLToPath(new URL('../../package-lock.json', import.meta.url))

interface LockEntry {
  readonly dev?: boolean
  readonly devOptional?: boolean
  readonly optional?: boolean
  readonly version?: string
}

interface Lock {
  readonly packages?: Record<string, LockEntry & { readonly dependencies?: Record<string, string>; readonly optionalDependencies?: Record<string, string> }>
}

const marker = 'node_modules/'

/** The package a lockfile key names, unnested: `node_modules/a/node_modules/b` is `b`. */
function nameOf(lockPath: string): string {
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length)
}

/** Package names in the production tree, deduplicated -- the same package nested under two parents is one name. Two producers decide this, not one. The lockfile's `dev`/`optional` flags are the obvious source, but npm collapses a package declared in BOTH `optionalDependencies` and `devDependencies` down to a bare `dev: true`, which reads as "never reaches a user" for a package a consumer's `npm install` really does fetch. The manifest's own declarations are the second producer and they win: a name the root block declares is production whatever the flags say. */
function productionPackageNames(opts: { readonly optionalOnly?: boolean; readonly requiredOnly?: boolean } = {}): string[] {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock
  const root = lock.packages?.[''] ?? {}
  const declaredRequired = new Set(Object.keys(root.dependencies ?? {}))
  const declaredOptional = new Set(Object.keys(root.optionalDependencies ?? {}))
  const names = new Set<string>()
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // The root package is keyed by the empty string.
    if (path === '') continue
    const name = nameOf(path)
    const declared = declaredRequired.has(name) || declaredOptional.has(name)
    if (!declared && (entry.dev === true || entry.devOptional === true)) continue
    const optional = declaredOptional.has(name) || (!declaredRequired.has(name) && entry.optional === true)
    if (opts.optionalOnly === true && !optional) continue
    if (opts.requiredOnly === true && optional) continue
    names.add(name)
  }
  return [...names].sort()
}

/** Names the manifest's own root block declares as production, read straight from the lockfile's copy of it. */
function declaredProductionNames(): string[] {
  const root = (JSON.parse(readFileSync(lockPath, 'utf8')) as Lock).packages?.[''] ?? {}
  return [...new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})])].sort()
}

/** Every package that may execute in a user's process, as resolved today. Adding a name here is the review. Before doing it, answer why this package is now in the runtime tree, what pulled it in, and whether the feature that needs it is worth the code it brings. Removing one needs no ceremony. */
const REVIEWED_PRODUCTION_PACKAGES: readonly string[] = [
  '@napi-rs/canvas',
  '@napi-rs/canvas-android-arm64',
  '@napi-rs/canvas-darwin-arm64',
  '@napi-rs/canvas-darwin-x64',
  '@napi-rs/canvas-linux-arm-gnueabihf',
  '@napi-rs/canvas-linux-arm64-gnu',
  '@napi-rs/canvas-linux-arm64-musl',
  '@napi-rs/canvas-linux-riscv64-gnu',
  '@napi-rs/canvas-linux-x64-gnu',
  '@napi-rs/canvas-linux-x64-musl',
  '@napi-rs/canvas-win32-arm64-msvc',
  '@napi-rs/canvas-win32-x64-msvc',
  '@puppeteer/browsers',
  'ansi-regex',
  'ansi-styles',
  'bmp-js',
  'chromium-bidi',
  'cliui',
  'devtools-protocol',
  'emoji-regex',
  'escalade',
  'fflate',
  'get-caller-file',
  'get-east-asian-width',
  'idb-keyval',
  'is-url',
  'jsonc-parser',
  'mitt',
  'modern-tar',
  'node-addon-api',
  'node-fetch',
  'node-gyp-build',
  // A donation prompt, pulled in by tesseract.js and run from its postinstall. Carried because tesseract.js requires it, not because anything here calls it.
  'opencollective-postinstall',
  'pdfjs-dist',
  'puppeteer-core',
  'regenerator-runtime',
  'sqlite-vec',
  'sqlite-vec-darwin-arm64',
  'sqlite-vec-darwin-x64',
  'sqlite-vec-linux-arm64',
  'sqlite-vec-linux-x64',
  'sqlite-vec-windows-x64',
  'string-width',
  'strip-ansi',
  'tesseract.js',
  'tesseract.js-core',
  'tr46',
  'tree-sitter',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-ruby',
  'tree-sitter-rust',
  'tree-sitter-typescript',
  'typed-query-selector',
  // Declared in optionalDependencies AND devDependencies, so the lockfile marks it plain `dev`. It is still a package a consumer's install can fetch, and the bundle resolves it by name.
  'typescript',
  'wasm-feature-detect',
  'webdriver-bidi-protocol',
  'webidl-conversions',
  'whatwg-url',
  'wrap-ansi',
  'ws',
  'y18n',
  'yargs',
  'yargs-parser',
  'zlibjs',
  'zod',
]

describe('the set of packages that can run in a user process', () => {
  it('contains nothing that has not been reviewed', () => {
    const resolved = productionPackageNames()
    // Non-vacuous: a lockfile that failed to parse, or a filter that excluded everything, would otherwise report an empty tree and agree with any expectation at all.
    expect(resolved.length, 'no production packages found -- the lockfile shape has changed').toBeGreaterThan(20)

    const added = resolved.filter((n) => !REVIEWED_PRODUCTION_PACKAGES.includes(n))
    expect(
      added,
      'these packages entered the production tree without review. A malicious package cannot run in a user process unless its name is here first, which is the point of the list: decide each one, then add it.',
    ).toEqual([])
  })

  it('sees every package the manifest itself declares as production', () => {
    // The regression this guard shipped with: the sweep read the lockfile's `dev`/`optional` flags and nothing else, so `typescript` -- declared in both optionalDependencies and devDependencies, and therefore flagged plain `dev` -- was absent from the very list that claims to name everything able to run in a user's process. Reading the manifest's declarations is the independent second opinion.
    const declared = declaredProductionNames()
    expect(declared.length, 'no production dependencies declared -- the root lockfile block has changed shape').toBeGreaterThan(5)

    const resolved = new Set(productionPackageNames())
    expect(
      declared.filter((n) => !resolved.has(n)),
      'the manifest declares these as production and the sweep does not see them, so the reviewed list below is not the full set',
    ).toEqual([])
  })

  it('does not keep names the tree no longer resolves', () => {
    const resolved = new Set(productionPackageNames())
    const stale = REVIEWED_PRODUCTION_PACKAGES.filter((n) => !resolved.has(n))
    expect(stale, 'reviewed names no longer in the tree; drop them so the list keeps meaning what it says').toEqual([])
  })

  it('keeps SECURITY.md truthful about that surface', () => {
    // A published security claim that drifts is worse than no claim: a reader has no way to tell it went stale, so it reads as current. This ties the sentence to the tree it describes.
    const security = readFileSync(fileURLToPath(new URL('../../SECURITY.md', import.meta.url)), 'utf8')
    expect(security, 'the runtime-surface section is gone').toContain('## What actually runs')
    expect(security, 'the one required package is named').toContain('`jsonc-parser`')
    expect(security, 'the guard backing the claim is named, so a reader can check it').toContain('runtime_dependency_set_is_locked')
  })

  it('keeps the always-loaded surface at exactly one package', () => {
    // Everything else is `optional`, so it executes only when its feature is used on an install that has it. This is the number that bounds the blast radius, and it should be argued over before it moves.
    expect(
      productionPackageNames({ requiredOnly: true }),
      'a package became non-optional, so its code now loads in every user process rather than only when a feature needs it',
    ).toEqual(['jsonc-parser'])
  })
})
