/**
 * In-process hook library entry point.
 *
 * Bundled separately from `src/main.ts` (see `esbuild.config.mjs`'s second
 * build step, output `dist/token-goat-hook.mjs`) specifically so it can be
 * `import()`-ed by a bridge shim or a long-lived plugin host (OpenClaw,
 * opencode, pi, and the Codex/Claude Code/Copilot CLI shim scripts) without
 * triggering `main.ts`'s top-level `run()` call, which parses `process.argv`
 * as CLI arguments as a side effect of merely loading the module. Importing
 * this file instead pulls in the hook registry (via `./relay.js`) with zero
 * side effects beyond registering handlers, and exposes exactly the one
 * function those callers need: {@link relayInProcess}.
 */

export { relayInProcess } from './relay.js'
