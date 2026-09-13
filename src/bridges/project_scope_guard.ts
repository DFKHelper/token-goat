/**
 * Refuse a project-scope install target that does not really live inside the project.
 *
 * `install --vscode` defaults to project scope, so for the first time the installer reads, backs
 * up and rewrites files that came out of a clone the user did not write. Every one of those paths
 * is attacker-choosable content: a repository can check `.github/copilot-instructions.md` in as a
 * symlink to `~/.ssh/id_ed25519`, or `.vscode/mcp.json` as a symlink to `~/.docker/config.json`
 * (which parses cleanly as JSON and so survives every shape check the MCP reader applies). The
 * installer would then read through the link and -- worse -- `backupFile` would `copyFileSync` the
 * secret's bytes into `<repo>/.github/copilot-instructions.md.bak.<ISO>`, an untracked file no
 * `.gitignore` matches and `git add -A` sweeps up.
 *
 * The check is containment, not just "is the leaf a symlink": a repository can equally check in
 * `.github` itself as a directory symlink, and it does not matter whether the leaf behind it is an
 * ordinary file or is absent. Both halves matter, and only the first was covered at first:
 * {@link isInsideRoot} used to fall back to a LEXICAL comparison whenever `realpathSync` threw,
 * which it does the moment any component is missing -- so the case an installer is always in, a
 * file it is about to create, was the case that skipped the link resolution entirely. It now
 * resolves the nearest existing ancestor through `realpathSync`, follows a dangling leaf link
 * through `readlink`, and re-appends only the genuinely absent tail, so it answers the question
 * that actually matters -- after following every link, is this path still in the project? It is
 * the same helper `vscode_path_gate.ts` already uses to confine a pre-approval hook.
 *
 * Scoped to project targets deliberately. A user-scope target (`~/.copilot/instructions/...`,
 * the VS Code user profile `mcp.json`) is routinely a symlink into a dotfiles repository, and
 * refusing those would break a legitimate and common setup for no security gain: the user owns
 * both ends of that link. `projectRoot === undefined` therefore means user scope and passes
 * everything through unchanged.
 */
import * as path from 'node:path'

import { isTokenGoatStorage } from '../constants.js'
// From the leaf module, NOT from `../project.js` which re-exports it: this module is imported by
// util.ts, and going through project.ts would close a util -> project -> util cycle. See
// path_containment.ts's header for what that cycle actually broke.
import { isInsideRoot } from '../path_containment.js'

/**
 * Throw when `target` is not contained in `projectRoot` once every symlink on it is resolved.
 *
 * No-op when `projectRoot` is undefined (user scope). A target that does not exist yet is NOT
 * waved through: its ancestors are resolved and its absent tail re-appended, so a link anywhere
 * above it still decides the answer. The earlier version of this sentence claimed the opposite --
 * "has no link to follow and compares lexically, which is the right answer" -- and that sentence
 * was the bug written down: it reasoned about the leaf while the link sat on a parent.
 */
export function assertProjectScopeTarget(target: string, projectRoot: string | undefined): void {
  if (projectRoot === undefined) return
  if (isInsideRoot(target, projectRoot)) return
  throw new Error(
    `refusing to touch ${target}: it resolves outside the project (${projectRoot}). A repository can check a config path in as a symlink to a private file, and installing over it would read and back up that file's contents into the working tree. Remove the link, or run the install with --user.`,
  )
}

/**
 * The project root the install or uninstall currently running is confined to, or `undefined` when
 * it is a user-scope run. Module-level rather than an AsyncLocalStorage because every installer
 * here is synchronous end to end.
 */
let installProjectRoot: string | undefined

/**
 * Declare the scope of one install/uninstall run, so that {@link assertWriteInScope} can enforce
 * it on every write the run makes without the write's own author having to remember anything.
 *
 * This is the inversion. {@link assertProjectScopeTarget} was a guard a caller had to remember to
 * call against a list of targets it had to remember to keep complete, and FOUR of five installer
 * authors forgot -- `--visualstudio -p`, `--copilot --local`, `--cursor -p` and `--pi --local`
 * each read a repo-controlled config path through whatever symlink a clone had checked in, and
 * `--copilot --local` shipped that way in v2.9.10. A per-installer patch would regrow the moment
 * a sixth installer is written, because the thing being forgotten is the call itself.
 *
 * So the unit of remembering moves from every write site (about twenty, and growing) to one
 * declaration per installer entry point, and the enforcement moves into `backupFile`,
 * `ensureDirSync`, `atomicWriteCore` and `upsertDelimitedBlock` -- the four helpers every
 * installer write already funnels through. A new installer that computes `<root>/.foo/config`
 * and writes it through any of them is confined with no further code, and one that forgets to
 * declare its scope at all is caught by `tests/guards/installer_writes_are_contained.test.ts`,
 * which does not read the source for a call: it runs each entry point against a real
 * symlink-escape fixture and requires a refusal.
 *
 * `undefined` means user scope and is an explicit, non-defaulting answer: a user-scope config
 * path is routinely a symlink into a dotfiles repository the user owns both ends of, and
 * refusing those would break a common setup for no security gain. Nesting restores the outer
 * scope on the way out, which matters because a project-scope install walks a user-scope one back
 * (`installVscode`'s `migratedFromUserScope`) and that inner run must not inherit the confinement.
 */
export function withInstallScope<T>(projectRoot: string | undefined, fn: () => T): T {
  const previous = installProjectRoot
  installProjectRoot = projectRoot === undefined ? undefined : path.resolve(projectRoot)
  try {
    return fn()
  } finally {
    installProjectRoot = previous
  }
}

/**
 * The project root for a bridge's scope options, for handing to {@link withInstallScope}.
 *
 * `project` and `local` are the same decision spelled two ways across the bridges (`--vscode -p`,
 * `--cursor -p`, `--visualstudio -p` versus `--copilot --local`, `--pi --local`), and both fall
 * back to the working directory exactly as each bridge's own path helpers do.
 */
export function projectScopeRoot(opts: { readonly project?: boolean; readonly local?: boolean; readonly projectRoot?: string } | undefined): string | undefined {
  if (opts === undefined) return undefined
  if (opts.project !== true && opts.local !== true) return undefined
  return path.resolve(opts.projectRoot ?? process.cwd())
}

/**
 * Refuse a write that would leave the project the running install declared itself confined to.
 *
 * Called by the write helpers themselves, so omission fails CLOSED: a path an installer never
 * thought to list is checked anyway, and the only way to write outside the root is to have
 * declared user scope in the first place.
 *
 * token-goat's own storage roots are exempt, and that exemption is not a hole: an install running
 * in project scope still has to journal what it created (`created-configs.json`) and write its
 * generated hook shim, both of which live under `dataDir()`/`tokenGoatHome()` by construction --
 * paths derived from the environment, never from the clone. Without the exemption the strict
 * default would refuse token-goat's own bookkeeping, and the pressure to relax it would land
 * somewhere much worse.
 */
export function assertWriteInScope(target: string): void {
  const root = installProjectRoot
  if (root === undefined) return
  if (isTokenGoatStorage(target)) return
  assertProjectScopeTarget(target, root)
}
