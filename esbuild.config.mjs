import * as esbuild from 'esbuild'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'

// Shared by the hook build's chunkNames and its own stale-chunk sweep below.
const HOOK_CHUNK_PREFIX = 'token-goat-hook-chunk-'
// Same, for the core build. A distinct prefix keeps the two builds' sweeps from deleting each
// other's chunks, since both write into dist/.
const CORE_CHUNK_PREFIX = 'token-goat-chunk-'

/** Remove last build's hashed chunks: their names change with their contents, so stale ones would otherwise pile up in dist/ and ship inside the tarball (package.json's `files` is the whole directory). */
function sweepStaleChunks(prefix) {
  // The core sweep now runs before anything has created dist/, so a clean checkout has no
  // directory to read yet. Nothing to sweep is not an error.
  if (!existsSync('dist')) return
  for (const stale of readdirSync('dist').filter((f) => f.startsWith(prefix))) {
    rmSync(`dist/${stale}`)
  }
}

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

// Shared by both builds below -- see the first build's own external comment for why these must
// stay external rather than bundled.
const EXTERNAL_NATIVE_DEPS = [
  'better-sqlite3',
  'sqlite-vec',
  'tree-sitter',
  'tree-sitter-*',
  'sharp',
  'puppeteer-core',
  'pdfjs-dist',
  'pdfjs-dist/*',
  'exceljs',
  'fflate',
  'fast-xml-parser',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  '@xenova/transformers',
  // Not a native addon either, but tesseract.js's Node entrypoint resolves its worker
  // script and tesseract.js-core's WASM binary via on-disk paths relative to its own
  // package directory at runtime -- bundling it into token-goat.mjs would break those
  // relative lookups, and per the comment above would also defeat graceful degradation
  // on installs that skip optional deps (see image_ocr.ts's loadTesseract).
  'tesseract.js',
  // Not a native addon, but the same "optionalDependencies entry must not get statically
  // inlined" reasoning applies: the full TypeScript compiler (ts_refs.ts's lazily-`require`d
  // type-resolved `refs` tier) is multiple MB of pure JS. Bundling it would both bloat
  // dist/token-goat.mjs for every install and, per the comment above, defeat graceful
  // degradation on installs that skip optional deps.
  'typescript',
]

sweepStaleChunks(CORE_CHUNK_PREFIX)

// splitting:true, for the same reason the hook build below uses it: V8 compiles a module in full
// before running any of it, so code sitting behind a dynamic import is still parsed on every
// single invocation when esbuild inlines it into one file -- only its *execution* is deferred.
// Splitting moves it into sibling chunks that are read only if that import actually fires, taking
// the eagerly loaded set from 3.61 MB to 2.83 MB. Measured on the built launcher with the compile
// cache warm, over 15 interleaved A/B pairs of `symbol`: 149 ms -> 139 ms, the split build faster
// in 13 of the 15 pairs. entryNames pins the entry's filename, which the launcher written at the
// bottom of this file imports by name; outExtension keeps it `.mjs`.
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  entryNames: 'token-goat.core',
  chunkNames: `${CORE_CHUNK_PREFIX}[hash]`,
  outExtension: { '.js': '.mjs' },
  // Native addons cannot be bundled, and every package here is declared
  // optionalDependencies in package.json — bundling one anyway (as sharp,
  // puppeteer-core, pdfjs-dist, exceljs, fflate, fast-xml-parser, and
  // @modelcontextprotocol/sdk previously were, via their `await import(...)`
  // call sites) defeats "optional": esbuild statically resolves and inlines
  // even a dynamic `import('literal')`, so the feature only worked at runtime
  // because a matching platform package happened to be present in
  // node_modules, not because the graceful-degradation fallback ever ran.
  external: EXTERNAL_NATIVE_DEPS,
  banner: {
    // The require polyfill makes esbuild's CJS-interop stub (__require2) work
    // on Node.js 24 ESM: the stub checks `typeof require !== "undefined"` and
    // delegates to this createRequire-backed implementation when found.
    // The shebang lives on the dist/token-goat.mjs launcher written below, which
    // is the file package.json's `bin` points at, not on this core bundle.
    js: [
      "import { createRequire as __cjsRequire } from 'node:module';",
      'const require = __cjsRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    'import.meta.env': '{}',
    __TG_VERSION__: JSON.stringify(pkg.version),
  },
})

