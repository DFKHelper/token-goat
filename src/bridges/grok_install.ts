/**
 * Grok CLI (xAI's "Grok Build") install / uninstall writer.
 *
 * `token-goat install --grok` writes a standalone hook config in addition to
 * the base Claude Code install (see README's "Grok CLI users" section). This
 * module only ever touches paths under `~/.grok/hooks/` -- the base Claude
 * Code writer in `../install.ts` is unaffected and is always run separately
 * by the caller, exactly like `../bridges/codex_install.ts`'s `installCodex`
 * and `./copilot_cli_install.ts`'s `installCopilotCli`.
 *
 * Verified against the real hooks doc shipped in the xai-org/grok-build repo
 * (`crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md`, fetched
 * 2026-07-18) -- not guessed by analogy:
 *
 * - Hook config lives at `~/.grok/hooks/*.json` (global scope, "Always"
 *   trusted per the doc's own Hook Locations table). A project-scoped
 *   `<project>/.grok/hooks/*.json` also exists but requires the user to run
 *   `/hooks-trust` (or launch with `--trust`) before it's honored at all --
 *   an out-of-band manual step token-goat cannot perform for them, and one
 *   this bridge has no evidence the user has taken. Wiring only the global
 *   scope (like Gemini's bridge, which also has no project-scope variant)
 *   avoids shipping an install path that silently does nothing until the
 *   user separately grants trust; a project-scoped `--local` variant can be
 *   added later if there's real demand for it.
 * - Two artifacts, both under `~/.grok/hooks/`:
 *   - `token-goat-shim.js` -- {@link GROK_HOOK_SCRIPT} written to disk. This
 *     file is entirely token-goat's own (no other tool writes a file with
 *     this exact name in that directory), so it follows `copilot_cli_install.ts`'s
 *     whole-file overwrite-on-diff pattern, not Codex's TOML parse/merge
 *     pattern -- there's nothing to merge into. Rewritten unconditionally on
 *     every install so an upgraded token-goat version's shim logic always
 *     reaches disk, mirroring `installCodex`/`installCopilotCli`.
 *   - `token-goat.json` -- the hook config itself, a `{ "hooks": { "<Event>": [...] } }`
 *     document (confirmed shape per the doc's "Quick Start" and "Hook JSON
 *     Format" sections) wiring the same five event keys the base Claude Code
 *     installer wires (`../install.ts`'s `HOOK_EVENT_MAP`:
 *     `PreToolUse`/`PostToolUse`/`PreCompact`/`UserPromptSubmit`/`SubagentStop`),
 *     each with an empty-string matcher -- the doc confirms "An empty or
 *     omitted matcher matches everything" -- so this mirrors the base
 *     installer's own simplicity rather than Gemini's per-tool matcher
 *     allowlist (Gemini needed that allowlist to avoid inert subprocess
 *     spawns for tools with no registered handler; here, as in Claude Code's
 *     own settings.json, the internal dispatch in `../hook_registry.ts`
 *     already no-ops for a tool with no handler, so an unconditional matcher
 *     costs nothing extra). The command invokes the shim via
 *     `hookCommandFor` (`../util.ts`) -- the absolute Node binary and a baked
 *     token-goat entry path, not a bare `token-goat`/`node`, for the same
 *     Windows `.cmd`-shim reason `codex_install.ts`/`copilot_cli_install.ts`
 *     already document. This is a whole-file overwrite too (same reasoning
 *     as the shim script above), but does still `.bak` the file before
 *     overwriting (mirrors `copilot_cli_install.ts`), since a user could
 *     plausibly hand-tune a field this bridge never touches (e.g. `timeout`).
 *
 * No AGENTS.md-style routing-guidance block is written here, unlike
 * `codex_install.ts`/`pi_install.ts`. Grok Build's own blog post claims
 * "Your AGENTS.md ... work[s] out of the box", but neither that post nor the
 * hooks doc above confirms whether Grok reads a *global* `~/.grok/AGENTS.md`
 * the way Codex reads `~/.codex/AGENTS.md` -- only a project-local one is
 * documented anywhere seen so far. Rather than guess at an unverified file
 * path, this bridge is scoped to hooks only; a routing-guidance addition can
 * follow once that path is confirmed.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { hookCommandFor, writeIfDifferent } from '../util.js'
import { GROK_HOOK_SCRIPT } from './grok.js'

/** Grok's own hook event keys that token-goat wires -- mirrors `../install.ts`'s `HOOK_EVENT_MAP`. */
const GROK_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop'] as const
type GrokHookEvent = (typeof GROK_HOOK_EVENTS)[number]

