/**
 * pi (pi-coding-agent) install / uninstall writer.
 *
 * `token-goat install --pi` drops a TypeScript extension file for pi in
 * addition to the base Claude Code install (see README's "pi users" section:
 * "The `--pi` flag patches Claude Code and drops a TypeScript extension into
 * pi's global extensions directory"). This module only ever touches the one
 * extension file path below -- the base Claude Code writer in `../install.ts`
 * is unaffected and is always run separately by the caller, exactly like
 * `../bridges/codex_install.ts`'s `installCodex`.
 *
 * Two install targets, both writing the exact same {@link PI_EXTENSION_SCRIPT}
 * content:
 * - Global: `~/.pi/agent/extensions/token-goat.ts`. pi auto-discovers this on
 *   its next launch (README: "approve the project-trust prompt the first
 *   time").
 * - Project-local (`opts.local: true`): `<project>/.pi/extensions/token-goat.ts`
 *   -- note this path has no `agent/` segment, unlike the global one. Verified
 *   against both README sections that document it ("pi users" prose: "This
 *   writes `.pi/extensions/token-goat.ts` in the current project only"; the
 *   "What gets installed?" table: "A project-local install writes
 *   `<project>/.pi/extensions/token-goat.ts` instead") -- the two agree, no
 *   discrepancy to reconcile.
 *
 * Unlike Codex's `config.toml` (structured TOML, merged entry-by-entry via
 * `smol-toml`, `.bak`'d before every in-place edit) or its `AGENTS.md`
 * (a delimited block inside a larger user-owned file), the pi extension is a
 * single whole file with no merge target: pi loads it as one complete module,
 * so there is nothing to merge into. README describes it as "a normal pi
 * extension" that "pi auto-discovers" -- i.e. a generated, versioned artifact
 * analogous to Codex's `token-goat-shim.js` (which `installCodex` also
 * rewrites unconditionally on every call, comment: "a generated,
 * never-user-edited file: keep it in sync with the running token-goat version
 * on every install call"), not a file users are expected to hand-edit.
 * {@link installPi} therefore always overwrites on a genuine content
 * difference (upgraded template, or a user's local edits) with no `.bak` and
 * no confirmation prompt -- there being no structured merge to preserve, a
 * backup would just be a second stale copy to clean up later. It still keeps
 * installs idempotent by skipping the write (and reporting `alreadyInstalled:
 * true`) when the file on disk is already byte-identical to the current
 * template, so a repeat `install --pi` does not touch the file's mtime for no
 * reason.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync } from '../util.js'
import { PI_EXTENSION_SCRIPT } from './pi.js'

/** Options shared by {@link installPi}, {@link uninstallPi}, and {@link isPiInstalled}. */
export interface PiScopeOptions {
  /** When true, target the project-local extension path instead of the global one. */
  local?: boolean
}

/** Absolute path to the global pi extension file: `~/.pi/agent/extensions/token-goat.ts`. */
export function piGlobalExtensionPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'extensions', 'token-goat.ts')
}

/**
 * Absolute path to the project-local pi extension file:
 * `<project>/.pi/extensions/token-goat.ts` (no `agent/` segment -- see the
 * module doc comment above for why this differs from the global path).
 */
export function piLocalExtensionPath(): string {
  return path.join(process.cwd(), '.pi', 'extensions', 'token-goat.ts')
}

/** Resolve the target extension path for the given scope options. */
export function piExtensionPath(opts: PiScopeOptions = {}): string {
  return opts.local === true ? piLocalExtensionPath() : piGlobalExtensionPath()
}

/** Outcome of an {@link installPi} call. */
export interface PiInstallResult {
  readonly extensionPath: string
  /** True when the file on disk was already byte-identical to the current template (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install the pi extension: write {@link PI_EXTENSION_SCRIPT} to the resolved
 * path (global by default, project-local when `opts.local` is true).
 *
 * Idempotent and always-overwrite-on-difference (see module doc comment for
 * why this file has no merge/backup logic, unlike Codex's `config.toml`): a
 * missing or stale file is written unconditionally; a file already
 * byte-identical to the current template is left untouched and reported as
 * `alreadyInstalled: true`.
 */
export function installPi(opts: PiScopeOptions = {}): PiInstallResult {
  const extensionPath = piExtensionPath(opts)

  let existing: string | undefined
  try {
    existing = fs.readFileSync(extensionPath, 'utf8')
  } catch {
    existing = undefined
  }

  if (existing === PI_EXTENSION_SCRIPT) {
    return { extensionPath, alreadyInstalled: true }
  }

  ensureDirSync(path.dirname(extensionPath))
  atomicWriteText(extensionPath, PI_EXTENSION_SCRIPT)
  return { extensionPath, alreadyInstalled: false }
}

/**
 * Remove the pi extension file at the resolved path. Returns true when a file
 * was actually present and removed; false when nothing was installed (no
 * write occurs in that case).
 */
export function uninstallPi(opts: PiScopeOptions = {}): boolean {
  const extensionPath = piExtensionPath(opts)
  try {
    fs.unlinkSync(extensionPath)
    return true
  } catch {
    return false
  }
}

/**
 * Is the pi extension currently present at the resolved path?
 *
 * Presence-only, mirroring how {@link isCodexInstalled} in `codex_install.ts`
 * checks its own single-file shim script (`fs.existsSync`, not a content
 * comparison) -- a present-but-outdated file still counts as installed, and
 * {@link installPi} tops it up to the current template on the next call.
 */
export function isPiInstalled(opts: PiScopeOptions = {}): boolean {
  return fs.existsSync(piExtensionPath(opts))
}
