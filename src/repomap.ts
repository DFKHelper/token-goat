/**
 * Git-tracked file listing, used by `token-goat arch`'s import-graph scan
 * (see `runArch` in graph_commands.ts).
 */

import * as fs from 'fs'
import * as path from 'path'
import { runGit } from './util.js'

/**
 * Get all git-tracked files under cwd, unfiltered -- callers apply their own
 * source/language filtering (see `cli.ts`'s `cmdIndex` and `graph_commands.ts`'s
 * `runArch`). Returns `path.join(cwd, rel)` for each tracked file -- absolute or
 * relative depending on whether `cwd` itself is absolute, not on platform.
 *
 * A single file path is accepted as well, and resolves to just that file when it
 * is tracked: git cannot chdir into a file, so passing one as `cwd` would spawn
 * with a non-zero exit and report a tracked file as untracked.
 */
export function getTrackedFiles(cwd: string = process.cwd()): string[] {
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
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((rel) => path.join(dir, rel))
  } catch {
    return []
  }
}
