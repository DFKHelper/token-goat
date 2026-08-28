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
 * HOOK_EVENTS: `pre_tool_use`, `post_tool_use`, `pre_compact`,
 * `notification`, `stop`, `user_prompt_submit`, `subagent_stop`.
 *
 * Response contract from `token-goat hook <event>` (`src/hook_registry.ts`
 * `serializeOutput`), mirrored by `opencode.ts`'s plugin:
 *   - deny:   `{"decision":"block","reason":"..."}`
 *   - context (pre_compact): `{"systemMessage":"..."}`
 *   - context (other events): `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`
 *   - rewriteInput (pre_tool_use only, e.g. Bash command compression):
 *     `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...}}}`
 *   - rewriteOutput (post_tool_use only, e.g. WebFetch fencing/redaction, output compression):
 *     `{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"..."}}`
 *   - pass: `{}`
 *
 * That list is the complete producer set from `serializeOutput`, on purpose: an earlier
 * revision enumerated only four of the five shapes and the missing one (rewriteOutput)
 * shipped dead, the same whitelist-shaped drop fixed for the opencode plugin.
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
import { spawnSync } from "node:child_process"
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// pi built-in tool names -> token-goat internal tool names. powershell is pi's Windows shell twin of bash -- same input schema (PowerShellToolInput = BashToolInput, i.e. command/timeout) and registered under its own name (badlogic/pi-mono packages/coding-agent/src/core/tools/powershell.ts + tools/index.ts's ToolName union). Unmapped, every shell command in a powershell-tool pi session bypassed the Bash hooks entirely, the same shape as the Copilot shim's bash/powershell pairing.
const TOOL_TO_TG: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  powershell: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
};

// pi tool args (camelCase/short) -> token-goat snake_case tool_input keys
const ARGS_TO_TG: Record<string, Record<string, string>> = {
  read: { path: "file_path", offset: "offset", limit: "limit" },
  bash: { command: "command", timeout: "timeout" },
  powershell: { command: "command", timeout: "timeout" },
  edit: { path: "file_path" },
  write: { path: "file_path" },
  grep: { pattern: "pattern", path: "path" },
  find: { pattern: "pattern", path: "path" },
};

// Tools with a pre-hook whose output shape this extension can act on: deny ({block}), updatedInput (in-place arg rewrite), or the Read image-shrink materialization. Glob's pre handler (preGlobDedupHandler in hooks_glob.ts -- the old claim here that Glob has no pre handler was stale) emits only an advisory contextOutput hint, which pi's tool_call contract has no channel for (see the module docblock), so calling it would cost a hook call per find only to drop the answer; it stays excluded for that reason.
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Bash", "WebFetch"]);