sweepStaleChunks(HOOK_CHUNK_PREFIX)

// Separate library bundle for in-process hook invocation: bridges that either
// already run inside a long-lived Node host (OpenClaw, opencode, pi) or spawn
// their own shim process (Codex, Claude Code, Copilot CLI) `import()` this
// sibling file directly, instead of `spawnSync`-ing a second
// `token-goat hook <event>` process on top of dist/token-goat.mjs. It must
// stay a plain library with zero load-time side effects, unlike
// dist/token-goat.mjs (whose banner-less src/main.ts entry calls `run()` at
// import time to parse `process.argv` as CLI args) -- see src/hook_lib.ts.
//
// splitting:true, not a single outfile. A hook `import()`s this bundle on nearly every tool call,
// and V8 parses every byte of it -- including code the hook never runs. The CLI surface reached
// through skill_version_drift.ts's drift check, the MCP server and zod all sit behind dynamic
// imports already, but without splitting esbuild inlines them into this one file, so their bytes
// are parsed on every hook anyway and only their *execution* is deferred. Splitting moves them
// into sibling chunks that are read only if that dynamic import actually fires, taking the
// eagerly parsed set from 3.61 MB to 2.27 MB and import+eval from ~57 ms to ~39 ms, measured with
// the compile cache warm. entryNames pins the entry's filename, which the bridges, the installed
// hook shim and the README all reference by name; outExtension keeps it `.mjs`.
await esbuild.build({
  entryPoints: ['src/hook_lib.ts'],
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  entryNames: 'token-goat-hook',
  chunkNames: `${HOOK_CHUNK_PREFIX}[hash]`,
  outExtension: { '.js': '.mjs' },
  external: EXTERNAL_NATIVE_DEPS,
  banner: {
    js: [
      "import { createRequire as __cjsRequire } from 'node:module';",
      'const require = __cjsRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    'import.meta.env': '{}',
    __TG_VERSION__: JSON.stringify(pkg.version),
  },
})

// The `bin` entry point is a launcher, not the bundle itself, purely so that
// module.enableCompileCache() can run BEFORE the ~3.5MB core bundle is compiled.
// V8 compiles a module in full before executing any of it, so the same call
// placed in the core bundle's own banner runs too late to cache that bundle --
// measured as no change at all, versus ~22ms (about 17% of a bare invocation)
// when it precedes the import from here. Every CLI call and every spawned hook
// pays that compile, so the launcher stays tiny: anything added to it is
// compiled uncached on every single run.
const LAUNCHER = [
  '#!/usr/bin/env node',
  '// Namespace import, not a named one: enableCompileCache landed in Node 22.1 and package.json still supports 22.0, where importing it by name is a link-time failure the try/catch below never gets to run against.',
  "import * as nodeModule from 'node:module'",
  '// Older Node has no compile cache, and a read-only or full cache dir throws; neither is a reason to fail the command.',
  'try {',
  '  nodeModule.enableCompileCache?.()',
  '} catch {}',
  '// Deliberately not awaited: a top-level await here makes this file an async ESM graph, and this file is the package main, so require("token-goat") would fail with ERR_REQUIRE_ASYNC_MODULE.',
  "import('./token-goat.core.mjs').catch((err) => {",
  '  console.error(err)',
  '  process.exitCode = 1',
  '})',
  '',
].join('\n')
writeFileSync('dist/token-goat.mjs', LAUNCHER)

console.log(`Built dist/token-goat.mjs  (v${pkg.version})`)
