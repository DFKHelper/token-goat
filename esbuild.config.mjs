import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

import { sweepStaleChunks } from './scripts/sweep-chunks.mjs'

// Both entry points share this prefix because they share the chunks themselves -- see the single
// build below.
const CHUNK_PREFIX = 'token-goat-chunk-'
// The hook entry used to be built separately and owned its own prefix, so dist/ carried a second,
// byte-for-byte copy of every shared chunk. Nothing emits these any more; sweeping them with an
// empty keep-list clears whatever an older build left behind in a working dist/.
const LEGACY_HOOK_CHUNK_PREFIX = 'token-goat-hook-chunk-'


const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

// See the build's own external comment below for why these must stay external rather than bundled.
const EXTERNAL_NATIVE_DEPS = [
  'better-sqlite3',
  'sqlite-vec',
  'tree-sitter',
  'tree-sitter-*',
  'sharp',
  'puppeteer-core',
  'pdfjs-dist',
  'pdfjs-dist/*',
  'fflate',
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

// One build, two entry points, and the reason they are one build rather than two:
//
// `token-goat.core` is the CLI. dist/token-goat.mjs (the launcher written at the bottom of this
// file) imports it by name, so every command pays for whatever it loads at startup.
//
// `token-goat-hook` is a separate library entry for in-process hook invocation: bridges that
// either already run inside a long-lived Node host (OpenClaw, opencode, pi) or spawn their own
// shim process (Codex, Claude Code, Copilot CLI) `import()` this sibling file directly, instead of
// `spawnSync`-ing a second `token-goat hook <event>` process on top of dist/token-goat.mjs. It
// must stay a plain library with zero load-time side effects, unlike dist/token-goat.mjs (whose
// banner-less src/main.ts entry calls `run()` at import time to parse `process.argv` as CLI args)
// -- see src/hook_lib.ts. Splitting preserves that: src/main.ts is reachable from the core entry
// only, so its top-level `run()` stays inside token-goat.core.mjs and never lands in a shared
// chunk. tests/guards/dist_chunks_deduped.test.ts imports the built hook entry to prove it.
//
// These were two separate esbuild.build() calls with disjoint chunk prefixes, which meant every
// module both entries reach -- almost all of them -- was emitted twice, once per prefix. dist/ was
// 6.75 MB across 31 files, of which 3.37 MB was a verbatim second copy, and the whole of it
// ships, because package.json's `files` takes the directory. esbuild's code splitting shares
// chunks across the entry points of a *single* build, so declaring both here is what deduplicates
// them: dist/ 6.75 MB -> 3.37 MB over 18 files, and the published tarball 1.60 MB -> 0.84 MB
// packed. Both eager sets came through the merge unchanged (core 1.890 MB, hook 1.837 MB).
// entryNames is '[name]', which resolves to the keys below, so both entry filenames are
// unchanged; outExtension keeps them `.mjs`.
//
// splitting:true is load-bearing for both entries independently. V8 compiles a module in full
// before running any of it, so code sitting behind a dynamic import is still parsed on every
// single invocation when esbuild inlines it into one file -- only its *execution* is deferred.
// Splitting moves it into sibling chunks that are read only if that import actually fires. For the
// CLI that took the eagerly loaded set from 3.61 MB to 2.83 MB (measured on the built launcher
// with the compile cache warm, over 15 interleaved A/B pairs of `symbol`: 149 ms -> 139 ms, the
// split build faster in 13 of the 15 pairs). For the hook -- which a bridge `import()`s on nearly
// every tool call -- it took the eagerly parsed set from 3.61 MB to 2.27 MB and import+eval from
// ~57 ms to ~39 ms. Sharing the chunks does not undo either: a module the core reaches statically
// and the hook only dynamically still lands behind the hook's dynamic edge, and
// tests/guards/core_bundle_stays_split.test.ts and dist_chunks_deduped.test.ts pin both eager sets.
const result = await esbuild.build({
  metafile: true,
  entryPoints: {
    'token-goat.core': 'src/main.ts',
    'token-goat-hook': 'src/hook_lib.ts',
  },
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  entryNames: '[name]',
  chunkNames: `${CHUNK_PREFIX}[hash]`,
  outExtension: { '.js': '.mjs' },
  // Native addons cannot be bundled, and every package here is declared
  // optionalDependencies in package.json — bundling one anyway (as sharp,
  // puppeteer-core, pdfjs-dist and fflate previously were, via their `await import(...)`
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
    // is the file package.json's `bin` points at, not on these bundles.
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

sweepStaleChunks('dist', CHUNK_PREFIX, Object.keys(result.metafile.outputs))
sweepStaleChunks('dist', LEGACY_HOOK_CHUNK_PREFIX, [])

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
