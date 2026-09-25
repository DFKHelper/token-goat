/** The shim fragment that hands a hook call to the resident hook server. Kept apart from shim_common.ts, which re-exports it, because Copilot CLI's bridge is on the hook library's load path and interpolates this one fragment: importing it from shim_common.ts made every other shim template part of what each hook call parses. */

/** `tryServer()`: hand the call to a resident token-goat process through the sibling `dist/token-goat-hook-client.mjs`. Shared by every shim, including Copilot CLI's, which interpolates it on its own. */
export const SHIM_TRY_SERVER = `// Attempts the resident hook server (src/hook_server.ts): the sibling token-goat-hook-client.mjs
// sends this call to an already-running token-goat process, so neither Node's module loading
// nor the hook graph is paid for again. It returns undefined whenever nothing was dispatched --
// no server yet (it starts one in the background), all busy, replaced by a newer build, turned
// off, or an install predating the client -- and the caller then runs the call itself.
async function tryServer(entryPath, eventName, input, harnessWaitMs) {
  if (!entryPath) return undefined
  try {
    const clientPath = path.join(path.dirname(entryPath), 'token-goat-hook-client.mjs')
    if (!require('node:fs').existsSync(clientPath)) return undefined
    const client = await import(pathToFileURL(clientPath).href)
    return await client.relayViaServer(eventName, input, harnessWaitMs)
  } catch {
    return undefined
  }
}`
