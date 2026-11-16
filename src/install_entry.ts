import * as fs from 'fs'
import * as path from 'path'
import { installedLauncher, npmInvocation } from './cli_upgrade.js'
import { quotedArg } from './hint_suggestion_guard.js'

// limit: npm root -g bound, 2x the 29.6 s measured here; revisit-when: npm root -g takes over 60 s on a supported host.
const NPM_ROOT_TIMEOUT_MS = 60_000

/** The package root a bundle at `entryPath` belongs to: dist/token-goat.mjs and src/cli.ts both sit one level below it. */
export function packageRootOf(entryPath: string): string {
  return path.dirname(path.dirname(entryPath))
}

/** True when `entryPath` runs from a git checkout: its real package root holds `.git` (a directory, or a file in a linked worktree). */
export function isDevCheckoutEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || entryPath === '') return false
  return fs.existsSync(path.join(packageRootOf(realEntryPath(entryPath)), '.git'))
}

/** The bin a symlink points at, so `~/bin/token-goat` -> the npm package resolves to the package, not to the link's own directory. A missing entry keeps its spelling. */
export function realEntryPath(entryPath: string): string {
  try {
    return fs.realpathSync(entryPath)
  } catch {
    return entryPath
  }
}

/** The bundle the npm global install runs (`npm root -g`), or null when npm cannot say, runs past its deadline, or the file is absent. */
export function globalEntryPath(): string | null {
  const npm = npmInvocation({ platform: process.platform, env: process.env, execPath: process.execPath, exists: (p) => fs.existsSync(p) })
  return npm === null ? null : installedLauncher(npm, { timeoutMs: NPM_ROOT_TIMEOUT_MS })
}

/** Refuses a git checkout bundle as the hook entry unless dev is set; the error names the global entry. */
export function assertHookEntryAllowed(entryPath: string | undefined, opts: { dev: boolean; globalEntry?: () => string | null }): void {
  if (opts.dev || !isDevCheckoutEntry(entryPath)) return
  const installed = (opts.globalEntry ?? globalEntryPath)()
  const instead = installed === null ? 'the npm global install (npm install -g token-goat)' : `node ${quotedArg(installed)} install`
  throw new Error(`refusing to register ${entryPath} as the hook entry: it runs from a git checkout. Run ${instead} instead, or pass --dev to register this checkout on purpose.`)
}
