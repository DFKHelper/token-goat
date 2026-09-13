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
 *
 * That "synchronous end to end" is a real precondition, not a stylistic note, and until now it was
 * stated here and pinned by nothing. A module-level variable restored in a `finally` is restored at
 * the first SUSPENSION point, not at the logical end of the run: make one installer `async` and
 * `withInstallScope` returns its promise immediately, runs the `finally`, and sets the scope back
 * to `undefined` while every write the installer has not reached yet is still to come -- silently
 * disabling containment for the rest of the run, with no error and no failing test. It is pinned in
 * two places now: {@link withInstallScope} refuses a thenable at runtime (below), and
 * `tests/guards/install_scope_is_synchronous.test.ts` refuses one structurally, so the hazard is
 * caught whether or not the new installer's path is ever executed.
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
 * and writes it through any of them is confined with no further code.
 *
 * One that forgets to declare its scope at all is NOT confined at runtime -- see
 * {@link assertWriteInScope} for why the undeclared default cannot be flipped -- and is caught
 * instead by `tests/guards/installer_writes_are_contained.test.ts`, in two halves that cover
 * different failure modes. Its STRUCTURAL half DOES read the source for the call, which is what
 * catches a bridge whose entry point no behavioural case exercises; its BEHAVIOURAL half runs a
 * hand-maintained list of flags against a real symlink-escape fixture, which is what catches a
 * declaration that is present but wrong. Neither alone is sufficient, and an earlier version of
 * this paragraph credited the behavioural half with the structural half's coverage.
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
    const result = fn()
    // The scope is a module-level variable restored by the `finally` below, so it is only correct
    // while `fn` finishes before returning. An async `fn` returns a promise at its first `await`,
    // the `finally` fires there, and every write after that point runs with the scope already put
    // back -- containment silently off for the remainder of the run. Refusing the promise here
    // turns that into a loud failure at the first execution instead of a quiet hole. Checked on the
    // RESULT rather than on `fn` itself so a plain function that merely returns a promise is caught
    // too. If an installer genuinely has to become async, the fix is AsyncLocalStorage, not
    // deleting this.
    if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
      throw new Error(
        'withInstallScope was given a function that returned a thenable. The install scope is held in a module-level variable and restored synchronously, so an async installer would run every write after its first await with containment already switched off. Make the installer synchronous, or move the scope to AsyncLocalStorage first.',
      )
    }
    return result
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
 * WHAT THIS DOES AND DOES NOT INVERT. Called by the write helpers themselves, so within a run that
 * HAS declared a project scope, omission fails closed: a path the installer never thought to list
 * is checked anyway, and there is no write site left to forget. What it does NOT do -- and an
 * earlier version of this comment and of the CHANGELOG both claimed it did -- is fail closed when
 * no scope was declared at all. `root === undefined` returns early and permits everything. Measured
 * with in-band positive controls in one run: scope-declared + outside target REFUSED,
 * scope-declared + inside ALLOWED, NO scope declared + outside target ALLOWED, nested-undefined +
 * outside ALLOWED, after nested restore REFUSED.
 *
 * So the honest statement is that the unit of forgetting moved from ~20 write sites to ~10 entry
 * points -- a real and large reduction, and a smaller-surface version of the same defect class,
 * NOT an inversion of the default. The permissive default cannot simply be flipped: these four
 * helpers are the whole codebase's write path, not the installers'. `atomicWriteCore` alone backs
 * the worker, the indexer, snapshots, the created-configs ledger and `write-file`, none of which
 * has an install run to declare anything, so "refuse unless a root was declared" would refuse
 * essentially every write token-goat makes outside its own storage. Nor can the install dispatcher
 * declare a user root on their behalf: an install run legitimately makes USER-scope writes during a
 * PROJECT-scope run (`~/.claude/CLAUDE.md`, the skill, the shared hook shim), and confining those
 * broke `install -p` once already -- which is why the containment guard pairs every refusal with an
 * in-band clean-clone control.
 *
 * The control that actually covers the undeclared case is therefore structural, and it is named
 * rather than implied: `tests/guards/installer_writes_are_contained.test.ts` enumerates every
 * module that builds a repo-relative path and writes it through a helper, and fails if one of them
 * does not declare a scope. That guard is load-bearing, not supplementary. Its population is pinned
 * by count, by ceiling and by exact member name for the same reason.
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
