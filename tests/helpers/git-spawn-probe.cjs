/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- a CommonJS preload loaded by node --require, so it uses require, process and module */
// Preload for a spawned token-goat bundle: appends one JSON line per git spawn, from spawnSync (runGit) and from spawn (runGitAsync), with the arguments after the fixed -c options, to GIT_SPAWN_PROBE_OUT (and the directory each ran in, one line per spawn, to GIT_SPAWN_PROBE_CWD_OUT when set), and when GIT_SPAWN_PROBE_FAIL_CATFILE is set makes every `git cat-file` exit 129 so a caller's fallback path runs.
'use strict'
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const out = process.env.GIT_SPAWN_PROBE_OUT
const cwdOut = process.env.GIT_SPAWN_PROBE_CWD_OUT
const failCatFile = process.env.GIT_SPAWN_PROBE_FAIL_CATFILE === '1'
const realSpawnSync = cp.spawnSync
const realSpawn = cp.spawn

/** The git subcommand and its arguments when `cmd` is git, recorded to the probe file; null for any other program. A git is recognised by its file name, since both runners start the real one by its full path on Windows. */
function recordGit(cmd, args, options) {
  if (path.basename(String(cmd)).toLowerCase().replace(/[.]exe$/, '') !== 'git' || !Array.isArray(args)) return null
  const sub = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c' || a === '--no-optional-locks'))
  if (out) fs.appendFileSync(out, JSON.stringify(sub) + String.fromCharCode(10))
  // The directory git runs in: the cwd option when one is passed, else the process cwd, so a spawn that dropped its cwd is recorded as the process cwd. One line per spawn, in step with the file above.
  if (cwdOut) fs.appendFileSync(cwdOut, (options && options.cwd !== undefined ? String(options.cwd) : process.cwd()) + String.fromCharCode(10))
  return sub
}

cp.spawnSync = function (cmd, args, ...rest) {
  const sub = recordGit(cmd, args, rest[0])
  if (failCatFile && sub !== null && sub[0] === 'cat-file') {
    return { status: 129, signal: null, pid: 0, output: [null, '', 'injected failure'], stdout: '', stderr: 'injected failure' }
  }
  return realSpawnSync.call(this, cmd, args, ...rest)
}

cp.spawn = function (cmd, args, ...rest) {
  const sub = recordGit(cmd, args, rest[0])
  if (failCatFile && sub !== null && sub[0] === 'cat-file') {
    return realSpawn.call(this, process.execPath, ['-e', "process.stderr.write('injected failure'); process.exit(129)"], ...rest)
  }
  return realSpawn.call(this, cmd, args, ...rest)
}
require('node:module').syncBuiltinESMExports()
