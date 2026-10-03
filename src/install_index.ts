/** First index of the project `install` runs in. Before this, a fresh install indexed nothing: session start deliberately reconciles only a project that already has symbols (see hooks_session_start.ts::reconcileNote), so every surgical-read command came back empty until the user found and ran `token-goat index` themselves, and a user who never did saw the product do nothing. The work is queued, never done inline: the files go onto the dirty queue through the same sweep session start uses (reconcile.ts::reconcileProject), and that sweep's batch enqueue wakes the background worker (hooks_index.ts::enqueueDirtyPathsSafe), so install returns in the time a `git ls-files` takes rather than the minutes a whole-repository parse takes. */

import * as fs from 'node:fs'

import { countSymbols } from './index_reader.js'
import { globalDbPath } from './constants.js'
import { loadConfig } from './config.js'
import { envBool } from './env.js'
import { findProject, isUnderSystemTemp } from './project.js'
import { reconcileProject } from './reconcile.js'
import { getTrackedFiles } from './repomap.js'
import { canonicalize, foldPath } from './path_containment.js'
import { countNoun, extractErrorMessage, isUnderBlockedRoot, runGit } from './util.js'
import { assertWalkableRoot } from './walk_index.js'

/** Long enough to list any real repository: for a project with no rows every tracked file is "added" at the cost of one map lookup, so the budget bounds only a pathological tree. A truncated sweep saves its cursor and session start's own reconcile picks up the rest. */
const INSTALL_INDEX_BUDGET_MS = 10_000

/** Opt-out switch, read here rather than listed in constants.ts ENV_KEYS: constants.ts is a parser-fingerprint source, so adding a key there would make every user reparse their whole index on upgrade for a change that touches no extracted content. */
export const INSTALL_INDEX_ENV = 'TOKEN_GOAT_INSTALL_INDEX'

export type InstallIndexResult =
  | { status: 'queued'; root: string; files: number }
  | { status: 'skipped'; reason: 'disabled' | 'no-project' | 'broad-root' | 'temp' | 'blocked' | 'indexed' | 'not-git' | 'untracked' | 'nothing-queued'; root?: string }
  | { status: 'failed'; error: string }

/** True when `root` is itself a git top level: a repository with nothing tracked yet, as opposed to a plain folder (or one nested in somebody else's repository, whose top level is a different directory). */
function isOwnGitToplevel(root: string): boolean {
  const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: root })
  if (toplevel.exitCode !== 0 || toplevel.stdout.trim() === '') return false
  return foldPath(canonicalize(fs.realpathSync(toplevel.stdout.trim()))) === foldPath(canonicalize(fs.realpathSync(root)))
}

/** Queue the project containing `cwd` for its first index and wake the worker. Default on, with `--no-index` or TOKEN_GOAT_INSTALL_INDEX=0 as the opt-out: an install that indexes nothing is the failure this module exists to remove. Never throws: install has already succeeded by the time this runs, and a failure here must not turn that into an error. */
export function queueInstallIndex(cwd: string, opts: { enabled?: boolean | undefined } = {}): InstallIndexResult {
  try {
    if (opts.enabled === false || !envBool(INSTALL_INDEX_ENV, true)) return { status: 'skipped', reason: 'disabled' }
    const project = findProject(cwd)
    if (project === null) return { status: 'skipped', reason: 'no-project' }
    const root = project.root
    // A marker in the home directory or above it (a stray ~/.git, a dotfiles repo) makes the whole profile look like one project. Indexing it would walk every folder the user owns, which is the same case `index --walk` refuses.
    try {
      assertWalkableRoot(root)
    } catch {
      return { status: 'skipped', reason: 'broad-root', root }
    }
    if (isUnderSystemTemp(root)) return { status: 'skipped', reason: 'temp', root }
    if (isUnderBlockedRoot(root, loadConfig().worker.blocked_roots)) return { status: 'skipped', reason: 'blocked', root }
    // Already indexed means session start's reconcile owns it from here; sweeping it again at install would only duplicate that.
    if (countSymbols({ rootDir: root }, globalDbPath()) > 0) return { status: 'skipped', reason: 'indexed', root }
    // reconcileProject enumerates through git, so a non-git folder would come back as zero files and read as "nothing to do". It is said instead, because `index --walk` is the way in for that folder.
    if (getTrackedFiles(root).length === 0) return { status: 'skipped', reason: isOwnGitToplevel(root) ? 'untracked' : 'not-git', root }
    const result = reconcileProject({ cwd: root, budgetMs: INSTALL_INDEX_BUDGET_MS })
    if (result.enqueued === 0) return { status: 'skipped', reason: 'nothing-queued', root }
    return { status: 'queued', root, files: result.enqueued }
  } catch (e) {
    return { status: 'failed', error: extractErrorMessage(e) }
  }
}

/** The one line install prints for a result, or null when there is nothing worth saying. An already-indexed project and a disabled index stay silent: the first is the steady state of every reinstall, the second is what the user asked for. */
export function formatInstallIndexResult(result: InstallIndexResult): string | null {
  if (result.status === 'queued') {
    return `Indexing ${result.root} in the background (${countNoun(result.files, 'file')} queued); \`token-goat doctor\` shows progress.`
  }
  if (result.status === 'failed') {
    return `Could not queue this project for indexing (${result.error}); run \`token-goat index\` inside it instead.`
  }
  switch (result.reason) {
    case 'no-project':
      return 'No project here to index. Run `token-goat index` inside a project, or start a session in one after it has been indexed.'
    case 'broad-root':
      return `${result.root ?? 'This folder'} is too broad to index automatically (a home or drive root); run \`token-goat index\` inside a specific project.`
    case 'temp':
      return `${result.root ?? 'This folder'} is under the system temp directory, so install does not index it automatically; run \`token-goat index\` there to index it.`
    case 'not-git':
      return `${result.root ?? 'This folder'} is not a git repository, so it was not indexed. Run \`token-goat index --walk\` inside it to index it anyway.`
    case 'untracked':
      return `${result.root ?? 'This folder'} is a git repository with no tracked files yet, so it was not indexed. Run \`token-goat index --walk\` inside it, or \`git add\` the files and run \`token-goat index\`.`
    case 'blocked':
      return `${result.root ?? 'This folder'} is excluded by worker.blocked_roots, so it was not indexed.`
    default:
      return null
  }
}
