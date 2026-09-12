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
import { isInsideRoot } from '../project.js'

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
