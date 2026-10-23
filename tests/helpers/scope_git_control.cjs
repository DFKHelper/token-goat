/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- a CommonJS preload loaded by node --require, so it uses require, process and module */
// Preload for a spawned token-goat bundle that takes wall-clock speed out of a directory-scoped inline Grep answer. The answer's git calls share a 5000 ms deadline (SCOPE_GIT_TIMEOUT_MS in src/inline_grep_scan.ts) and read a call that misses it as unknown; a row that expects an answer cannot depend on how loaded the machine is, and a row that expects the pass-through must not need git to be slow. TG_SCOPE_GIT picks the mode: `finishes` freezes Date.now (the shared deadline never passes) and drops the per-call spawn timeout of every git call, so git always finishes; `unfinished` makes `check-ignore` and `ls-files` come back as a spawnSync timeout (error ETIMEDOUT, signal SIGTERM) without running git, which is how Node reports a git that missed its bound.
'use strict'
const cp = require('node:child_process')
const path = require('node:path')

const mode = process.env.TG_SCOPE_GIT
const realSpawnSync = cp.spawnSync

function isGit(cmd) {
  return path.basename(String(cmd)).toLowerCase().replace(/[.]exe$/, '') === 'git'
}

if (mode === 'finishes') {
  const frozen = Date.now()
  Date.now = () => frozen
  cp.spawnSync = function (cmd, args, options, ...rest) {
    if (isGit(cmd) && options && typeof options === 'object') {
      const unbounded = { ...options }
      delete unbounded.timeout
      return realSpawnSync.call(this, cmd, args, unbounded, ...rest)
    }
    return realSpawnSync.call(this, cmd, args, options, ...rest)
  }
} else if (mode === 'unfinished') {
  cp.spawnSync = function (cmd, args, ...rest) {
    if (isGit(cmd) && Array.isArray(args) && (args.includes('check-ignore') || args.includes('ls-files'))) {
      const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -4039, syscall: 'spawnSync git' })
      return { status: null, signal: 'SIGTERM', pid: 0, output: null, stdout: '', stderr: '', error }
    }
    return realSpawnSync.call(this, cmd, args, ...rest)
  }
} else {
  throw new Error('scope_git_control.cjs needs TG_SCOPE_GIT=finishes or unfinished, got ' + String(mode))
}
require('node:module').syncBuiltinESMExports()