// resolveEntryPath reads a sidecar JSON file (token-goat-entry.json, written by
// installPi next to this extension file) containing the absolute path to the
// token-goat CLI entry that was running at install time. Unlike Codex/Copilot,
// this extension has no per-invocation command line to bake a path into (pi
// loads it once as a module, then calls into it via pi.on(...) handlers), so
// the sidecar file is the install-time channel for this value instead. Returns
// undefined (triggering the PATH-based fallback below) if the sidecar is
// missing, unreadable, or points at a path that no longer exists -- e.g. an
// older install predating this file, or a moved/removed token-goat install.
function resolveEntryPath(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sidecarPath = path.join(here, "token-goat-entry.json");
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { entryPath?: unknown };
    if (typeof parsed.entryPath === "string" && parsed.entryPath && fs.existsSync(parsed.entryPath)) {
      return parsed.entryPath;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

// import()s dist/token-goat-hook.mjs (a sibling of the baked token-goat entry path,
// built with zero load-time side effects -- unlike the CLI entry, which runs the full
// argv-parsing CLI as a side effect of being loaded) and returns its exported
// relayInProcess() function, so callHook can call straight into the hook registry
// instead of spawnSync-ing a whole second node process for every single hook call in
// this long-lived agent process. Cached after the first successful resolution (the
// module itself is cached by Node's ESM loader on repeat import() calls of the same
// URL, so this mainly avoids repeat fs.existsSync/sidecar-read overhead). Returns
// undefined (triggering the spawnSync fallback below) when entryPath is absent, the
// sibling file doesn't exist (an install predating this file), or anything else goes
// wrong -- this must never throw.
type RelayInProcessFn = (event: string, payload: unknown) => Promise<string>;
let cachedRelayInProcess: RelayInProcessFn | undefined;
async function resolveRelayInProcess(): Promise<RelayInProcessFn | undefined> {
  if (cachedRelayInProcess) return cachedRelayInProcess;
  const entryPath = resolveEntryPath();
  if (!entryPath) return undefined;
  try {
    const hookLibPath = path.join(path.dirname(entryPath), "token-goat-hook.mjs");
    if (!fs.existsSync(hookLibPath)) return undefined;
    const mod = (await import(pathToFileURL(hookLibPath).href)) as { relayInProcess?: unknown };
    if (typeof mod.relayInProcess !== "function") return undefined;
    cachedRelayInProcess = mod.relayInProcess as RelayInProcessFn;
    return cachedRelayInProcess;
  } catch {
    return undefined;
  }
}

function callHookViaSpawn(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    // TOKEN_GOAT_HARNESS_OVERRIDE=pi guarantees detectHarness() resolves to
    // 'pi' for every call this bridge makes, instead of relying on a guessed
    // ambient env var pi-coding-agent may or may not set.
    //
    // Invoking "token-goat" as a bare command here depends on PATH resolution
    // (the npm global bin being on whatever PATH pi-coding-agent's own process
    // inherits) -- the same class of single-point-of-failure fixed for the
    // Codex/Copilot CLI bridges' hook commands. When resolveEntryPath() finds a
    // baked install-time path, invoke it directly via process.execPath instead,
    // sidestepping PATH entirely; otherwise fall back to the old PATH-based
    // lookup (e.g. an extension installed before this fix).
    const entryPath = resolveEntryPath();
    const r = entryPath
      ? spawnSync(process.execPath, [entryPath, "hook", event], {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
          windowsHide: true,
          env: { ...process.env, TOKEN_GOAT_HARNESS_OVERRIDE: "pi" },
        })
      : spawnSync('token-goat hook ' + event, {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
          shell: true,
          windowsHide: true,
          env: { ...process.env, TOKEN_GOAT_HARNESS_OVERRIDE: "pi" },
        });
    if (r.error) return null;
    const out = r.stdout?.trim();
    if (!out) return null;
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Tries the in-process hook call first (resolveRelayInProcess above), which avoids
// spawning a second node process altogether for every single tool call in this
// long-lived agent process. Falls back to callHookViaSpawn (the original
// spawnSync-based path, now with a 3000ms timeout/killSignal so token-goat degrades to
// its own fail-open null rather than being force-killed by pi's own hook timeout
// budget, ~5000ms) when the in-process path is unavailable or throws.
async function callHook(event: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const relay = await resolveRelayInProcess();
  if (relay) {
    try {
      process.env.TOKEN_GOAT_HARNESS_OVERRIDE = "pi";
      const out = await relay(event, payload);
      const trimmed = out?.trim();
      if (!trimmed) return null;
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // fall through to the spawnSync fallback below
    }
  }
  return callHookViaSpawn(event, payload);
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
// Best-effort sweep of previously materialized shrunk copies in the OS temp dir: typed twin of pruneMaterializedShrinks in shrink_block.ts (MATERIALIZE_SHRUNK_IMAGE_JS), which documents why pi keeps its own copy. The temp file only needs to outlive the single tool call whose path was rewritten to it, so anything older than an hour is finished with; the "token-goat-shrink-" prefix check confines the sweep to this mechanism's own files.
const MATERIALIZED_SHRINK_MAX_AGE_MS = 60 * 60 * 1000;
let lastMaterializedShrinkSweepAtMs = 0;
function pruneMaterializedShrinks(): void {
  const now = Date.now();
  if (now - lastMaterializedShrinkSweepAtMs < MATERIALIZED_SHRINK_MAX_AGE_MS) return;
  lastMaterializedShrinkSweepAtMs = now;
  try {
    const dir = os.tmpdir();
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith("token-goat-shrink-")) continue;
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now - st.mtimeMs > MATERIALIZED_SHRINK_MAX_AGE_MS) fs.unlinkSync(full);
      } catch {
        // Best-effort per-file cleanup; one bad stat/unlink must not abort the sweep.
      }
    }
  } catch {
    // Best-effort; a readdir failure must never break the materialization below.
  }
}

