import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

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

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/token-goat.mjs',
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
    // The shebang lets the OS run this file directly.
    // The require polyfill makes esbuild's CJS-interop stub (__require2) work
    // on Node.js 24 ESM: the stub checks `typeof require !== "undefined"` and
    // delegates to this createRequire-backed implementation when found.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cjsRequire } from 'node:module';",
      'const require = __cjsRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    'import.meta.env': '{}',
    __TG_VERSION__: JSON.stringify(pkg.version),
  },
})

// Separate library bundle for in-process hook invocation: bridges that either
// already run inside a long-lived Node host (OpenClaw, opencode, pi) or spawn
// their own shim process (Codex, Claude Code, Copilot CLI) `import()` this
// sibling file directly, instead of `spawnSync`-ing a second
// `token-goat hook <event>` process on top of dist/token-goat.mjs. It must
// stay a plain library with zero load-time side effects, unlike
// dist/token-goat.mjs (whose banner-less src/main.ts entry calls `run()` at
// import time to parse `process.argv` as CLI args) -- see src/hook_lib.ts.
await esbuild.build({
  entryPoints: ['src/hook_lib.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/token-goat-hook.mjs',
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

console.log(`Built dist/token-goat.mjs  (v${pkg.version})`)
