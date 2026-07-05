/**
 * Install / uninstall token-goat's hooks in Claude Code settings.
 *
 * Ports the `patch_settings_json` / `unpatch_settings_json` slice of
 * `install.py` to TypeScript. Claude Code reads hook wiring from
 * `~/.claude/settings.json` (user scope) or `<project>/.claude/settings.json`
 * (project scope). Each token-goat hook is a `{ type: "command", command:
 * "token-goat hook <event>" }` entry under the matching event key.
 *
 * Writes go through {@link atomicWriteText}; an absent settings file is created
 * with only the hooks section. Installation is idempotent — re-running never
 * duplicates an entry — and uninstall removes only token-goat's own entries,
 * leaving any user-authored hooks intact.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync } from './util.js'

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
]

/** Marker substring identifying a token-goat hook command for idempotency. */
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
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`)
}

const HOOK_MARKER_PATTERNS = [COMMAND_MARKER, ...LEGACY_COMMAND_MARKERS].map(anchoredMarkerPattern)

/** True when `command` is a current-or-legacy token-goat hook invocation. */
function isTokenGoatHookCommand(command: string): boolean {
  return HOOK_MARKER_PATTERNS.some((pattern) => pattern.test(command))
}

/** Pattern matching only the current-format `token-goat hook <event>` command, never a legacy alias. */
const CURRENT_MARKER_PATTERN = anchoredMarkerPattern(COMMAND_MARKER)

/** True when `command` is a current-format (non-legacy) token-goat hook invocation. */
function isCurrentTokenGoatHookCommand(command: string): boolean {
  return CURRENT_MARKER_PATTERN.test(command)
}

/** Build the hook command string for an internal event arg. */
function hookCommand(eventArg: string): string {
  return `token-goat hook ${eventArg}`
}

/** Return the `~/.claude` or `<cwd>/.claude` settings path for `scope`. */
export function settingsPath(scope: HookScope): string {
  const base = scope === 'user' ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude')
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
  // strict: true -- a settings file that exists but fails to parse must abort
  // before any write (see SettingsParseError), not silently proceed as if it
  // were empty and get clobbered below.
  const settings = readSettings(p, { strict: true })
  const hooks = settings.hooks ?? {}

  let changed = false
  for (const [eventKey, eventArg] of HOOK_EVENT_MAP) {
    const existingGroups = hooks[eventKey] ?? []
    if (groupHasTokenGoat(existingGroups, isCurrentTokenGoatHookCommand)) continue

    // Strip any legacy-marked token-goat entries before adding the current
    // command -- a legacy command is dead on this build, so leaving it in
    // place would just be a second, non-functional entry.
    const groups: HookMatcherGroup[] = []
    for (const group of existingGroups) {
      const keptHooks = (group.hooks ?? []).filter((h) => !isTokenGoatHookCommand(h.command))
      if (keptHooks.length > 0) {
        groups.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        // A group that had no hooks to begin with is user data; preserve it.
        groups.push(group)
      }
    }
    groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(eventArg) }] })
    hooks[eventKey] = groups
    changed = true
  }

  if (!changed) {
    return { scope, settingsPath: p, alreadyInstalled: true }
  }

  settings.hooks = hooks
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
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

  let removed = false
  for (const eventKey of Object.keys(hooks)) {
    const groups = hooks[eventKey]
    if (groups === undefined) continue
    const keptGroups: HookMatcherGroup[] = []
    for (const group of groups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isOurs = typeof h.command === 'string' && isTokenGoatHookCommand(h.command)
        if (isOurs) removed = true
        return !isOurs
      })
      if (keptHooks.length > 0) {
        keptGroups.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        // A group that had no hooks to begin with is user data; preserve it.
        keptGroups.push(group)
      }
    }
    if (keptGroups.length > 0) {
      hooks[eventKey] = keptGroups
    } else {
      delete hooks[eventKey]
    }
  }

  if (!removed) return false

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  } else {
    settings.hooks = hooks
  }

  ensureDirSync(path.dirname(p))
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
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
  for (const [eventKey] of HOOK_EVENT_MAP) {
    if (!groupHasTokenGoat(hooks[eventKey], isCurrentTokenGoatHookCommand)) return false
  }
  return true
}

// --- CLAUDE.md delimited-block writer ---
//
// README documents this as part of the BASE Claude Code install (unconditional,
// not gated behind any --<harness> flag): a delimited block in the user's own
// ~/.claude/CLAUDE.md telling the agent to prefer token-goat commands over
// Read/Grep. Mirrors bridges/codex_install.ts's AGENTS.md writer -- same
// idempotent merge-or-append pattern, same "preserve everything outside the
// markers" guarantee for a file the user edits directly.

const CLAUDE_MD_BEGIN = '<!-- token-goat-begin -->'
const CLAUDE_MD_END = '<!-- token-goat-end -->'

/** Absolute path to `~/.claude/CLAUDE.md`. */
export function claudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md')
}

function buildClaudeMdBlock(): string {
  return [
    CLAUDE_MD_BEGIN,
    '## token-goat',
    '',
    'Prefer token-goat commands over reading whole files:',
    '- `token-goat symbol NAME` -- find a function/class/type',
    '- `token-goat read "file::symbol"` -- one function/method body',
    '- `token-goat section "file::Heading"` -- one doc or config section',
    '- `token-goat semantic "description"` -- find code by meaning',
    '- `token-goat outline file` / `token-goat skeleton file` -- signatures without bodies',
    '',
    'Use this before a full-file `Read` or wide `Grep`, and before opening a large image',
    '(token-goat hooks shrink oversized images automatically). token-goat commands return',
    'narrow slices, typically 85-97% smaller than the full file.',
    CLAUDE_MD_END,
  ].join('\n')
}

function writeClaudeMdBlock(p: string): boolean {
  const block = buildClaudeMdBlock()
  let existing: string
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    existing = ''
  }

  const beginIdx = existing.indexOf(CLAUDE_MD_BEGIN)
  const endIdx = existing.indexOf(CLAUDE_MD_END)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    const after = existing.slice(endIdx + CLAUDE_MD_END.length)
    const current = existing.slice(beginIdx, endIdx + CLAUDE_MD_END.length)
    if (current === block) return false
    ensureDirSync(path.dirname(p))
    atomicWriteText(p, `${before}${block}${after}`)
    return true
  }

  const trimmed = existing.replace(/\s+$/, '')
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, next)
  return true
}

function stripClaudeMdBlock(p: string): boolean {
  let existing: string
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    return false
  }

  const beginIdx = existing.indexOf(CLAUDE_MD_BEGIN)
  const endIdx = existing.indexOf(CLAUDE_MD_END)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return false

  const before = existing.slice(0, beginIdx).replace(/\s+$/, '')
  const after = existing.slice(endIdx + CLAUDE_MD_END.length).replace(/^\s+/, '')

  let next: string
  if (before.length > 0 && after.length > 0) {
    next = `${before}\n\n${after}`
  } else if (before.length > 0) {
    next = `${before}\n`
  } else {
    next = after
  }

  atomicWriteText(p, next)
  return true
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

// --- token-goat skill writer ---
//
// README documents ~/.claude/skills/token-goat/SKILL.md as part of the base
// install too -- "the same routing guidance in skill form". Unlike CLAUDE.md,
// this directory belongs entirely to token-goat (nothing else writes into
// it), so install/uninstall can write/remove the whole file rather than
// patching a delimited region.

const SKILL_MD_CONTENT = `---
name: token-goat
description: Use before reading whole files or grepping wide. token-goat commands (symbol, read, section, semantic, outline, skeleton) return narrow slices of code and docs at a fraction of the token cost.
---

# token-goat

Prefer token-goat commands over reading whole files:
- \`token-goat symbol NAME\` -- find a function/class/type
- \`token-goat read "file::symbol"\` -- one function/method body
- \`token-goat section "file::Heading"\` -- one doc or config section
- \`token-goat semantic "description"\` -- find code by meaning
- \`token-goat outline file\` / \`token-goat skeleton file\` -- signatures without bodies

Read is the right call when the file is under about 200 lines, was never indexed (new or
untracked), or is an image (token-goat's hooks shrink oversized images automatically).

Image shrinking and repeat-read hints run on their own via hooks -- you do not call those
directly.
`

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
