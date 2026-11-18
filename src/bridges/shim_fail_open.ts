/** The two things every hook shim does before its own work, so that no failure outside the shim's own try/catch can break the host: it finds the bundle entry when the one baked into the hook command is gone, and it answers the harness's safe answer, exit 0, on any uncaught exception, unhandled rejection or broken stdout. The safe answer is a JS expression because Grok's depends on the event. */

/** Resolves a baked entry that no longer exists through the `hook-entry.json` install and upgrade write beside the shim (a copy of `<dataDir>/hook-entry.json`, so the shim reads no home location; src/hook_pointer.ts is its writer and validator, native/tg-hook/src/pointer.rs its Rust reader). Checks the pointer as strictly as the baked path is trusted: absolute, `token-goat.mjs`, an existing regular file, never UNC. Returns the baked path when it exists or nothing better is found. Never throws. */
export const SHIM_RESOLVE_ENTRY = `function tgIsFile(p) {
  try {
    return require('node:fs').statSync(p).isFile()
  } catch {
    return false
  }
}
function resolveEntry(baked) {
  try {
    if (baked && tgIsFile(baked)) return baked
    const file = path.join(__dirname, 'hook-entry.json')
    const fs = require('node:fs')
    if (fs.statSync(file).size > 4096) return baked
    const pointer = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entry = pointer && pointer.schema === 1 ? pointer.entry : undefined
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || entry.startsWith('//') || entry.startsWith('\\\\\\\\')) return baked
    if (entry.split(/[\\\\/]/).includes('..') || path.basename(entry) !== 'token-goat.mjs') return baked
    return tgIsFile(entry) ? entry : baked
  } catch {
    return baked
  }
}
process.argv[3] = resolveEntry(process.argv[3])`

/** Installs the process-wide handlers that turn any escape into safeAnswer and exit 0, written only while nothing has reached stdout yet (a second answer would corrupt the first). */
export function shimFailOpen(safeAnswer: string): string {
  return `function tgFailOpen() {
  try {
    if (!(process.stdout.bytesWritten > 0)) {
      const answer = ${safeAnswer}
      if (answer) {
        process.stdout.write(answer, () => process.exit(0))
        return
      }
    }
  } catch {
    // stdout itself is broken; nothing more can be done here.
  }
  process.exit(0)
}
process.on('uncaughtException', tgFailOpen)
process.on('unhandledRejection', tgFailOpen)
// A host that closed its end of the pipe (EPIPE) is not a hook failure.
process.stdout.on('error', () => process.exit(0))`
}
