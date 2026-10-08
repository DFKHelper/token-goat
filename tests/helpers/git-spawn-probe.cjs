/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- a CommonJS preload loaded by node --require, so it uses require, process and module */
// Preload for a spawned token-goat bundle: appends one JSON line per git spawn (arguments after the fixed -c options) to GIT_SPAWN_PROBE_OUT, and when GIT_SPAWN_PROBE_FAIL_CATFILE is set makes every `git cat-file` exit 129 so a caller's fallback path runs.
'use strict'
const cp = require('node:child_process')
const fs = require('node:fs')

const out = process.env.GIT_SPAWN_PROBE_OUT
const failCatFile = process.env.GIT_SPAWN_PROBE_FAIL_CATFILE === '1'
const realSpawnSync = cp.spawnSync

cp.spawnSync = function (cmd, args, ...rest) {
  if (String(cmd) === 'git' && Array.isArray(args)) {
    const sub = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c' || a === '--no-optional-locks'))
    if (out) fs.appendFileSync(out, JSON.stringify(sub) + String.fromCharCode(10))
    if (failCatFile && sub[0] === 'cat-file') {
      return { status: 129, signal: null, pid: 0, output: [null, '', 'injected failure'], stdout: '', stderr: 'injected failure' }
    }
  }
  return realSpawnSync.call(this, cmd, args, ...rest)
}
require('node:module').syncBuiltinESMExports()
