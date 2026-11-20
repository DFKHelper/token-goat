// Shared in-process/spawn hook-relay block used verbatim inside the generated plugin scripts for opencode (opencode.ts) and OpenClaw (openclaw.ts). Both hosts load their generated plugin file as a long-lived module (never a per-invocation subprocess), so this logic -- resolving the install-time entry path, relaying hook calls in-process via the sibling token-goat-hook.mjs, and falling back to a spawned "token-goat" subprocess when that's unavailable -- is identical between them. pi.ts has its own typed copy of the same logic and is intentionally NOT wired to this constant (pi's extension host is a real TypeScript compile target, and this block is plain untyped JS meant to be dropped verbatim into a generated file).
import { shimFallbackTimeoutConst } from './shim_common.js'

const RELAY_TEMPLATE = `const RELAY_HARNESS = "__RELAY_HARNESS__";

// resolveEntryPath reads a sidecar JSON file (token-goat-entry.json, written by
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

${shimFallbackTimeoutConst('relay', 'call')}

// What a hook run must see from this host: its harness name and this call's deadline (epoch ms).
function hookEnv(deadlineAt) {
  return { TOKEN_GOAT_HARNESS_OVERRIDE: RELAY_HARNESS, TOKEN_GOAT_HOOK_DEADLINE_AT: String(deadlineAt) };
}

// The in-process route reads process.env: set per call and put back; the first in saves, the last out restores.
let hookEnvHolders = 0;
let hookEnvSaved = {};
function enterHookEnv(deadlineAt) {
  const set = hookEnv(deadlineAt);
  if (hookEnvHolders === 0) {
    hookEnvSaved = {};
    for (const key of Object.keys(set)) hookEnvSaved[key] = process.env[key];
  }
  hookEnvHolders += 1;
  Object.assign(process.env, set);
}
function leaveHookEnv() {
  hookEnvHolders -= 1;
  if (hookEnvHolders > 0) return;
  for (const [key, value] of Object.entries(hookEnvSaved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Parses a hook's printed answer; a block whose reason is not a string is not a block, so it is no answer.
function hookAnswer(text) {
  const out = text ? text.trim() : "";
  if (!out) return null;
  const parsed = JSON.parse(out);
  if (parsed && parsed.decision === "block" && typeof parsed.reason !== "string") return null;
  return parsed;
}

// One spawn of the hook; spent is the budget already used, so a call's spawns share one budget.
function runHookSpawn(entryPath, event, payload, spent, deadlineAt) {
  try {
    const env = { ...process.env, ...hookEnv(deadlineAt) };
    const r = entryPath
      ? spawnSync(process.execPath, [entryPath, "hook", event], {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: SHIM_FALLBACK_TIMEOUT_MS - spent,
          killSignal: "SIGKILL",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          env,
        })
      : spawnSync("token-goat hook " + event, {
          input: JSON.stringify(payload),
          encoding: "utf8",
          timeout: SHIM_FALLBACK_TIMEOUT_MS - spent,
          killSignal: "SIGKILL",
          shell: true,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          env,
        });
    if (r.error || r.status !== 0) return null;
    return hookAnswer(r.stdout);
  } catch {
    return null;
  }
}

// Whole milliseconds of the call's budget used since start (a spawn timeout must be an integer).
function budgetSpent(start) {
  return Math.max(0, Math.floor(performance.now() - start));
}

// What a bound wins with; a hook answer is never this.
const HOOK_TIMED_OUT = Symbol("hook-timed-out");

// Races a promise against what is left of the call's budget; the timer is cleared on every path.
function raceBudget(promise, start) {
  let timer;
  const bound = new Promise((resolve) => {
    const left = Math.max(0, SHIM_FALLBACK_TIMEOUT_MS - budgetSpent(start));
    timer = setTimeout(() => resolve(HOOK_TIMED_OUT), left);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

// The baked entry runs first via process.execPath; PATH needs shell: true so a Windows .cmd shim resolves.
// A failed or silent entry run (a directory, a broken bundle) falls back to PATH inside the same budget.
function callHookViaSpawn(event, payload, start, deadlineAt) {
  const entryPath = resolveEntryPath();
  if (entryPath) {
    const spent = budgetSpent(start);
    if (spent >= SHIM_FALLBACK_TIMEOUT_MS) return null;
    const answer = runHookSpawn(entryPath, event, payload, spent, deadlineAt);
    if (answer) return answer;
  }
  const spentNow = budgetSpent(start);
  if (spentNow >= SHIM_FALLBACK_TIMEOUT_MS) return null;
  return runHookSpawn(undefined, event, payload, spentNow, deadlineAt);
}

// Tries the in-process hook call first (resolveRelayInProcess above), which avoids
// spawning a second node process altogether for every single tool call in this
// long-lived host process. Falls back to callHookViaSpawn (the original
// spawnSync-based path, now bounded by SHIM_FALLBACK_TIMEOUT_MS and a killSignal so token-goat degrades to
// its own fail-open null rather than being force-killed by the host's own hook timeout
// budget, 15000ms for OpenClaw's before_tool_call) when the in-process path is unavailable or throws.
async function callHook(event, payload) {
  // Timed from here, not from process start: this host lives far longer than one call, so the hook library's default clock (process age) would record the host's uptime as this call's duration.
  const start = performance.now();
  // The call's own deadline in epoch ms, handed to the hook library and to every child this call spawns.
  const deadlineAt = Date.now() + SHIM_FALLBACK_TIMEOUT_MS;
  const relay = await raceBudget(resolveRelayInProcess(), start);
  if (relay === HOOK_TIMED_OUT) return null;
  if (relay) {
    enterHookEnv(deadlineAt);
    try {
      const ran = relay(event, payload, undefined, { elapsedMs: () => performance.now() - start });
      const out = await raceBudget(ran, start);
      if (out === HOOK_TIMED_OUT) return null;
      if (!out || !out.trim()) return null;
      const answer = hookAnswer(out);
      if (answer) return answer;
    } catch {
      // fall through to the spawnSync fallback below
    } finally {
      leaveHookEnv();
    }
  }
  return callHookViaSpawn(event, payload, start, deadlineAt);
}`;

/** The block for one host, which names its own harness to every hook it runs (opencode, OpenClaw). */
export function bridgeRelayJs(harness: 'opencode' | 'openclaw'): string {
  return RELAY_TEMPLATE.replace('__RELAY_HARNESS__', harness);
}

/** The block as the OpenClaw plugin embeds it (src/bridges/openclaw.ts, which names no harness of its own). */
export const BRIDGE_RELAY_JS = bridgeRelayJs('openclaw');
