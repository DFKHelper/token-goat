import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/token-goat.mjs',
  // native addons cannot be bundled
  external: ['better-sqlite3', 'sqlite-vec', 'tree-sitter', 'tree-sitter-*'],
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
  target: 'node18',
  format: 'esm',
  outfile: 'dist/token-goat-hook.mjs',
  external: ['better-sqlite3', 'sqlite-vec', 'tree-sitter', 'tree-sitter-*'],
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
