// Shared in-process/spawn hook-relay block used verbatim inside the
// generated plugin scripts for opencode (opencode.ts) and OpenClaw
// (openclaw.ts). Both hosts load their generated plugin file as a
// long-lived module (never a per-invocation subprocess), so this logic --
// resolving the install-time entry path, relaying hook calls in-process via
// the sibling token-goat-hook.mjs, and falling back to a spawned "token-goat"
// subprocess when that's unavailable -- is identical between them. pi.ts has
// its own typed copy of the same logic and is intentionally NOT wired to
// this constant (pi's extension host is a real TypeScript compile target,
// and this block is plain untyped JS meant to be dropped verbatim into a
// generated file).
export const BRIDGE_RELAY_JS = `// resolveEntryPath reads a sidecar JSON file (token-goat-entry.json, written by
// the install step next to this plugin file) containing the absolute path to
// the token-goat CLI entry that was running at install time. Unlike
// Codex/Copilot's generated hook commands, this plugin has no per-invocation
// command line to bake a path into (the host loads it once as a module), so
// callHook reads this sidecar at runtime instead, to invoke that entry
// directly via process.execPath rather than depending on PATH resolution for
// a bare "token-goat" lookup -- the same single-point-of-failure class fixed
// for the Codex/Copilot CLI bridges' hook commands and pi's extension
// (resolveEntryPath). Returns undefined (triggering the PATH-based
// shell:true fallback below) if the sidecar is missing, unreadable, or
// points at a path that no longer exists.
function resolveEntryPath() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sidecarPath = path.join(here, "token-goat-entry.json");
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
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
// this long-lived host process. Cached after the first successful resolution (the
// module itself is cached by Node's ESM loader on repeat import() calls of the same
// URL, so this mainly avoids repeat fs.existsSync/sidecar-read overhead). Returns
// undefined (triggering the spawnSync fallback below) when entryPath is absent, the
// sibling file doesn't exist (an install predating this file), or anything else goes
// wrong -- this must never throw.
let cachedRelayInProcess;
async function resolveRelayInProcess() {
  if (cachedRelayInProcess) return cachedRelayInProcess;
  const entryPath = resolveEntryPath();
  if (!entryPath) return undefined;
  try {
    const hookLibPath = path.join(path.dirname(entryPath), "token-goat-hook.mjs");
    if (!fs.existsSync(hookLibPath)) return undefined;
    const mod = await import(pathToFileURL(hookLibPath).href);
    if (typeof mod.relayInProcess !== "function") return undefined;
    cachedRelayInProcess = mod.relayInProcess;
    return cachedRelayInProcess;
  } catch {
    return undefined;
  }
}

function callHookViaSpawn(event, payload) {
  try {
    // Invoking "token-goat" as a bare command here depends on PATH resolution
    // (the npm global bin being on whatever PATH the host process inherits) --
    // on Windows a global npm install resolves "token-goat" to a .cmd/.ps1
    // shim, which spawnSync cannot exec without shell: true. When
    // resolveEntryPath() finds a baked install-time path, invoke it directly
    // via process.execPath instead, sidestepping PATH entirely; otherwise
    // fall back to the old PATH-based lookup with shell: true so a .cmd/.ps1
    // shim still resolves (e.g. an install predating this fix).
    const entryPath = resolveEntryPath();
    const r = entryPath
      ? spawnSync(process.execPath, [entryPath, "hook", event], {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
          windowsHide: true,
        })
      : spawnSync("token-goat hook " + event, {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
          shell: true,
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

// Tries the in-process hook call first (resolveRelayInProcess above), which avoids
// spawning a second node process altogether for every single tool call in this
// long-lived host process. Falls back to callHookViaSpawn (the original
// spawnSync-based path, now with a 3000ms timeout/killSignal so token-goat degrades to
// its own fail-open null rather than being force-killed by the host's own hook timeout
// budget, ~5000ms) when the in-process path is unavailable or throws.
async function callHook(event, payload) {
  const relay = await resolveRelayInProcess();
  if (relay) {
    try {
      const out = await relay(event, payload);
      const trimmed = out ? out.trim() : "";
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    } catch {
      // fall through to the spawnSync fallback below
    }
  }
  return callHookViaSpawn(event, payload);
}`;
