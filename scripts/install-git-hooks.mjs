/**
 * `prepare` hook: wire up lefthook's git hooks for a development checkout.
 *
 * Runs `lefthook install` when lefthook is actually present, and skips quietly when it isn't.
 *
 * The skip matters because npm runs `prepare` for more than the dev-checkout case it was added
 * for. `npm install -g .` runs it in a context without this project's node_modules/.bin on PATH,
 * so a bare `lefthook install` dies with "'lefthook' is not recognized" and fails the global
 * install that CLAUDE.md prescribes as the dogfood step for every CLI/hook change. Installing
 * token-goat as a dependency has the same shape: no devDependencies, and no git repo to hook.
 *
 * Skipping is deliberately conditioned on lefthook being *absent*, not on the command failing.
 * A developer whose `lefthook install` genuinely breaks still gets a hard error, because these
 * hooks were decorative once already -- configured in lefthook.yml but never installed, so every
 * guard in it silently did nothing -- and swallowing failures here is how that recurs.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Absolute path to the lefthook CLI shim, or null when lefthook isn't installed here.
 *
 * Looks for npm's own `.bin` shim rather than resolving the package, because the shim is what
 * npm creates for a devDependency and it is the exact thing missing in the contexts we skip.
 * `.cmd` first: on Windows the extensionless file is a shell script Node can't spawn directly.
 */
function findLefthookBin(startDir) {
  const binDir = path.join(startDir, 'node_modules', '.bin')
  for (const name of ['lefthook.cmd', 'lefthook']) {
    const candidate = path.join(binDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = findLefthookBin(projectRoot)

if (bin === null) {
  // Not a dev checkout with lefthook installed: a global install, a published-package install, or
  // a pack/prepare temp dir. Nothing to wire up and nothing wrong -- exit 0 so the install works.
  process.exit(0)
}

// npm's Windows shim is a .cmd batch file, which Node refuses to spawn without a shell. Quote the
// path in that case, since `shell: true` re-parses the command string and the path can contain
// spaces (a checkout under "C:\Program Files", a user profile with a space in the name).
const needsShell = /\.(cmd|bat)$/i.test(bin)
const result = spawnSync(needsShell ? `"${bin}"` : bin, ['install'], {
  stdio: 'inherit',
  shell: needsShell,
})
process.exit(result.status ?? 1)
