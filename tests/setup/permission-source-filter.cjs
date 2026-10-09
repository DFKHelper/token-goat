/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- a CommonJS preload loaded by node --require, so it uses require, process and module */
// Confines which permission sources src/rewrite_permission.ts reads to those under the test run root; isolate-home.ts calls install() in the test process and preloads this file (through NODE_OPTIONS) into every node process a test spawns, so both sides share this one predicate. Inert unless TG_TEST_PERMISSION_ROOT is set, and it only sets the one globalThis hook.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const HOOK = Symbol.for('token-goat.permission-source-filter')

// The path resolved through every link and 8.3 name, spelled through its nearest existing ancestor when it does not exist yet: git records a linked worktree's main checkout by real path and the run root is spelled as the OS gave it (macOS /var against /private/var, Windows RUNNER~1 against runneradmin), so only the real spelling compares the same.
function canonical(p) {
  const rest = []
  let cur = path.resolve(p)
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

function install(root) {
  const base = canonical(root)
  globalThis[HOOK] = (source) => {
    // A registry key is machine-wide, never a fixture; path.resolve would turn it into a path under the cwd, which is inside the run root for a spawned hook.
    if (String(source).startsWith('registry:')) return false
    const rel = path.relative(base, canonical(String(source)))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
}

if (process.env.TG_TEST_PERMISSION_ROOT) install(process.env.TG_TEST_PERMISSION_ROOT)

module.exports = { install }
