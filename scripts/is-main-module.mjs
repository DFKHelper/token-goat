// Whether a module is the process entry point, for the `if (isMainModule(import.meta.url)) main()` gate at the foot of a script. Built-in modules only.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Plain realpathSync, not .native: it is what Node's ESM loader uses for the entry module, and on Windows with a lowercase drive letter the native form spells the path differently and would not match. A path that cannot be resolved falls back to its absolute form, so a missing argv[1] is a plain "not main" and never a crash.
function realOrResolved(p) {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** @param {string} moduleUrl the caller's import.meta.url @param {string | undefined} [entry] the entry script path as typed, process.argv[1] by default @returns {boolean} true when the caller is the entry module; Node resolves symlinks in import.meta.url but leaves argv[1] as typed (macOS /var and /tmp are links into /private), so both sides are resolved before comparing */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false
  try {
    return realOrResolved(entry) === realOrResolved(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
