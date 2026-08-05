/**
 * Install / uninstall token-goat's hooks in Claude Code settings.
 *
 * Ports the `patch_settings_json` / `unpatch_settings_json` slice of
 * `install.py` to TypeScript. Claude Code reads hook wiring from
 * `~/.claude/settings.json` (user scope) or `<project>/.claude/settings.json`
 * (project scope). Each token-goat hook is a `{ type: "command", command: ... }`
 * entry under the matching event key, where the command invokes the generated
 * shim at {@link claudeHookScriptPath} via {@link hookCommandFor} —
 * `"<node>" "<shim>" <event> "<entry>"`.
 *
 * Going through the shim rather than the bare `token-goat hook <event>` PATH
 * lookup buys two things: the shim's in-process fast path imports
 * `dist/token-goat-hook.mjs` and calls `relayInProcess` directly instead of
 * spawning a second process, and naming the node binary explicitly skips the
 * npm bin wrapper (on Windows, a `cmd.exe` layer) that a PATH lookup would pay
 * for on every single hook. Measured at ~480ms → ~324ms per invocation.
 *
 * Writes go through {@link atomicWriteText}; an absent settings file is created
 * with only the hooks section. Installation is idempotent — re-running never
 * duplicates an entry — and uninstall removes only token-goat's own entries
 * plus the generated shim, leaving any user-authored hooks intact.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { CLAUDECODE_HOOK_SCRIPT } from './bridges/claudecode.js'
import { buildGuidanceBlock, buildGuidanceBody } from './bridges/guidance_block.js'
import { toolMatcherFor } from './hook_registry.js'
import { normalizeDarwinSystemAlias } from './paths.js'
import type { HookEventName } from './types.js'
import { atomicWriteText, ensureDirSync, escapeRegExp, hookCommandFor, stripDelimitedBlock, stripOwnHooksFromMap, upsertDelimitedBlock, writeIfDifferent, writeJsonSettings } from './util.js'

/** Where to install: the user's home `~/.claude` or the project's `.claude`. */
export type HookScope = 'user' | 'project'

