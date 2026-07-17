/**
 * Git-tracked file listing, used by `token-goat arch`'s import-graph scan
 * (see `runArch` in graph_commands.ts).
 */

import * as path from 'path'
import { runGit } from './util.js'

/**
 * Get all git-tracked files under cwd, unfiltered -- callers apply their own
 * source/language filtering (see `cli.ts`'s `cmdIndex` and `graph_commands.ts`'s
 * `runArch`). Returns `path.join(cwd, rel)` for each tracked file -- absolute or
 * relative depending on whether `cwd` itself is absolute, not on platform.
 */
export function getTrackedFiles(cwd: string = process.cwd()): string[] {
  try {
    const result = runGit(['ls-files'], { cwd })
    if (result.exitCode !== 0 || !result.stdout) {
      return []
    }
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((rel) => path.join(cwd, rel))
  } catch {
    return []
  }
}
