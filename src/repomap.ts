/** Git-tracked file listing, used by `token-goat arch`'s import-graph scan (see `runArch` in graph_commands.ts). */

import * as fs from 'fs'
import * as path from 'path'
import { CliError } from './command_error.js'
import { runGit } from './util.js'

/** What `git ls-files` answered for a directory: the tracked files, and whether they are missing because git was killed for running too long. Empty `files` with `timedOut` false means git had nothing to list (not a repository, nothing tracked, git failed); with `timedOut` true it means nothing is known. */
export interface TrackedFilesResult {
  readonly files: string[]
  readonly timedOut: boolean
}

/** {@link listTrackedFiles} without the timeout flag: a listing git did not finish comes back as an empty list, so a caller that must tell that from "nothing tracked" uses {@link listTrackedFiles}. */
export function getTrackedFiles(cwd: string = process.cwd()): string[] {
  return listTrackedFiles(cwd).files
}

/** Get all git-tracked files under cwd, unfiltered -- callers apply their own source/language filtering (see `cli.ts`'s `cmdIndex` and `graph_commands.ts`'s `runArch`). Returns `path.join(cwd, rel)` for each tracked file -- absolute or relative depending on whether `cwd` itself is absolute, not on platform. A single file path is accepted as well, and resolves to just that file when it is tracked: git cannot chdir into a file, so passing one as `cwd` would spawn with a non-zero exit and report a tracked file as untracked. */
export function listTrackedFiles(cwd: string = process.cwd()): TrackedFilesResult {
  try {
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
    // --error-unmatch turns "path exists but is untracked" into a non-zero exit rather than empty output, which the exitCode check below already maps to no files.
    const args = onlyFile === '' ? ['ls-files'] : ['ls-files', '--error-unmatch', '--', onlyFile]
    const result = runGit(args, { cwd: dir })
    if (result.timedOut === true) return { files: [], timedOut: true }
    if (result.exitCode !== 0 || !result.stdout) {
      return { files: [], timedOut: false }
    }
    const files = result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((rel) => path.join(dir, rel))
    return { files, timedOut: false }
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
