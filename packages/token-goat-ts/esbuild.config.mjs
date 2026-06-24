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
  external: ['better-sqlite3', 'sqlite-vec', 'tree-sitter', /^tree-sitter-.*/],
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    'import.meta.env': '{}',
    __TG_VERSION__: JSON.stringify(pkg.version),
  },
})

console.log(`Built dist/token-goat.mjs  (v${pkg.version})`)
