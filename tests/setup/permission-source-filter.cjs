/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- a CommonJS preload loaded by node --require, so it uses require, process and module */
// Confines which permission sources src/rewrite_permission.ts reads to those under the test run root; isolate-home.ts calls install() in the test process and preloads this file (through NODE_OPTIONS) into every node process a test spawns, so both sides share this one predicate. Inert unless TG_TEST_PERMISSION_ROOT is set, and it only sets the one globalThis hook.
'use strict'
const path = require('node:path')

const HOOK = Symbol.for('token-goat.permission-source-filter')

function install(root) {
  const base = path.resolve(root)
  globalThis[HOOK] = (source) => {
    // A registry key is machine-wide, never a fixture; path.resolve would turn it into a path under the cwd, which is inside the run root for a spawned hook.
    if (String(source).startsWith('registry:')) return false
    const rel = path.relative(base, path.resolve(String(source)))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
}

if (process.env.TG_TEST_PERMISSION_ROOT) install(process.env.TG_TEST_PERMISSION_ROOT)

module.exports = { install }
