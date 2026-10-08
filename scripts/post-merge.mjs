#!/usr/bin/env node
/** `post-merge` / `post-rewrite` hook: automatically synchronize token-goat after git pull/merge/rebase. Automatically: 1. Checks if package-lock.json changed; if so, runs `npm install`. 2. Rebuilds the bundle (`npm run build`). 3. Stops resident hook-servers so fresh code is loaded on the next hook invocation. 4. Restarts the worker daemon. 5. Refreshes shims and instructions across Claude Code and Copilot CLI harnesses. 6. Triggers index update for any files needing re-parsing. In a linked worktree (`git worktree add`) it stops after step 2: steps 3-6 act on the user's real home, so running them from a scratch checkout would point every installed hook at that checkout's build and start a worker from it. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'
const nodeCmd = process.execPath
const bundlePath = path.join(projectRoot, 'dist', 'token-goat.mjs')

function runStep(label, cmd, args, options = {}) {
  process.stdout.write(`[token-goat post-merge] ${label}... `)
  const start = Date.now()
  let finalCmd = cmd
  let finalArgs = args
  if (isWin && cmd.endsWith('.cmd')) {
    finalCmd = 'cmd.exe'
    finalArgs = ['/d', '/s', '/c', cmd, ...args]
  }
  const res = spawnSync(finalCmd, finalArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    ...options,
  })
  const duration = Date.now() - start
  if (res.status === 0) {
    process.stdout.write(`done (${duration}ms)\n`)
    return true
  }
  process.stdout.write(`failed (${duration}ms)\n`)
  if (res.stderr) {
    process.stderr.write(`${res.stderr}\n`)
  }
  return false
}

function gitChangedFiles() {
  const diff = spawnSync('git', ['diff-tree', '-r', '--name-only', '--no-commit-id', 'ORIG_HEAD', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (diff.status === 0 && diff.stdout) {
    return diff.stdout.split(/\r?\n/).filter(Boolean)
  }
  return []
}

/** True when `cwd` is a linked worktree rather than the main checkout: a linked worktree's git dir is `.git/worktrees/<name>`, apart from the common dir every checkout of the repository shares. */
function isLinkedWorktree(cwd) {
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  })
  if (res.status !== 0 || !res.stdout) return false
  const [gitDir, commonDir] = res.stdout.split(/\r?\n/).filter(Boolean)
  return Boolean(gitDir && commonDir) && path.resolve(gitDir) !== path.resolve(commonDir)
}

/** Where `node_modules` really lives when it is a symlink or junction resolving outside this checkout (a linked worktree sharing the main checkout's install), else null. lstat sees the link itself and realpath follows it; Node reports a Windows junction as a symbolic link to lstat, which `tests/post_merge_lock_and_links.test.ts` pins. */
function externalNodeModules() {
  const modules = path.join(projectRoot, 'node_modules')
  try {
    if (!fs.lstatSync(modules).isSymbolicLink()) return null
    const target = fs.realpathSync(modules)
    const rel = path.relative(fs.realpathSync(projectRoot), target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? null : target
  } catch {
    return null
  }
}

/** `npm install` on npm 11.6.2 rewrites package-lock.json without its `libc` arrays, so the committed bytes (or the user's own uncommitted edit) are snapshotted before it and written back after it; not `git checkout`, which would discard an uncommitted edit. */
function installKeepingLock() {
  const lockPath = path.join(projectRoot, 'package-lock.json')
  const before = fs.readFileSync(lockPath)
  runStep('Updating dependencies (package-lock.json changed)', npmCmd, ['install', '--prefer-offline'])
  const after = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null
  if (after === null || !before.equals(after)) {
    fs.writeFileSync(lockPath, before)
    console.log('[token-goat post-merge] npm install rewrote package-lock.json; restored the bytes it had before the install.')
  }
}

function main() {
  const changed = gitChangedFiles()
  console.log('[token-goat post-merge] Synchronizing token-goat after git pull/merge...')

  // 1. Dependency update if lockfile changed
  if (changed.includes('package-lock.json')) {
    const shared = externalNodeModules()
    if (shared !== null) {
      console.log(`[token-goat post-merge] Skipping npm install: node_modules is a link to ${shared}, outside this checkout, and an install here would change it for every checkout sharing it.`)
    } else {
      installKeepingLock()
    }
  }

  // 2. Build dist/token-goat.mjs
  const built = runStep('Building token-goat bundle', npmCmd, ['run', 'build'])
  if (!built || !fs.existsSync(bundlePath)) {
    console.error('[token-goat post-merge] Build failed; aborting daemon and shim reload.')
    process.exit(1)
  }

  if (isLinkedWorktree(projectRoot)) {
    console.log(
      '[token-goat post-merge] Linked worktree: built the bundle only. The installed hooks, shims, worker and index belong to the main checkout, so run `npm run sync` there to move them to a new build.',
    )
    return
  }

  // 3. Stop resident hook servers (they will respawn with the new build on next hook call)
  runStep('Stopping resident hook servers', nodeCmd, [bundlePath, 'hook-server', 'stop'])

  // 4. Restart worker daemon
  runStep('Restarting worker daemon', nodeCmd, [bundlePath, 'worker', 'stop'])
  runStep('Starting worker daemon', nodeCmd, [bundlePath, 'worker', 'start'])

  // 5. Refresh shims and instructions across harnesses
  runStep('Refreshing Claude Code hooks & shims', nodeCmd, [bundlePath, 'install'])
  runStep('Refreshing Copilot CLI user hooks & shims', nodeCmd, [bundlePath, 'install', '--copilot'])
  runStep('Refreshing Copilot CLI project hooks & shims', nodeCmd, [bundlePath, 'install', '--copilot', '--local'])
  runStep('Running doctor repairs across configured harnesses', nodeCmd, [bundlePath, 'doctor', '--repair'])

  // 6. Prune and index
  runStep('Pruning stale index entries', nodeCmd, [bundlePath, 'project', 'prune'])
  runStep('Reindexing updated files', nodeCmd, [bundlePath, 'index'])

  console.log('[token-goat post-merge] ✔️ Synchronization complete. Token-goat is up to date.')
}

main()
