/** Git-tracked file listing, used by `token-goat arch`'s import-graph scan (see `runArch` in graph_commands.ts). */

import * as fs from 'fs'
import * as path from 'path'
import { CliError } from './command_error.js'
import { type GitResult } from './types.js'
import { runGit, runGitAsyncLazy } from './util.js'

/** What `git ls-files` answered for a directory: the tracked files, and whether they are missing because git was killed (for running too long, or by a signal). Empty `files` with `timedOut` false means git had nothing to list (not a repository, nothing tracked, git failed); with `timedOut` true it means nothing is known. */
export interface TrackedFilesResult {
  readonly files: string[]
  readonly timedOut: boolean
}

/** Where `git ls-files` runs for `cwd`, and with what arguments. Shared by {@link listTrackedFiles} and {@link listTrackedFilesAsync} so the two cannot disagree about it. */
function trackedFilesInvocation(cwd: string): { dir: string; args: string[] } {
  let dir = cwd
  let onlyFile = ''
  try {
    if (fs.statSync(cwd).isFile()) {
      dir = path.dirname(cwd)
      onlyFile = path.basename(cwd)
    }
  } catch {
    // Unstattable: leave it to git, which reports the same "nothing tracked" empty result.
  }
  // --error-unmatch turns "path exists but is untracked" into a non-zero exit rather than empty output, which the exitCode check in trackedFilesFrom already maps to no files.
  return { dir, args: onlyFile === '' ? ['ls-files'] : ['ls-files', '--error-unmatch', '--', onlyFile] }
}

/** What `git ls-files` answered, as a {@link TrackedFilesResult}: a killed git is unknown (`timedOut`), a failed or empty one is nothing tracked. */
function trackedFilesFrom(dir: string, result: GitResult): TrackedFilesResult {
  // A spawn refused with ENOENT because the directory is gone leaves git nothing to list, which is the answer for a directory that does not exist; a missing git looks the same (Node names neither), so the directory decides, and a killed or timed-out git is unknown whatever the directory.
  if (result.unfinished) return { files: [], timedOut: !(result.timedOut !== true && result.signal === undefined && result.stderr.includes('ENOENT') && !fs.existsSync(dir)) }
  if (result.exitCode !== 0 || !result.stdout) {
    return { files: [], timedOut: false }
  }
  const files = result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((rel) => path.join(dir, rel))
  return { files, timedOut: false }
}

/** Get all git-tracked files under cwd, unfiltered -- callers apply their own source/language filtering (see `cli.ts`'s `cmdIndex` and `graph_commands.ts`'s `runArch`). Returns `path.join(cwd, rel)` for each tracked file -- absolute or relative depending on whether `cwd` itself is absolute, not on platform. A single file path is accepted as well, and resolves to just that file when it is tracked: git cannot chdir into a file, so passing one as `cwd` would spawn with a non-zero exit and report a tracked file as untracked. */
export function listTrackedFiles(cwd: string = process.cwd()): TrackedFilesResult {
  try {
    const { dir, args } = trackedFilesInvocation(cwd)
    return trackedFilesFrom(dir, runGit(args, { cwd: dir }))
  } catch {
    return { files: [], timedOut: false }
  }
}

/** {@link listTrackedFiles} without blocking the event loop, for the worker, whose sweep of a hung repository must not stall the drain behind it. The same answer for every input, a single file path included; never rejects. */
export async function listTrackedFilesAsync(cwd: string = process.cwd()): Promise<TrackedFilesResult> {
  try {
    const { dir, args } = trackedFilesInvocation(cwd)
    return trackedFilesFrom(dir, await runGitAsyncLazy(args, { cwd: dir }))
  } catch {
    return { files: [], timedOut: false }
  }
}

/** The tracked files under `cwd` for a command that cannot go on without a real answer. A listing git did not finish throws a {@link CliError}, so it is never read as "no tracked files" (which sends `index --walk` to a directory walk and tells `arch` the project is empty); a git that ran and found nothing still returns an empty list. */
export function requireTrackedFiles(cwd: string = process.cwd()): string[] {
  const tracked = listTrackedFiles(cwd)
  if (tracked.timedOut) throw new CliError(`git did not answer in time while listing the tracked files under ${cwd}. Try again once git responds.`)
  return tracked.files
}
