/** Git facts the hooks read inside the `hints.git_hint_max_ms` budget: the branch from the HEAD file with no spawn, and a dirty-state probe that says timed-out instead of clean. A slow machine cannot meet that budget with a spawn (a cold `git status` measured 61 ms at best against the 50 ms default), so a hint that waits on a spawn never arrives there; the branch needs no process, and a probe that is still killed is reported as unknown so no caller reads a killed git as an answer. */

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { GitResult } from './types.js'
import { runGit } from './util.js'

/** HEAD and a `.git` file are a line or two; a bounded read keeps a hostile oversized one from being slurped whole. */
const READ_BYTES = 1024

/** Branch names this module will print: letters, digits and the punctuation git allows in practice. Anything else (a space, a control character, or one of ~ ^ : ? * [ and a backslash) is left to git itself, which applies its own ref-name rules. */
const SAFE_BRANCH = /^[\p{L}\p{N}_./+@#%=,&()'!-]+$/u

function readPrefix(file: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(READ_BYTES)
    return buf.toString('utf8', 0, readSync(fd, buf, 0, READ_BYTES, 0))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The repository directory for `cwd`: the nearest ancestor's `.git` directory, or the directory a `.git` file (a linked worktree or submodule) points at, relative paths read from the folder holding that file. Null when there is none, or a `.git` file names nothing readable. An exported GIT_DIR names a repository independent of the directory, which this does not model, so it is unknown too. */
function repositoryDir(cwd: string): string | null {
  if (process.env['GIT_DIR'] !== undefined) return null
  let dir = resolve(cwd)
  // Git walks up from the physical directory, so a junction or symlink is followed first; an unreadable path keeps the unresolved spelling.
  try { dir = realpathSync.native(dir) } catch { /* keep the unresolved path */ }
  for (;;) {
    const marker = resolve(dir, '.git')
    let kind: 'dir' | 'file' | null = null
    try {
      const info = statSync(marker)
      kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
    } catch { /* no marker here */ }
    if (kind === 'dir') return marker
    if (kind === 'file') {
      const line = ((readPrefix(marker) ?? '').split(/\r?\n/, 1)[0] ?? '').trim()
      const target = line.startsWith('gitdir:') ? line.slice('gitdir:'.length).trim() : ''
      return target === '' ? null : resolve(dir, target)
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Whether `name` is a branch name safe to print: allowlisted characters, and none of the shapes git's ref-name rules forbid. */
function isPrintableBranch(name: string): boolean {
  return SAFE_BRANCH.test(name) && !name.includes('..') && !name.includes('@{') && !name.includes('//') && !/(^|\/)\./.test(name) && !/[./]$/.test(name) && !name.endsWith('.lock')
}

/** What `git rev-parse --abbrev-ref HEAD` prints, read from the HEAD file with no process: the branch name for `ref: refs/heads/<name>`, `HEAD` for a detached HEAD (a bare object id), as git does. Null when it cannot be told, never a guess: no repository, an unreadable or garbled HEAD, a ref outside `refs/heads/`, a name outside {@link isPrintableBranch}, or the reftable stub `refs/heads/.invalid` that a reftable repository keeps in HEAD (the real branch is in the table). The caller then asks git. An unborn branch reads as its name, where git exits 128. */
export function readBranchWithoutSpawn(cwd: string): string | null {
  const dir = repositoryDir(cwd)
  if (dir === null) return null
  const head = readPrefix(resolve(dir, 'HEAD'))
  if (head === null) return null
  const line = (head.split(/\r?\n/, 1)[0] ?? '').trim()
  const named = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(line)?.[1]
  if (named !== undefined) return isPrintableBranch(named) ? named : null
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line) ? 'HEAD' : null
}

/** What a git query that prints one line per finding answered: `clean` (ran, printed nothing), `dirty` (printed something), `timed-out` (killed at `timeoutMs`: unknown, neither of the others), or `refused` (git exited non-zero or never ran: not a repository, a missing git). */
export type GitFindings = 'clean' | 'dirty' | 'timed-out' | 'refused'

/** Run `git <args>` in `cwd` under `timeoutMs` and classify the answer as {@link GitFindings}. */
export function gitFindings(args: string[], cwd: string, timeoutMs: number): GitFindings {
  let result: GitResult
  try {
    result = runGit(args, { cwd, timeoutMs })
  } catch {
    // runGit reports failures in its result; a throw (a cwd that is not a string) is a git that never answered.
    return 'refused'
  }
  if (result.timedOut === true) return 'timed-out'
  if (result.exitCode !== 0) return 'refused'
  return result.stdout.trim() === '' ? 'clean' : 'dirty'
}