/** Outcome of an {@link installHooks} call. */
export interface InstallResult {
  /** Scope the hooks were written to. */
  readonly scope: HookScope
  /** Absolute path to the settings file that was written. */
  readonly settingsPath: string
  /** True when every token-goat hook was already present (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Claude Code event names token-goat wires, mapped to their internal event arg.
 *
 * The settings key is Claude Code's PascalCase event name; the value is the arg
 * passed to `token-goat hook <event>`, matching the internal HookEventName
 * spellings the relay dispatches on.
 */
const HOOK_EVENT_MAP: ReadonlyArray<readonly [string, string]> = [
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['PreCompact', 'pre_compact'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['SubagentStop', 'subagent_stop'],
  ['SessionStart', 'session_start'],
]

/**
 * Marker substring identifying the CURRENT, shim-based hook command.
 *
 * Deliberately `token-goat-shim` and not `token-goat-hook`: the latter is reserved
 * in {@link LEGACY_COMMAND_MARKERS} for the dead Python-era exe wrapper, so a shim
 * path carrying it would be classified as stale cruft and stripped on every single
 * reinstall -- silently reverting the wiring it had just applied. `bridges/codex_install.ts`
 * hit and solved this exact collision first (`CODEX_COMMAND_MARKER`); this is the same
 * solution ported to the base Claude Code path.
 */
const SHIM_COMMAND_MARKER = 'token-goat-shim'

/** Marker substring identifying the pre-shim `token-goat hook <event>` command. */
const COMMAND_MARKER = 'token-goat hook'

/**
 * Command substrings from earlier product eras that must still be recognized
 * as token-goat's own, so an upgrade doesn't leave a dead duplicate behind:
 * - `tokenwise` — the pre-rename product name (2026-05-13 rename to token-goat).
 * - `token_goat` — the pre-TS-port Python invocation (`pythonw -m token_goat.cli hook ...`).
 * - `tg-hook` — the Python-era persistent wrapper script (`tg-hook.cmd` / `tg-hook.sh`).
 * - `token-goat-hook` — the Python-era GUI-subsystem exe wrapper (`token-goat-hook.exe`).
 * None of these resolve on a machine running the current build, so a settings.json
 * entry carrying one is always a stale leftover to detect and strip, never a
 * legitimately different install to leave alone.
 */
const LEGACY_COMMAND_MARKERS = ['tokenwise', 'token_goat', 'tg-hook', 'token-goat-hook']

/**
 * Builds a regex that matches `marker` only at a word/path boundary, so a plain
 * substring check can't false-positive on a marker embedded inside a longer
 * identifier (e.g. a user hook literally named `my-token-goat-hook-config`).
 */
export function anchoredMarkerPattern(marker: string): RegExp {
  const escaped = escapeRegExp(marker)
  return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`)
}

const HOOK_MARKER_PATTERNS = [SHIM_COMMAND_MARKER, COMMAND_MARKER, ...LEGACY_COMMAND_MARKERS].map(anchoredMarkerPattern)

/** True when `command` is any token-goat hook invocation: current shim, pre-shim, or legacy alias. */
function isTokenGoatHookCommand(command: string): boolean {
  return HOOK_MARKER_PATTERNS.some((pattern) => pattern.test(command))
}

/**
 * Absolute path to the generated Claude Code hook shim.
 *
 * Always under the user's home `~/.claude/hooks`, never the project's, even for a
 * project-scope install: the shim is a generated file whose invocation bakes in
 * absolute machine-specific paths (this node binary, this token-goat entry), so a
 * copy inside a repo would be both useless to a teammate and an unexpected
 * generated artifact in their working tree. A project-scope `settings.json` simply
 * points at the home-scoped shim by absolute path.
 */
export function claudeHookScriptPath(): string {
  return path.join(os.homedir(), '.claude', 'hooks', 'token-goat-shim.js')
}

/**
 * Does any installed scope still wire a hook command pointing at `scriptPath`?
 *
 * Both scopes share the single home-scoped shim, so uninstalling one must not delete
 * the file the other still depends on. `alreadyStripped` is the in-memory hooks map of
 * the scope currently being uninstalled, passed in because its entries have already been
 * removed there but not yet written to disk -- re-reading that file would see the stale
 * pre-strip content and always report the shim as still needed.
 */
function anyScopeReferencesShim(
  scriptPath: string,
  currentScope: HookScope,
  alreadyStripped: Record<string, HookMatcherGroup[]>,
): boolean {
  const referencesIn = (map: Record<string, HookMatcherGroup[]> | undefined): boolean => {
    for (const groups of Object.values(map ?? {})) {
      for (const group of groups) {
        for (const h of group.hooks ?? []) {
          if (h.command.includes(scriptPath)) return true
        }
      }
    }
    return false
  }
  // The scope being uninstalled is judged from the in-memory post-strip map only: its file on disk still holds the pre-strip entries, so re-reading it here would always find the shim "still referenced" and no uninstall would ever remove it.
  if (referencesIn(alreadyStripped)) return true
  for (const scope of ['user', 'project'] as const) {
    if (scope === currentScope) continue
    // A scope whose settings file is missing, unreadable, or malformed is treated as not referencing the shim: uninstall must stay best-effort rather than abort on someone else's broken JSON.
    if (referencesIn(readSettings(settingsPath(scope)).hooks)) return true
  }
  return false
}

/** Return the `~/.claude` or `<cwd>/.claude` settings path for `scope`. */
export function settingsPath(scope: HookScope): string {
  // Only fix the macOS /var vs /private/var alias split (os.tmpdir() vs process.cwd() disagree on this after chdir) — not the full resolveIndexPath pipeline, whose unconditional drive-letter lowercasing would otherwise leak into this user-visible, printed-to-the-console path on Windows.
  const root = scope === 'user' ? os.homedir() : normalizeDarwinSystemAlias(process.cwd())
  const base = path.join(root, '.claude')
  return path.join(base, 'settings.json')
}

/** A single hook command entry as Claude Code stores it. */
interface HookCommandEntry {
  type: string
  command: string
}

/** A matcher group: an optional matcher plus the list of hook commands. */
interface HookMatcherGroup {
  matcher?: string
  hooks?: HookCommandEntry[]
}

/** The settings shape we read/write; unknown keys are preserved verbatim. */
interface Settings {
  hooks?: Record<string, HookMatcherGroup[]>
  [key: string]: unknown
}

/**
 * Thrown by {@link readSettings} in strict mode when the settings file exists
 * but isn't parseable JSON, or parses to something other than a JSON object.
 * A caller about to overwrite the file (installHooks) must let this propagate
 * rather than silently proceeding as if the file were empty -- otherwise a
 * single JSON typo in the user's settings.json gets clobbered on write.
 */
export class SettingsParseError extends Error {}

/**
 * Parse the settings file at `p`.
 *
 * A missing file always yields `{}` -- that's the legitimate "nothing
 * installed yet" case. When `opts.strict` is true, a file that *exists* but
 * fails to parse (or parses to something other than a JSON object) throws
 * {@link SettingsParseError} instead of returning `{}`, so a caller about to
 * overwrite the file can tell "genuinely empty" apart from "corrupt, do not
 * touch." Non-strict callers (read-only, or a no-op on corrupt) keep the old
 * lenient `{}` fallback.
 */
function readSettings(p: string, opts: { strict?: boolean } = {}): Settings {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (opts.strict === true) {
      throw new SettingsParseError(
        `settings file '${p}' exists but contains invalid JSON. Fix or back up the file before running install.`,
      )
    }
    // Corrupt JSON: do not clobber it silently — but for our read we treat it as empty so callers can decide. (installHooks rewrites the whole file.)
    return {}
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Settings
  }
  if (opts.strict === true) {
    throw new SettingsParseError(
      `settings file '${p}' does not contain a JSON object at the top level. Fix or back up the file before running install.`,
    )
  }
  return {}
}

/** True when `groups` contains a hook command matching `predicate`. */
function groupHasTokenGoat(
  groups: HookMatcherGroup[] | undefined,
  predicate: (command: string) => boolean,
): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (predicate(h.command)) return true
    }
  }
  return false
}

/**
 * Install token-goat hooks into the `scope` settings file.
 *
 * Reads the existing settings (creating an empty doc when absent), adds any
 * missing current-format token-goat hook entries under each mapped event key,
 * and writes the result atomically. A legacy-only entry for an event key
 * (see {@link LEGACY_COMMAND_MARKERS}) does not count as already installed --
 * it is stripped and replaced with the current command, so an upgrade from a
 * tokenwise/token_goat-era install ends up with exactly one, working, entry
 * per event key rather than a dead leftover sitting next to a new one.
 * `alreadyInstalled` is true when nothing had to change.
 */
export function installHooks(scope: HookScope = 'user'): InstallResult {
  const p = settingsPath(scope)
  // strict: true -- a settings file that exists but fails to parse must abort before any write (see SettingsParseError), not silently proceed as if it were empty and get clobbered below.
  const settings = readSettings(p, { strict: true })
  const hooks = settings.hooks ?? {}

  // The shim is a generated, never-user-edited file: refresh it on every install call so it tracks the running token-goat version, independent of whether the settings.json wiring itself needs any change. Mirrors bridges/codex_install.ts. writeIfDifferent rather than an unconditional atomicWriteText so a genuine no-op install touches nothing on disk, and so a repaired shim (user deleted ~/.claude/hooks, or an older build left stale content) counts as a real change via `scriptChanged` -- reporting "already installed" while having just rewritten the file the hooks depend on would be a lie to anyone running install precisely to repair it.
  const scriptPath = claudeHookScriptPath()
  ensureDirSync(path.dirname(scriptPath))
  const scriptChanged = writeIfDifferent(scriptPath, CLAUDECODE_HOOK_SCRIPT)

  let settingsChanged = false
  for (const [eventKey, eventArg] of HOOK_EVENT_MAP) {
    const expectedCommand = hookCommandFor(scriptPath, eventArg)
    const existingGroups = hooks[eventKey] ?? []

    // Strip every token-goat entry that is not byte-identical to what this build wires, whether or not a correct entry also already exists -- a wrong entry coexisting with a right one violates "exactly one, working, entry per event key" just as much as a wrong entry sitting alone does. Exact-match rather than marker-match is what makes this cover all three staleness shapes at once: a legacy alias (tokenwise/token_goat/tg-hook), a pre-shim bare `token-goat hook <event>`, and a shim command whose baked absolute paths have since moved (node upgraded, token-goat reinstalled elsewhere). A marker check would call that last one "already installed" and leave the hook pointing at a binary that no longer exists.
    const groups: HookMatcherGroup[] = []
    let strippedStale = false
    for (const group of existingGroups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isStale = isTokenGoatHookCommand(h.command) && h.command !== expectedCommand
        if (isStale) strippedStale = true
        return !isStale
      })
      if (keptHooks.length > 0) {
        groups.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        // A group that had no hooks to begin with is user data; preserve it.
        groups.push(group)
      }
    }

    const isOurs = (command: string): boolean => command === expectedCommand
    if (groupHasTokenGoat(groups, isOurs)) {
      // Re-narrow an already-installed entry. Without this the matcher improvement
      // below would only ever reach brand-new installs: every existing user would
      // keep the catch-all they were installed with and see no benefit. Only groups
      // whose hooks are all token-goat's own are touched -- a group the user has
      // added their own commands to is left exactly as-is.
      const narrowed = toolMatcherFor(eventArg as HookEventName)
      let renarrowed = false
      if (narrowed !== null) {
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i]
          if (group === undefined) continue
          const ownHooks = group.hooks ?? []
          const isOwnGroup = ownHooks.length > 0 && ownHooks.every((h) => isOurs(h.command))
          if (isOwnGroup && group.matcher !== narrowed) {
            groups[i] = { ...group, matcher: narrowed }
            renarrowed = true
          }
        }
      }
      if (strippedStale || renarrowed) {
        hooks[eventKey] = groups
        settingsChanged = true
      }
      continue
    }

    // Narrow the matcher to the tools this event actually has handlers for. Claude
    // Code spawns a process per matcher hit and ~90% of that cost is Node startup plus
    // bundle evaluation, so a catch-all makes every unhandled tool pay full price twice
    // (pre + post). toolMatcherFor returns null when narrowing would be unsafe -- a
    // non-tool event, or a handler that really does want everything -- and the
    // catch-all is the correct answer then.
    const matcher = toolMatcherFor(eventArg as HookEventName) ?? ''
    groups.push({ matcher, hooks: [{ type: 'command', command: expectedCommand }] })
    hooks[eventKey] = groups
    settingsChanged = true
  }

  if (!settingsChanged && !scriptChanged) {
    return { scope, settingsPath: p, alreadyInstalled: true }
  }

  // Only touch settings.json when its own content actually changed: a run that merely repaired the shim must not rewrite (and re-timestamp) a file the user may be watching or version-controlling.
  if (settingsChanged) {
    settings.hooks = hooks
    writeJsonSettings(p, settings)
  }
  return { scope, settingsPath: p, alreadyInstalled: false }
}

/**
 * Remove token-goat hooks from the `scope` settings file.
 *
 * Strips every hook entry whose command targets `token-goat hook ...`, prunes
 * now-empty matcher groups and event keys, and drops the `hooks` section if it
 * becomes empty. Returns true when at least one entry was removed; false when
 * none were present (no write occurs in that case).
 */
export function uninstallHooks(scope: HookScope = 'user'): boolean {
  const p = settingsPath(scope)
  const settings = readSettings(p)
  const hooks = settings.hooks
  if (hooks === undefined) return false

  const removed = stripOwnHooksFromMap(hooks, isTokenGoatHookCommand)

  // Remove the generated shim too, mirroring bridges/codex_install.ts -- but ONLY once no scope still points at it. Unlike Codex, which has a single config location, token-goat has two scopes that share one home-scoped shim: deleting it on `uninstall --project` while a user-scope install is still wired would leave every user-scope hook invoking a file that no longer exists, failing silently on every tool call. Checked after the strip above so this scope's own now-removed entries don't count as a reason to keep it.
  const scriptPath = claudeHookScriptPath()
  let removedScript = false
  if (!anyScopeReferencesShim(scriptPath, scope, hooks)) {
    try {
      fs.unlinkSync(scriptPath)
      removedScript = true
    } catch {
      // Already absent; nothing to remove.
    }
  }

  if (!removed) return removedScript

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  } else {
    settings.hooks = hooks
  }

  writeJsonSettings(p, settings)
  return true
}

/**
 * Are token-goat hooks installed in `scope`?
 *
 * True only when every mapped event key carries a *current-format*
 * token-goat hook command — a legacy-only entry does not count, since it is
 * dead on this build, and a partial install (some events wired, some not)
 * reads as not installed so {@link installHooks} will top up the missing
 * entries.
 */
export function isInstalled(scope: HookScope = 'user'): boolean {
  const settings = readSettings(settingsPath(scope))
  const hooks = settings.hooks
  if (hooks === undefined) return false
  const scriptPath = claudeHookScriptPath()
  // A wired command whose baked shim path no longer exists on disk cannot fire, so it must read as not-installed and let installHooks regenerate it -- otherwise a user who deleted ~/.claude/hooks would be told they are installed while every hook silently no-ops.
  if (!fs.existsSync(scriptPath)) return false
  for (const [eventKey, eventArg] of HOOK_EVENT_MAP) {
    const expectedCommand = hookCommandFor(scriptPath, eventArg)
    if (!groupHasTokenGoat(hooks[eventKey], (c) => c === expectedCommand)) return false
  }
  return true
}

// --- CLAUDE.md delimited-block writer ---
// README documents this as part of the BASE Claude Code install (unconditional, not gated behind any --<harness> flag): a delimited block in the user's own ~/.claude/CLAUDE.md telling the agent to prefer token-goat commands over Read/Grep. Mirrors bridges/codex_install.ts's AGENTS.md writer -- same idempotent merge-or-append pattern, same "preserve everything outside the markers" guarantee for a file the user edits directly.

const CLAUDE_MD_BEGIN = '<!-- token-goat-begin -->'
const CLAUDE_MD_END = '<!-- token-goat-end -->'

/** Absolute path to `~/.claude/CLAUDE.md`. */
export function claudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md')
}

function buildClaudeMdBlock(): string {
  return buildGuidanceBlock({
    beginMarker: CLAUDE_MD_BEGIN,
    endMarker: CLAUDE_MD_END,
    fallbackToolClause: "Claude Code's own Read, Grep, and Glob preference rules",
  })
}

function writeClaudeMdBlock(p: string): boolean {
  return upsertDelimitedBlock(p, CLAUDE_MD_BEGIN, CLAUDE_MD_END, buildClaudeMdBlock())
}

function stripClaudeMdBlock(p: string): boolean {
  return stripDelimitedBlock(p, CLAUDE_MD_BEGIN, CLAUDE_MD_END)
}

/** Outcome of an {@link installClaudeMd} call. */
export interface ClaudeMdInstallResult {
  readonly path: string
  /** True when the block was already present and up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/** Add or refresh the token-goat block in `~/.claude/CLAUDE.md`, preserving any existing content. */
export function installClaudeMd(): ClaudeMdInstallResult {
  const p = claudeMdPath()
  const changed = writeClaudeMdBlock(p)
  return { path: p, alreadyInstalled: !changed }
}

/** Remove the token-goat block from `~/.claude/CLAUDE.md`, leaving the rest of the file intact. */
export function uninstallClaudeMd(): boolean {
  return stripClaudeMdBlock(claudeMdPath())
}

/**
 * Find token-goat marker blocks sitting in some markdown file *other* than
 * `~/.claude/CLAUDE.md`.
 *
 * The block is plain markdown in a file the user is explicitly told they own and edit, so
 * relocating it into a tidier "reference" file is a natural thing to do -- and it silently
 * breaks: {@link installClaudeMd} and {@link uninstallClaudeMd} both resolve the single
 * hardcoded {@link claudeMdPath}, so a relocated copy is never refreshed (it freezes at
 * whatever version was current when it moved) and never removed on uninstall. Worse, the next
 * install sees CLAUDE.md missing its block and appends a fresh one, leaving the guidance
 * duplicated across two files with only one of them live.
 *
 * Detection only -- callers report; nothing here edits or deletes a user's file.
 *
 * Matches a real block, not a mention of one: both markers must appear on their own lines.
 * Prose that references `<!-- token-goat-begin -->` inline -- a pointer explaining where the
 * managed block actually lives, which is exactly what a user is told to leave behind after
 * relocating one -- would otherwise be flagged forever as the very thing it documents.
 *
 * Bounded walk: skips `node_modules`/`.git`, caps depth, and ignores symlinked directories
 * (`Dirent.isDirectory()` is false for a symlink), so it cannot loop.
 */
export function findStrayClaudeMdBlocks(searchRoot?: string): string[] {
  const root = searchRoot ?? path.join(os.homedir(), '.claude')
  const canonical = path.resolve(claudeMdPath())
  const found: string[] = []
  if (!fs.existsSync(root)) return found

  const SKIP_DIRS = new Set(['node_modules', '.git'])
  const MAX_DEPTH = 6

  const hasRealBlock = (text: string): boolean => {
    let sawBegin = false
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === CLAUDE_MD_BEGIN) sawBegin = true
      else if (sawBegin && trimmed === CLAUDE_MD_END) return true
    }
    return false
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (path.resolve(full) === canonical) continue
      let text: string
      try {
        text = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (hasRealBlock(text)) found.push(full)    }
  }

  walk(root, 0)
  return found.sort()
}

// --- token-goat skill writer ---
// README documents ~/.claude/skills/token-goat/SKILL.md as part of the base install too -- "the same routing guidance in skill form". Unlike CLAUDE.md, this directory belongs entirely to token-goat (nothing else writes into it), so install/uninstall can write/remove the whole file rather than patching a delimited region.

// The frontmatter `description` is DELIBERATELY exempt from the gate wording: it
// is a relevance trigger the harness reads to decide *whether to load the skill*
// at all, not guidance the agent acts on mid-task. It must stay a plain,
// keyword-dense one-liner. Do NOT "fix" it into the gate phrasing for
// consistency with the body below -- doing so degrades skill-loading recall for
// no benefit. Only the body (rendered from the shared builder) is the gate.
// The allowed-tools frontmatter keeps Copilot-style loaders from body-scanning the
// skill prose and mistaking quoted command names for implicit tool identifiers. It
// MUST list real harness tool identifiers, not token-goat subcommands: loaders
// validate every entry against their tool registry and warn on each miss, so a
// subcommand list here produces one "Unknown tool name in the tool allowlist"
// warning per entry. token-goat itself runs through the shell tool.
const SKILL_MD_FRONTMATTER = `---
name: token-goat
description: Use before reading whole files or grepping wide. token-goat commands (symbol, read, section, semantic, outline, skeleton, map, refs, changed, config-get, bash-output, web-output, gdrive-sections) return narrow slices of code and docs at a fraction of the token cost.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---`

// The body is the single shared gate (buildGuidanceBody), the same wording
// upserted into CLAUDE.md/AGENTS.md/copilot-instructions.md -- one source across
// all four surfaces. This skill ships in ~/.claude/skills, so the fallback clause
// names Claude Code's own read tools, exactly like the CLAUDE.md block.
const SKILL_MD_CONTENT = `${SKILL_MD_FRONTMATTER}\n\n${buildGuidanceBody("Claude Code's own Read, Grep, and Glob preference rules")}\n`

/** Absolute path to the token-goat skill directory, `~/.claude/skills/token-goat`. */
export function skillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'token-goat')
}

/** Absolute path to `~/.claude/skills/token-goat/SKILL.md`. */
export function skillPath(): string {
  return path.join(skillDir(), 'SKILL.md')
}

/** Outcome of an {@link installSkill} call. */
export interface SkillInstallResult {
  readonly path: string
  /** True when the file was already present and up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/** Write (or refresh) the token-goat skill at `~/.claude/skills/token-goat/SKILL.md`. */
export function installSkill(): SkillInstallResult {
  const p = skillPath()
  let existing: string | null = null
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    // Absent; falls through to the write below.
  }
  if (existing === SKILL_MD_CONTENT) return { path: p, alreadyInstalled: true }
  ensureDirSync(skillDir())
  atomicWriteText(p, SKILL_MD_CONTENT)
  return { path: p, alreadyInstalled: false }
}

/** Remove the token-goat skill directory entirely. */
export function uninstallSkill(): boolean {
  const dir = skillDir()
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}
