/**
 * pi (pi-coding-agent) extension bridge.
 *
 * This file's content is the canonical source for the pi extension token-goat
 * installs at `~/.pi/agent/extensions/token-goat.ts` (global) or
 * `<project>/.pi/extensions/token-goat.ts` (`--local` -- README's "pi users"
 * section and "What gets installed?" table both agree on this project-local
 * path -- no `agent/` segment, unlike the global path). {@link installPi} in
 * `./pi_install.js` writes {@link PI_EXTENSION_SCRIPT} to disk verbatim; there is
 * no per-entry merge like Codex's TOML hooks block, since pi loads one whole
 * file as a normal extension module.
 *
 * Origin: this was first authored directly at the repo-root path
 * `.pi/extensions/token-goat.ts` (commit 9a85f780, "feat(pi): add pi-coding-agent
 * extension bridge"), then embedded here verbatim when wired into
 * `token-goat install`. That original template called `token-goat hook <event>`
 * with invented per-tool-type event names (`pre-read`, `post-bash`,
 * `session-start`, `pre-compact`) that don't exist in the real HOOK_EVENTS
 * vocabulary (`src/types.ts`) under any spelling; `relay()` (`src/relay.ts`)
 * silently returns `{}` for any unrecognized event name via `isHookEventName()`,
 * so every hook call the original template made was a complete no-op. The
 * script below has been corrected to speak the real generic
 * `pre_tool_use`/`post_tool_use` protocol (tool name carried in the payload,
 * not baked into the event name) instead, matching how `codex.ts`,
 * `gemini_install.ts`, and `opencode.ts` already bridge the same protocol.
 *
 * pi's extension API: a default-exported factory `(pi: ExtensionAPI) => void`
 * that subscribes to `session_start`, `tool_call`, `tool_result`,
 * `session_before_compact`, and `session_compact`.
 *
 * `token-goat hook <event>` only accepts the exact snake_case event names in
 * HOOK_EVENTS: `pre_tool_use`, `post_tool_use`, `pre_compact`, `session_start`,
 * `notification`, `stop`, `user_prompt_submit`, `subagent_stop`.
 *
 * Response contract from `token-goat hook <event>` (`src/hook_registry.ts`
 * `serializeOutput`), mirrored by `opencode.ts`'s plugin:
 *   - deny:   `{"decision":"block","reason":"..."}`
 *   - context (pre_compact): `{"systemMessage":"..."}`
 *   - context (other events): `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`
 *   - rewriteInput (pre_tool_use only, e.g. Bash command compression):
 *     `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...}}}`
 *   - pass: `{}`
 * pi's `tool_call` handler bridges this into pi's own `{block, reason}` /
 * in-place `input` mutation contract. What works, matching README's "pi
 * users" section: bash output compression and confirmed re-read denial (both
 * reach pi's existing `{block, reason}` / arg-rewrite contract directly),
 * image shrinking (the `additionalContext` data-URL payload is decoded and
 * materialized to a temp file, then the read path is rewritten to point at
 * it, mirroring `opencode.ts`), post-edit indexing and output caching (plain
 * `post_tool_use` calls), and the compaction manifest. A plain
 * `additionalContext` hint with no `updatedInput` and no image payload (e.g.
 * a first-read large-file nudge) has no surfacing channel in pi's extension
 * API and is silently dropped -- pi has no equivalent of Claude Code's
 * non-blocking `additionalContext` injection outside a tool-arg rewrite.
 */
