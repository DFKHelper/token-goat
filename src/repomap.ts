/**
 * Git-tracked file listing, used by `token-goat arch`'s import-graph scan
 * (see `runArch` in graph_commands.ts).
 */

import * as path from 'path'
import { runGit } from './util.js'

/**
 * Get all tracked files from git, filtered to source files only.
 * Returns absolute paths on Windows, relative POSIX paths elsewhere.
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
