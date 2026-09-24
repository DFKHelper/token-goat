import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scrubRepoLocalGitEnv } from './git-env.js'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The single tracked-file enumeration for the guards, deliberately independent of whatever index the caller's git invocation happens to have set up.
//
// `git ls-files` reads `$GIT_INDEX_FILE`, and `git commit --only <paths>` does not use the real index: it builds a temporary one holding HEAD plus only the named paths and points `GIT_INDEX_FILE` at it for the duration, hooks included. A guard that inherits that variable enumerates a truncated repository -- a file staged outside the pathspec is simply absent -- and reports invariants broken that are not. Deleting the variable makes every call read the real `.git/index`.
//
// The real index is the question the guards want answered: everything that will be in the repository once this commit lands, which includes a file staged outside the pathspec being committed and excludes one staged for deletion. `git ls-tree HEAD` answers a different question -- what is already committed -- so it would skip a newly staged file entirely, which is the coverage hole the guards exist to close. A file tracked but deleted from the worktree stays listed either way; callers that read file contents handle that themselves.
//
// `-z` rather than splitting on newlines: git quotes and backslash-escapes paths containing unusual bytes in its newline-separated output, so a NUL-separated read is the only one that round-trips every tracked path verbatim.
export function trackedFiles(options: { repo?: string; pathspec?: string[] } = {}): string[] {
  const env = { ...process.env }
  scrubRepoLocalGitEnv(env)
  const args = ['-C', options.repo ?? REPO_ROOT, 'ls-files', '-z']
  if (options.pathspec && options.pathspec.length > 0) args.push('--', ...options.pathspec)
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26, env })
    .split('\0')
    .filter((p) => p !== '')
}
