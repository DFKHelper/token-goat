/** In-process hook library entry point. Bundled separately from `src/main.ts` (see `esbuild.config.mjs`'s second build step, output `dist/token-goat-hook.mjs`) specifically so it can be `import()`-ed by a bridge shim or a long-lived plugin host (OpenClaw, opencode, pi, and the Codex/Claude Code/Copilot CLI shim scripts) without triggering `main.ts`'s top-level `run()` call, which parses `process.argv` as CLI arguments as a side effect of merely loading the module. Importing this file instead pulls in the hook registry (via `./relay.js`) with zero side effects beyond registering handlers, and exposes exactly the one function those callers need: {@link relayInProcess}. */

import { limitDbWaitsForHook } from './db.js'
import { relayInProcess as relayHookEvent } from './relay.js'

/** Handle one hook event in this process. Every process that imports this library does nothing but run hooks, and a hook is the agent's tool call, so the first call switches the process to the short database waits of `limitDbWaitsForHook` rather than the 15 s a worker waits. The resident hook server imports `./relay.js` directly and switches its connections per hook request instead (hook_server.ts), because it also serves CLI requests. */
export const relayInProcess: typeof relayHookEvent = (...args) => {
  limitDbWaitsForHook()
  return relayHookEvent(...args)
}
