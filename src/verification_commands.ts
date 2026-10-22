/** Checks beyond the test, lint, typecheck and build runners that verification_state.ts recognises by name. Each entry is narrow on purpose: a command wrongly taken for a check clears the Stop advisory for edits nothing verified, which is the costly direction, while a check that goes unrecognised only costs one extra reminder. */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { runGit } from './util.js'

const PYTHON_SCRIPT_RUN = /^python3?\s+(\S+\.py)(?=\s|$)/i
/** A script path word: no quote, no expansion, no space, so the script that runs is the one the check sees. */
const SCRIPT_PATH = /^[\w./@~:\\-]+$/
/** `run_self_tests.py`, `run_tests.py`, `validate-skills.py`, `check_push_bumps.py`: the file name states that the script's whole job is to check. A script's exit status is its verdict by the convention these names carry. */
const CHECK_SCRIPT_NAME = /^(?:run_[\w-]*tests?[\w-]*|validate[\w-]*|check[_-][\w-]+)\.py$/i

/** True when `segment` (its leading `NAME=value` assignments already removed) runs a script that checks a repository: one with a checking file name, or any script given `--self-test`, the repository's own spelling for "run this script's built-in tests". A bare `python foo.py` is not one. */
export function isScriptCheckSegment(segment: string): boolean {
  const script = PYTHON_SCRIPT_RUN.exec(segment)?.[1]
  if (script === undefined || !SCRIPT_PATH.test(script)) return false
  const name = script.split(/[/\\]/).pop() ?? ''
  return CHECK_SCRIPT_NAME.test(name) || segment.split(/\s+/).includes('--self-test')
}

const GIT_HOOK_COMMAND = /^git\s+(push|commit)(?=\s|$)/
// Anything that skips the hooks, only previews, or can be an abbreviation of such an option (git accepts a unique prefix): `--no-verify`, `--dry-run`, `--help`, and a short cluster holding `n` (`commit -n` skips hooks, `push -n` is a dry run).
const SKIPS_OR_PREVIEWS = /\s(?:--(?:no-v|dr|he|n(?:o|\s|$))|-[A-Za-z]*[nh])/

/** Which hook a `git commit` or `git push` segment runs ('pre-commit' or 'pre-push'), or null for any other segment, one that skips the hooks, one that only previews, and one with an environment prefix (`HUSKY=0 git commit` turns a hook manager off). Takes the segment as written, not with assignments stripped. */
export function gitHookOf(segment: string): 'pre-commit' | 'pre-push' | null {
  const trimmed = segment.trim()
  const match = GIT_HOOK_COMMAND.exec(trimmed)
  if (match === null || SKIPS_OR_PREVIEWS.test(trimmed)) return null
  return match[1] === 'push' ? 'pre-push' : 'pre-commit'
}

/** The hook file git would run for `hook` in the repository at `cwd`: honours `core.hooksPath` through `rev-parse --git-path hooks`. Null when there is no such file or it cannot run (a POSIX file without an execute bit; git for Windows ignores the mode). */
function runnableHook(cwd: string, hook: string): string | null {
  const dir = runGit(['rev-parse', '--git-path', 'hooks'], { cwd })
  if (dir.exitCode !== 0 || dir.stdout.trim() === '') return null
  const hooksDir = dir.stdout.trim()
  const file = join(isAbsolute(hooksDir) ? hooksDir : join(cwd, hooksDir), hook)
  try {
    if (!statSync(file).isFile()) return null
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return file
  } catch {
    return null
  }
}

/** True when a `git commit` or `git push` that exited 0 ran a hook over everything edited: the hook exists and can run, the push was not an "Everything up-to-date" no-op (git runs no pre-push hook for it), and the working tree is clean afterwards, so no edit sits outside the commit the hook judged. A repository the check cannot read (no git, no cwd) is not verified. */
export function hookBackedRunVerified(hook: 'pre-commit' | 'pre-push', cwd: string | null | undefined, output: string): boolean {
  if (cwd === null || cwd === undefined || cwd === '') return false
  if (hook === 'pre-push' && /up-to-date/i.test(output)) return false
  if (runnableHook(cwd, hook) === null) return false
  const status = runGit(['status', '--porcelain'], { cwd })
  return status.exitCode === 0 && status.stdout.trim() === ''
}