function materializeShrunkImage(context: string | undefined): string | undefined {
  if (typeof context !== "string") return undefined;
  const idx = context.indexOf("data:image/");
  if (idx === -1) return undefined;
  const match = /^data:image\\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(context.slice(idx).trim());
  if (!match) return undefined;
  try {
    pruneMaterializedShrinks();
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

  // No forwarding callHook for session_start here (there used to be one):
  // token-goat retired the session_start hook -- it only ever reached a
  // permanent no-op handler (see the removal in src/hooks_session.ts and
  // src/types.ts). This subscription is kept regardless, because it's pi's
  // own lifecycle event and is still needed to refresh sessionId/cwd for
  // every other bridged call below.
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    const file = ctx.sessionManager?.getSessionFile?.();
    sessionId = file ? \`pi-\${file.replace(/[^A-Za-z0-9._-]/g, "_")}\` : \`pi-\${process.pid}\`;
  });

  pi.on("tool_call", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg || !PRE_HOOK_TOOLS.has(tg)) return;

    const input = event.input as Record<string, unknown>;
    const resp = await callHook("pre_tool_use", {
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
    // event.content is tool_result's real output field (ToolResultEventBase.content:
    // (TextContent | ImageContent)[] -- verified against pi's own
    // core/extensions/types.ts). Join the text blocks into a single string so
    // extractReadOutput's truncation-marker detection (which only recognizes a
    // string tool_response.output) can see it, mirroring opencode.ts's
    // tool_response: { output } shape.
    const contentBlocks = Array.isArray(event.content) ? event.content : [];
    const output = contentBlocks
      .filter((c: { type?: string }) => c && c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\\n");
    const resp = await callHook("post_tool_use", {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, (event.input ?? {}) as Record<string, unknown>),
      cwd,
      tool_response: { output },
    });
    if (!resp) return;

    // rewriteOutput: replace the tool result the model sees. pi's tool_result handler CAN modify the result: its own types declare "Fired after a tool executes. Can modify result." over ToolResultEvent and a ToolResultEventResult of { content, details, isError, usage }, and the shipped runtime applies it (dist/core/extensions/runner.js emitToolResult assigns handlerResult.content onto the event, and dist/core/agent-session.js afterToolCall returns hookResult.content as the tool result content). Without this, injection fencing, secret redaction and output compression were computed and thrown away on every pi session, the same whitelist-shaped drop fixed for opencode.
    const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
    const updatedToolOutput = hso && typeof hso["updatedToolOutput"] === "string" ? (hso["updatedToolOutput"] as string) : undefined;
    if (updatedToolOutput === undefined) return;

    // Replace only the text blocks, in place, and keep every non-text block (images) untouched: emitToolResult overwrites content wholesale, so anything not carried here is dropped from what the model sees. details/isError/usage are deliberately not returned, since runner.js only overwrites the fields a handler actually provides.
    const rewritten: typeof contentBlocks = [];
    let replaced = false;
    for (const block of contentBlocks) {
      const isText = Boolean(block) && (block as { type?: string }).type === "text";
      if (!isText) {
        rewritten.push(block);
        continue;
      }
      if (replaced) continue;
      replaced = true;
      rewritten.push({ type: "text", text: updatedToolOutput });
    }
    if (!replaced) rewritten.push({ type: "text", text: updatedToolOutput });
    return { content: rewritten };
  });

  // Compaction: pi's session_before_compact REPLACES the summary rather than
  // appending to it (unlike opencode's additive output.context). So capture the
  // token-goat manifest here, let pi build its own summary, then inject the
  // manifest as a post-compaction message that survives into the new context
  // window. This preserves the edited-file / symbol manifest within pi's
  // replace-only compaction model.
  pi.on("session_before_compact", async (_event, _ctx) => {
    const resp = await callHook("pre_compact", { session_id: sessionId, trigger: "auto" });
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
