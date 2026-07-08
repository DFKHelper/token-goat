/**
 * OpenClaw bridge plugin.
 *
 * OpenClaw uses an in-process TypeScript plugin system (not a subprocess-hook
 * config format like Codex/Gemini): a `.ts` file registered in
 * `~/.openclaw/openclaw.json`, loaded and executed by the OpenClaw gateway
 * itself. This template is dropped onto disk verbatim by
 * `./openclaw_install.ts`'s {@link installOpenclaw}; it is never imported or
 * executed by token-goat itself.
 *
 * Verified against two independent sources:
 *  - A live fetch of docs.openclaw.ai/plugins/hooks, /plugins/sdk-setup, and
 *    the gateway configuration reference (this session): confirms
 *    `before_tool_call`/`after_tool_call` exist with the exact
 *    block/rewrite-params shape used below, `definePluginEntry` is the real
 *    registration entry point, and `plugins.load.paths` + `plugins.entries.<id>`
 *    (no `path` field -- the plugin's own declared `id` is the join key) is
 *    the current two-part config schema `./openclaw_install.ts` writes.
 *  - An earlier, independent verification against OpenClaw's own
 *    `aristotle-agent/types.ts` source (prior session, `reference-openclaw-api`
 *    memory): confirms `register()` must be synchronous (`api.on()` handlers
 *    may be async), the `before_tool_call` event shape
 *    (`{toolName, toolCallId, params}`), and -- most importantly -- that
 *    `event.params` keys are **already snake_case** (`file_path`, `command`,
 *    etc.), matching token-goat's own `tool_input` convention exactly. That is
 *    why, unlike every other bridge in this directory (Gemini, Codex, pi),
 *    there is no `ARGS_TO_TG` key-remapping table here: `event.params` is
 *    forwarded to `tool_input` unchanged. Blindly adding a remap table for an
 *    already-correct key is exactly the bug the Gemini bridge shipped with
 *    initially (`GEMINI_INPUT_KEY_MAP` renamed an already-correct `file_path`
 *    to `path`, silently corrupting every real Read/Write/Edit call) -- not
 *    repeating that here is a deliberate, evidence-based choice.
 *
 * What's still genuinely unverified against a live OpenClaw instance (no
 * instance was available this pass -- see README's "openclaw users" section
 * and this bridge's own follow-up note): the exact current built-in tool-name
 * list (the two sources above disagree slightly -- `grep`/`glob`/`webfetch`/
 * `apply_patch` per the older source vs. `web_search`/`web_fetch` per the
 * fresher docs; TOOL_TO_TG below includes both, since an unmatched key is
 * harmless no-op, not a wrong guess), and whether tool-call context (`ctx`)
 * actually carries a stable per-session identifier (the older source says
 * OpenClaw "has no session concept"; this session's fresh research found
 * `ctx.sessionId`/`ctx.sessionKey` on general agent hook contexts -- both are
 * tried below, falling back to a per-process pseudo-id if neither is present).
 *
 * Compaction hooks (`before_compaction`/`after_compaction`) are
 * observation-only in OpenClaw's SDK: there is no return-value channel to
 * inject a manifest into the next turn the way pi's `session_compact` ->
 * `pi.sendMessage(...)` does. This bridge still calls `pre_compact` so
 * token-goat's own session-cache bookkeeping stays in sync with real
 * compaction events, but it cannot re-inject a manifest.
 */