/** Grok event key -> the internal event arg passed to the shim / `token-goat hook`. */
const GROK_EVENT_ARG: Record<GrokHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
}

interface GrokHookEntry {
  type: 'command'
  command: string
}

interface GrokMatcherGroup {
  matcher: string
  hooks: GrokHookEntry[]
}

interface GrokHookConfig {
  hooks: Partial<Record<GrokHookEvent, GrokMatcherGroup[]>>
}

/** Absolute path to `~/.grok/hooks/`. */
export function grokHooksDir(): string {
  return path.join(os.homedir(), '.grok', 'hooks')
}

/** Absolute path to `~/.grok/hooks/token-goat.json`, the hook config this bridge owns entirely. */
export function grokConfigPath(): string {
  return path.join(grokHooksDir(), 'token-goat.json')
}

/** Absolute path the Grok hook shim script is installed to. */
export function grokHookScriptPath(): string {
  return path.join(grokHooksDir(), 'token-goat-shim.js')
}

function buildConfig(scriptPath: string): GrokHookConfig {
  const hooks: Partial<Record<GrokHookEvent, GrokMatcherGroup[]>> = {}
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [
      { matcher: '', hooks: [{ type: 'command', command: hookCommandFor(scriptPath, GROK_EVENT_ARG[event]) }] },
    ]
  }
  return { hooks }
}

/** Outcome of an {@link installGrok} call. */
export interface GrokInstallResult {
  readonly configPath: string
  readonly hookScriptPath: string
  /** True when both the shim script and the hook config were already up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install the Grok CLI integration.
 *
 * Always additive: never touches Claude Code's `~/.claude/settings.json`
 * (the caller is responsible for also running the base install). Idempotent
 * -- a second call reports `alreadyInstalled: true` and does not duplicate
 * any entry.
 */
export function installGrok(): GrokInstallResult {
  const configPath = grokConfigPath()
  const scriptPath = grokHookScriptPath()

  // The shim is a generated, never-user-edited file: keep it in sync with the
  // running token-goat version on every install call, independent of whether
  // the hook config itself needs any change (mirrors installCodex/installCopilotCli).
  const scriptChanged = writeIfDifferent(scriptPath, GROK_HOOK_SCRIPT)

  const desiredText = `${JSON.stringify(buildConfig(scriptPath), null, 2)}\n`
  const configChanged = writeIfDifferent(configPath, desiredText, true)

  return { configPath, hookScriptPath: scriptPath, alreadyInstalled: !scriptChanged && !configChanged }
}

/**
 * Remove the Grok CLI integration: deletes `token-goat.json` and the shim
 * script. Returns true when at least one of the two was present and removed;
 * false when nothing was installed (no writes occur in that case).
 */
export function uninstallGrok(): boolean {
  const configPath = grokConfigPath()
  const scriptPath = grokHookScriptPath()

  let removedAny = false
  try {
    fs.unlinkSync(configPath)
    removedAny = true
  } catch {
    // Already absent; nothing to remove.
  }
  try {
    fs.unlinkSync(scriptPath)
    removedAny = true
  } catch {
    // Already absent; nothing to remove.
  }
  return removedAny
}

/**
 * Is the Grok CLI integration currently present?
 *
 * Presence-only (both files exist), mirroring {@link isCopilotCliInstalled}
 * in `./copilot_cli_install.js` -- a present-but-outdated file still counts
 * as installed, and {@link installGrok} tops it up to the current template on
 * the next call.
 */
export function isGrokInstalled(): boolean {
  return fs.existsSync(grokConfigPath()) && fs.existsSync(grokHookScriptPath())
}
