/**
 * session_start hook: re-inject a short command-routing reminder every time a
 * session starts, resumes, or restarts after compaction.
 *
 * install.ts's `buildClaudeMdBlock()` writes a one-time static routing block into
 * ~/.claude/CLAUDE.md at install time, and `token-goat install` also drops a
 * SKILL.md -- but neither is reinforced again during a session. Over a long
 * session that one-time prose competes against a strong base-training prior
 * toward Read/Grep with zero reinforcement, and the reactive PreToolUse hints
 * (hooks_read.ts etc.) only fire after the model has already reached for the
 * wrong tool. This hook re-surfaces the highest-leverage commands at every
 * SessionStart source Claude Code fires (startup, resume, clear, compact).
 *
 * Kept deliberately short (a handful of commands, not the full CLAUDE.md
 * block) since it costs tokens on every session start. Project-aware when
 * cheap: if the cwd resolves to an indexed project, names a concrete symbol
 * count instead of generic boilerplate. Gated on `hints.session_start_reminder`
 * (default true). Fails soft -- any error inside the handler returns `pass`,
 * never blocks session start.
 */

import { registerHook } from './hook_registry.js'
import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, contextOutput, getCwd } from './hooks_common.js'
import { loadConfig } from './config.js'
import { countSymbols } from './index_reader.js'
import { globalDbPath } from './constants.js'

/** Generic reminder used when the cwd is missing, unresolvable, or not indexed. */
const GENERIC_REMINDER =
  'token-goat: prefer surgical reads over Read/Grep on this codebase -- `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::Heading"`, `token-goat semantic "description"`, `token-goat outline <file>`. Run `token-goat index .` if this project is not indexed yet.'

/** Build the reminder string for `cwd`, naming a concrete indexed symbol count when available. */
function buildReminder(cwd: string | undefined): string {
  if (cwd === undefined) return GENERIC_REMINDER
  let symbolCount: number
  try {
    symbolCount = countSymbols({ rootDir: cwd }, globalDbPath())
  } catch {
    return GENERIC_REMINDER
  }
  if (symbolCount <= 0) return GENERIC_REMINDER
  return (
    `token-goat: this project is indexed (${symbolCount} symbols). Prefer \`symbol <name>\`, ` +
    `\`read "file::symbol"\`, \`section "file::Heading"\`, \`semantic "description"\`, or \`outline <file>\` ` +
    `over a full Read/Grep.`
  )
}

/** session_start handler: inject the reminder as context, gated on hints.session_start_reminder. */
export function sessionStartHandler(event: HookEvent): HookOutput {
  try {
    if (!loadConfig().hints.session_start_reminder) return passOutput()
    return contextOutput(buildReminder(getCwd(event)))
  } catch {
    return passOutput()
  }
}

registerHook('session_start', sessionStartHandler)
