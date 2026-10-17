/** Git facts the hooks read inside the `hints.git_hint_max_ms` budget: the branch from the HEAD file with no spawn, and a dirty-state probe that says timed-out instead of clean. A slow machine cannot meet that budget with a spawn (a cold `git status` measured 61 ms at best against the 50 ms default), so a hint that waits on a spawn never arrives there; the branch needs no process, and a probe that is still killed is reported as unknown so no caller reads a killed git as an answer. */

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { GitResult } from './types.js'
import { runGit } from './util.js'

/** HEAD and a `.git` file are a line or two; a bounded read keeps a hostile oversized one from being slurped whole. */
const READ_BYTES = 1024

/** Branch names this module will print: letters, digits and the punctuation git allows in practice, and none of the shapes git's ref-name rules forbid (`..`, `@{`, `//`, a component starting with a dot, a trailing dot or slash, `.lock`). Anything else (a space, a control character, or one of ~ ^ : ? * [ and a backslash) is left to git itself, which applies its own ref-name rules. */
const PRINTABLE_BRANCH = /^(?!.*(?:\.\.|@\{|\/\/|\.lock$|[./]$)|\.|.*\/\.)[\p{L}\p{N}_./+@#%=,&()'!-]+$/u

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

/** The first line of `file`, trimmed; empty when it cannot be read, which no caller's pattern accepts. */
const firstLine = (file: string): string => (readPrefix(file)?.split(/\r?\n/, 1)[0] ?? '').trim()

/** The repository directory for `cwd`: the nearest ancestor's `.git` directory, or the directory a `.git` file (a linked worktree or submodule) points at, relative paths read from the folder holding that file. Null when there is none, a `.git` directory lacks objects/ or refs/ (git skips it), the walk crosses onto another device (a mount point stops git), or a `.git` file names nothing readable. An exported GIT_DIR names a repository independent of the directory, and an exported GIT_CEILING_DIRECTORIES can stop the walk short of it; neither is modelled, so each is unknown too. */
function repositoryDir(cwd: string): string | null {
  if (process.env['GIT_DIR'] !== undefined || process.env['GIT_CEILING_DIRECTORIES']) return null
  let dir = resolve(cwd)
  // Git walks up from the physical directory, so a junction or symlink is followed first; an unreadable path keeps the unresolved spelling.
  try { dir = realpathSync.native(dir) } catch { /* keep the unresolved path */ }
  try {
    for (;;) {
      const marker = resolve(dir, '.git')
      const info = statSync(marker, { throwIfNoEntry: false })
      // Git skips a `.git` directory that holds no objects/ or refs/ and walks up, so a hollow one means the answer is the spawn's.
      if (info?.isDirectory()) return ['objects', 'refs'].every((part) => existsSync(resolve(marker, part))) ? marker : null
      if (info?.isFile()) {
        const line = firstLine(marker)
        const target = line.startsWith('gitdir:') ? line.slice('gitdir:'.length).trim() : ''
        return target === '' ? null : resolve(dir, target)
      }
      const parent = dirname(dir)
      // Git stops at a filesystem boundary (unless GIT_DISCOVERY_ACROSS_FILESYSTEM is set), so a change of device leaves the answer to the spawn.
      if (parent === dir || statSync(parent).dev !== statSync(dir).dev) return null
      dir = parent
    }
  } catch {
    return null // a path this process cannot stat is one it cannot tell git's answer for
  }
}

/** Whether git might print something other than the plain `name` for the branch HEAD names in `dir`. It prints `heads/<name>` when another ref could be spelled `name` (git's strict abbreviation): `refs/<name>` (a stash is `refs/stash`), a tag, `refs/remotes/<name>` or `refs/remotes/<name>/HEAD`, loose or packed, in the shared refs: the directory a linked worktree's `commondir` file names (relative to its own git directory), else `dir` itself. It refuses outright when that directory has no HEAD. A packed-refs over 8 MB is not scanned, and one that cannot be read for a reason other than being absent counts as holding the tag. */
function branchNameIsUncertain(dir: string, name: string): boolean {
  const common = resolve(dir, readPrefix(resolve(dir, 'commondir'))?.trim() ?? '.')
  const packed = resolve(common, 'packed-refs')
  const rivals = [`refs/${name}`, `refs/tags/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]
  try {
    if (readPrefix(resolve(common, 'HEAD')) === null || rivals.some((r) => statSync(resolve(common, r), { throwIfNoEntry: false })?.isFile())) return true
    const held = statSync(packed).size > 8e6 ? null : `${readFileSync(packed, 'utf8')}\n`
    return held === null || rivals.some((r) => held.includes(` ${r}\n`))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** What `git rev-parse --abbrev-ref HEAD` prints, read from the HEAD file with no process: the branch name for `ref: refs/heads/<name>`, `HEAD` for a detached HEAD (a bare object id), as git does. Null when it cannot be told, never a guess: no repository, an unreadable or garbled HEAD, a ref outside `refs/heads/`, a name outside {@link PRINTABLE_BRANCH}, a tag or other ref that abbreviates to the same name (git prints `heads/<name>` then), a linked worktree whose common directory is gone, or the reftable stub `refs/heads/.invalid` that a reftable repository keeps in HEAD (the real branch is in the table). The caller then asks git. An unborn branch reads as its name, where git exits 128. A `safe.directory` ownership refusal is not modelled: it needs the merged git configuration and, on Windows, the owner's SID, which Node cannot read; the hint then names the branch of a repository git would refuse, a one-word label for the user's own working directory. */
export function readBranchWithoutSpawn(cwd: string): string | null {
  const dir = repositoryDir(cwd)
  if (dir === null) return null
  const line = firstLine(resolve(dir, 'HEAD'))
  const named = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(line)?.[1]
  if (named !== undefined) return PRINTABLE_BRANCH.test(named) && !branchNameIsUncertain(dir, named) ? named : null
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line) ? 'HEAD' : null
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
  return findingsOfGitResult(result)
}

/** The {@link GitFindings} answer for a finished git result, shared by the sync probe above and callers that ran git asynchronously. */
export function findingsOfGitResult(result: GitResult): GitFindings {
  if (result.timedOut === true) return 'timed-out'
  if (result.exitCode !== 0) return 'refused'
  return result.stdout.trim() === '' ? 'clean' : 'dirty'
}
