/** The shim fragment that hands a hook call to the resident hook server. Kept apart from shim_common.ts, which re-exports it, because Copilot CLI's bridge is on the hook library's load path and interpolates this one fragment: importing it from shim_common.ts made every other shim template part of what each hook call parses. */

/** `tryServer()`: hand the call to a resident token-goat process through the sibling `dist/token-goat-hook-client.cjs`, or the `.mjs` build of the same client when an older install has no `.cjs`. Shared by every shim, including Copilot CLI's, which interpolates it on its own. */
export const SHIM_TRY_SERVER = `// Attempts the resident hook server (src/hook_server.ts): the sibling hook client sends this
// call to an already-running token-goat process, so neither Node's module loading nor the hook
// graph is paid for again. The CommonJS client comes first: this shim is CommonJS, and loading
// the ES module one starts Node's ESM loader, about 5ms of a call the server answers. The ES
// module one is for an install built before the CommonJS file existed. It returns undefined
// whenever nothing was dispatched -- no server yet (it starts one in the background), all busy,
// replaced by a newer build, turned off, or an install predating the client -- and the caller
// then runs the call itself.
async function tryServer(entryPath, eventName, input, harnessWaitMs) {
  if (!entryPath) return undefined
  try {
    const fs = require('node:fs')
    const cjsPath = path.join(path.dirname(entryPath), 'token-goat-hook-client.cjs')
    const mjsPath = path.join(path.dirname(entryPath), 'token-goat-hook-client.mjs')
    const client = fs.existsSync(cjsPath) ? require(cjsPath) : fs.existsSync(mjsPath) ? await import(pathToFileURL(mjsPath).href) : undefined
    if (client === undefined) return undefined
    return await client.relayViaServer(eventName, input, harnessWaitMs)
  } catch {
    return undefined
  }
}`