export const PI_EXTENSION_SCRIPT = `// token-goat bridge extension for pi (pi-coding-agent)
// Bridges pi's extension events to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// pi built-in tool names -> token-goat internal tool names
const TOOL_TO_TG: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
};

// pi tool args (camelCase/short) -> token-goat snake_case tool_input keys
const ARGS_TO_TG: Record<string, Record<string, string>> = {
  read: { path: "file_path", offset: "offset", limit: "limit" },
  bash: { command: "command", timeout: "timeout" },
  edit: { path: "file_path" },
  write: { path: "file_path" },
  grep: { pattern: "pattern", path: "path" },
  find: { pattern: "pattern", path: "path" },
};

// Tools that have a pre-hook (read/search/fetch types only).
// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "WebFetch"]);

function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = spawnSync("token-goat", ["hook", event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = r.stdout?.trim();
    if (!out) return null;
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function reverseArgMap(tool: string): Record<string, string> {
  const fwd = ARGS_TO_TG[tool] ?? {};
  return Object.fromEntries(Object.entries(fwd).map(([piKey, tgKey]) => [tgKey, piKey]));
}

function toToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const argMap = ARGS_TO_TG[tool] ?? {};
  const out: Record<string, unknown> = {};
  for (const [piKey, tgKey] of Object.entries(argMap)) {
    if (input[piKey] !== undefined) out[tgKey] = input[piKey];
  }
  return out;
}

// Pull the additionalContext / systemMessage string out of a hook response,
// whichever shape it came back as (see the response-contract note in this
// module's header comment).
function extractContext(resp: Record<string, unknown>): string | undefined {
  const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
  if (hso && typeof hso["additionalContext"] === "string") return hso["additionalContext"] as string;
  if (typeof resp["systemMessage"] === "string") return resp["systemMessage"] as string;
  return undefined;
}

function extractUpdatedInput(resp: Record<string, unknown>): Record<string, unknown> | undefined {
  const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso ? (hso["updatedInput"] as Record<string, unknown> | undefined) : undefined;
}

// Decode a token-goat image-shrink additionalContext payload
// ("<summary>\\ndata:image/<fmt>;base64,<data>") into a real file on disk,
// since pi's tool_call handler has no context-injection channel -- only
// in-place arg mutation. Returns undefined (leaving the read path untouched)
// if the context isn't a shrink payload or anything goes wrong writing it.
function materializeShrunkImage(context: string | undefined): string | undefined {
  if (typeof context !== "string") return undefined;
  const idx = context.indexOf("data:image/");
  if (idx === -1) return undefined;
  const match = /^data:image\\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(context.slice(idx).trim());
  if (!match) return undefined;
  try {
    const buf = Buffer.from(match[2], "base64");
    const name = \`token-goat-shrink-\${process.pid}-\${Date.now()}-\${Math.random().toString(36).slice(2)}.\${match[1]}\`;
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // Stable per-session id derived from pi's session file (filesystem-safe), or
  // a process-scoped fallback for ephemeral sessions. Recomputed on every
  // session_start (new / resume / fork all re-fire it).
  let sessionId = \`pi-\${process.pid}\`;
  let cwd = process.cwd();
  // Manifest captured at session_before_compact, injected after compaction.
  let pendingManifest: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    const file = ctx.sessionManager?.getSessionFile?.();
    sessionId = file ? \`pi-\${file.replace(/[^A-Za-z0-9._-]/g, "_")}\` : \`pi-\${process.pid}\`;
    callHook("session_start", { session_id: sessionId, cwd });
  });

  pi.on("tool_call", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg || !PRE_HOOK_TOOLS.has(tg)) return;

    const input = event.input as Record<string, unknown>;
    const resp = callHook("pre_tool_use", {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, input),
      cwd,
    });
    if (!resp) return;

    // Deny: block the tool call with a reason (e.g. confirmed re-read).
    if (resp["decision"] === "block") {
      return {
        block: true,
        reason: (resp["reason"] as string) ?? "blocked by token-goat",
      };
    }

    // Rewrite: update tool args in place (e.g. compressed bash command).
    // token-goat returns its own snake_case keys; map them back.
    const updated = extractUpdatedInput(resp);
    if (updated) {
      const rev = reverseArgMap(event.toolName);
      for (const [tgKey, val] of Object.entries(updated)) {
        input[rev[tgKey] ?? tgKey] = val;
      }
      return;
    }

    // Image shrink has no context channel here -- translate it into a
    // rewritten path pointing at a materialized shrunk copy instead.
    if (tg === "Read") {
      const shrunkPath = materializeShrunkImage(extractContext(resp));
      if (shrunkPath) input["path"] = shrunkPath;
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg) return;
    callHook("post_tool_use", {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, (event.input ?? {}) as Record<string, unknown>),
      cwd,
    });
  });

  // Compaction: pi's session_before_compact REPLACES the summary rather than
  // appending to it (unlike opencode's additive output.context). So capture the
  // token-goat manifest here, let pi build its own summary, then inject the
  // manifest as a post-compaction message that survives into the new context
  // window. This preserves the edited-file / symbol manifest within pi's
  // replace-only compaction model.
  pi.on("session_before_compact", async (_event, _ctx) => {
    const resp = callHook("pre_compact", { session_id: sessionId, trigger: "auto" });
    pendingManifest = resp?.["systemMessage"] as string | undefined;
  });

  pi.on("session_compact", async (_event, _ctx) => {
    if (pendingManifest) {
      pi.sendMessage(
        { customType: "token-goat-manifest", content: pendingManifest, display: false },
        { deliverAs: "nextTurn" },
      );
      pendingManifest = undefined;
    }
  });
}
`