export const OPENCLAW_PLUGIN_SCRIPT = `// token-goat bridge plugin for OpenClaw
// Bridges OpenClaw's tool-call and session hooks to token-goat's subprocess
// hook protocol. https://github.com/DFKHelper/token-goat
//
// NOTE ON PARAMETER SHAPES: OpenClaw's tool-call params are forwarded to
// token-goat's tool_input unchanged (no key remapping) -- verified against
// OpenClaw's own event-type source that these keys are already snake_case
// (file_path, command, etc.), matching token-goat's own convention. The
// built-in tool NAME list below is broader than any single source confirms,
// since an unmatched name is a harmless no-op here, not a wrong rewrite.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawnSync } from "node:child_process";

// OpenClaw built-in tool names -> token-goat internal tool names.
const TOOL_TO_TG = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  exec: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  web_search: "WebFetch",
  web_fetch: "WebFetch",
};

// Tools with a registered pre_tool_use handler in token-goat (Edit/Write have
// none; Glob has none either -- see pi.ts/opencode.ts's identical
// PRE_HOOK_TOOLS note -- so it's excluded to avoid a wasted no-op spawn).
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Bash", "WebFetch"]);

function callHook(event, payload) {
  try {
    const r = spawnSync("token-goat", ["hook", event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = r.stdout ? r.stdout.trim() : "";
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

export default definePluginEntry({
  id: "token-goat",
  name: "token-goat",
  description:
    "Bridges OpenClaw's tool-call and session hooks to token-goat's read-hinting, bash compression, and index-refresh pipeline.",
  register(api) {
    // No confirmed stable per-session id on tool-call context (see module
    // header) -- fall back to a per-process pseudo-id if ctx carries none.
    let sessionId = \`openclaw-\${process.pid}-\${Date.now()}\`;

    api.on("session_start", (event, ctx) => {
      sessionId = (ctx && (ctx.sessionId || ctx.sessionKey)) || sessionId;
    });

    // No forwarding callHook for session_start here (there used to be one):
    // token-goat retired the session_start hook -- it only ever reached a
    // permanent no-op handler (see the removal in src/hooks_session.ts and
    // src/types.ts). The subscription above is kept regardless, because it's
    // OpenClaw's own lifecycle event and is still needed to refresh
    // sessionId for every other bridged call below.

    // No api.on("session_end", ...) here: token-goat's own HOOK_EVENTS
    // (src/types.ts) has no session_end member, so calling it would be the
    // same invented-event-name no-op already found and fixed once for pi's
    // bridge (commit 2f0a15e4). OpenClaw's session_end is a real lifecycle
    // event, but token-goat has no corresponding hook to bridge it to.

    api.on("before_tool_call", async (event, ctx) => {
      const tg = TOOL_TO_TG[event.toolName];
      if (!tg || !PRE_HOOK_TOOLS.has(tg)) return {};

      const sid = (ctx && (ctx.sessionId || ctx.sessionKey)) || sessionId;
      const resp = callHook("pre_tool_use", {
        session_id: sid,
        tool_name: tg,
        tool_input: event.params || {},
        cwd: process.cwd(),
      });
      if (!resp) return {};

      // Deny: block the tool call with a reason (e.g. confirmed re-read).
      if (resp["decision"] === "block") {
        return { block: true, blockReason: resp["reason"] || "blocked by token-goat" };
      }

      // Rewrite: token-goat returns its own snake_case tool_input keys, which
      // are already OpenClaw's native param shape (see module header) -- no
      // reverse-mapping needed, just merge over the original params.
      const hso = resp["hookSpecificOutput"];
      const updated = hso ? hso["updatedInput"] : undefined;
      if (updated) {
        return { params: { ...(event.params || {}), ...updated } };
      }

      return {};
    });

    api.on("after_tool_call", (event, ctx) => {
      const tg = TOOL_TO_TG[event.toolName];
      if (!tg) return;
      const sid = (ctx && (ctx.sessionId || ctx.sessionKey)) || sessionId;
      // event.result's shape is unverified against a live OpenClaw instance
      // (see module header) -- token-goat's post_tool_use handlers already
      // accept tool_response as either a raw string or an object keyed by
      // output/content/text/body, so forward it as-is when it's already an
      // object, or wrap a bare string/other value as { output } so those
      // handlers can find it either way, mirroring opencode.ts's and
      // pi.ts's tool_response: { output } shape.
      const toolResponse =
        event.result && typeof event.result === "object" ? event.result : { output: event.result };
      callHook("post_tool_use", {
        session_id: sid,
        tool_name: tg,
        tool_input: event.params || {},
        cwd: process.cwd(),
        tool_response: toolResponse,
      });
    });

    // Observation-only: no manifest-reinjection channel exists here (see
    // module header). This keeps token-goat's own session bookkeeping in
    // sync with real compaction events.
    api.on("before_compaction", (event, ctx) => {
      const sid = (ctx && (ctx.sessionId || ctx.sessionKey)) || sessionId;
      callHook("pre_compact", { session_id: sid, trigger: "auto" });
    });
  },
});
`
