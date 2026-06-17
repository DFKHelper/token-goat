// token-goat bridge extension for pi (pi-coding-agent)
// Bridges pi's extension events to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

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

// Post-call hook event per token-goat tool name
const POST_HOOK: Record<string, string> = {
  Read: "post-read",
  Grep: "post-read",
  Glob: "post-read",
  Bash: "post-bash",
  WebFetch: "post-fetch",
  Edit: "post-edit",
  Write: "post-edit",
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

export default function (pi: ExtensionAPI) {
  // Stable per-session id derived from pi's session file (filesystem-safe), or
  // a process-scoped fallback for ephemeral sessions. Recomputed on every
  // session_start (new / resume / fork all re-fire it).
  let sessionId = `pi-${process.pid}`;
  let cwd = process.cwd();
  // Manifest captured at session_before_compact, injected after compaction.
  let pendingManifest: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    const file = ctx.sessionManager?.getSessionFile?.();
    sessionId = file ? `pi-${file.replace(/[^A-Za-z0-9._-]/g, "_")}` : `pi-${process.pid}`;
    callHook("session-start", { session_id: sessionId, cwd });
  });

  pi.on("tool_call", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg || !PRE_HOOK_TOOLS.has(tg)) return;

    const input = event.input as Record<string, unknown>;
    const hookEvent = tg === "WebFetch" ? "pre-fetch" : "pre-read";
    const resp = callHook(hookEvent, {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, input),
      cwd,
    });
    if (!resp) return;

    const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
    if (!hso) return;

    // Deny: block the tool call with a reason (e.g. confirmed re-read).
    if (hso["permissionDecision"] === "deny") {
      return {
        block: true,
        reason: (hso["permissionDecisionReason"] as string) ?? "blocked by token-goat",
      };
    }

    // Update: rewrite tool args in place (e.g. image-shrunk path, compressed
    // bash command). token-goat returns its own snake_case keys; map them back.
    const updated = hso["updatedInput"] as Record<string, unknown> | undefined;
    if (updated) {
      const rev = reverseArgMap(event.toolName);
      for (const [tgKey, val] of Object.entries(updated)) {
        input[rev[tgKey] ?? tgKey] = val;
      }
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg) return;
    callHook(POST_HOOK[tg] ?? "post-read", {
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
    const resp = callHook("pre-compact", { session_id: sessionId, trigger: "auto" });
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
