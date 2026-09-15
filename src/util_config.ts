/**
 * Configuration file manipulation, hook stripping, and delimited block helpers.
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { removeCreatedBackups } from './bridges/created_configs.js'
import { assertWriteInScope } from './bridges/project_scope_guard.js'
import { atomicWriteText, backupFile, ensureDirSync } from './util.js'

/**
 * One hook entry as stored in a harness's `[[hooks.<Event>]]`/`hooks.<event>[]` config shape --
 * the minimal fields {@link stripOwnHooksFromMap} needs.
 */
export interface HookEntryLike {
  readonly command: string
}

/**
 * One matcher group under a hook event key -- the minimal fields {@link stripOwnHooksFromMap}
 * needs. Generic over the hook-entry type so each bridge's own richer interface (with its
 * harness-specific extra fields) is preserved through the spread in the returned groups.
 */
export interface MatcherGroupLike<H extends HookEntryLike> {
  readonly hooks?: readonly H[]
}

/** {@link MatcherGroupLike} plus the optional `matcher` field {@link stripStaleGroupHooks} needs. */
export interface MatcherGroupWithMatcher<H extends HookEntryLike> extends MatcherGroupLike<H> {
  readonly matcher?: string
}

/**
 * Shared by codex_install.ts's `uninstallCodex` and gemini_install.ts's `uninstallGemini`
 * (both harnesses use the same `Record<eventKey, matcherGroup[]>` hooks shape): strip
 * token-goat's own hook entries out of `hooks`, mutating it in place. A matcher group survives
 * if it still has non-token-goat hooks left, OR if it started with zero hooks (an empty group
 * is user data token-goat never wrote, so it's preserved rather than treated as "fully
 * stripped"). An event key whose every group was removed entirely is deleted. Returns true if
 * at least one hook entry was actually removed, so callers can skip writing the file back when
 * nothing changed.
 */
export function stripOwnHooksFromMap<H extends HookEntryLike, G extends MatcherGroupLike<H>>(
  hooks: Record<string, G[] | undefined>,
  isOurs: (command: string) => boolean,
): boolean {
  let removed = false
  for (const eventKey of Object.keys(hooks)) {
    const groups = hooks[eventKey]
    if (groups === undefined || !Array.isArray(groups)) continue
    const kept: G[] = []
    for (const group of groups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isOur = isOurs(h.command)
        if (isOur) removed = true
        return !isOur
      })
      if (keptHooks.length > 0) {
        kept.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        kept.push(group)
      }
    }
    if (kept.length > 0) {
      hooks[eventKey] = kept
    } else {
      delete hooks[eventKey]
    }
  }
  return removed
}

/**
 * Shared by codex_install.ts, gemini_install.ts, and qwen_install.ts's install functions: given
 * one hook event's existing matcher groups, strip out any stale token-goat hook entry (legacy
 * bare command, or a same-shape command whose baked entry path is no longer current) so a
 * re-install upgrades in place instead of leaving a dead duplicate.
 */
export function stripStaleGroupHooks<H extends HookEntryLike, G extends MatcherGroupWithMatcher<H>>(
  groups: readonly G[],
  isOurs: (command: string) => boolean,
  matcherFilter?: { readonly matcher: string | undefined },
): G[] {
  const list: readonly G[] = Array.isArray(groups) ? groups : []
  const next: G[] = []
  for (const group of list) {
    if (matcherFilter !== undefined && group.matcher !== matcherFilter.matcher) {
      next.push(group)
      continue
    }
    const keptHooks = (group.hooks ?? []).filter((h) => !isOurs(h.command))
    if (keptHooks.length > 0) {
      next.push({ ...group, hooks: keptHooks })
    } else if ((group.hooks ?? []).length === 0) {
      next.push(group)
    }
  }
  return next
}

/**
 * Shared by install.ts's `stripClaudeMdBlock` and codex_install.ts's `stripAgentsBlock`:
 * remove a delimited block (everything from `beginMarker` through the end of `endMarker`,
 * inclusive) from the file at `p`. Returns false without writing when the file can't be read
 * or the markers aren't found in order. Collapses the surrounding whitespace so removing the
 * block doesn't leave a run of blank lines behind.
 */
export function stripDelimitedBlock(p: string, beginMarker: string, endMarker: string, keepBackups = false): boolean {
  let existing: string
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    return false
  }

  const beginIdx = existing.indexOf(beginMarker)
  const endIdx = existing.indexOf(endMarker)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return false

  const before = existing.slice(0, beginIdx).replace(/\s+$/, '')
  const after = existing.slice(endIdx + endMarker.length).replace(/^\s+/, '')

  let next: string
  if (before.length > 0 && after.length > 0) {
    next = `${before}\n\n${after}`
  } else if (before.length > 0) {
    next = `${before}\n`
  } else {
    next = after
  }

  backupFile(p)
  atomicWriteText(p, next)
  if (!keepBackups) removeCreatedBackups(p)
  return true
}

/**
 * Shared by install.ts's `writeClaudeMdBlock` and codex_install.ts's `writeAgentsBlock`:
 * insert or update a delimited block in the file at `p`.
 */
export function upsertDelimitedBlock(p: string, beginMarker: string, endMarker: string, block: string): boolean {
  assertWriteInScope(p)
  let existing: string
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    existing = ''
  }

  const beginIdx = existing.indexOf(beginMarker)
  const endIdx = existing.indexOf(endMarker)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    const after = existing.slice(endIdx + endMarker.length)
    const current = existing.slice(beginIdx, endIdx + endMarker.length)
    if (current === block) return false
    ensureDirSync(path.dirname(p))
    backupFile(p)
    atomicWriteText(p, `${before}${block}${after}`)
    return true
  }

  const trimmed = existing.replace(/\s+$/, '')
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`
  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, next)
  return true
}

/**
 * Shared by install.ts, bridges/gemini_install.ts, and bridges/openclaw_install.ts: persist a
 * settings object as pretty-printed JSON with a trailing newline, backing up the prior file
 * first and creating `p`'s parent directory if needed.
 */
export function writeJsonSettings(p: string, settings: unknown): void {
  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * Shared by bridges/grok_install.ts and bridges/copilot_cli_install.ts: write `content` to `p`
 * only if it differs from what's already there (or the file doesn't exist), optionally backing
 * up the prior file first. Returns whether a write happened.
 */
export function writeIfDifferent(p: string, content: string, backup = false): boolean {
  let existing: string | undefined
  try {
    existing = readFileSync(p, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === content) return false
  if (backup) backupFile(p)
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, content)
  return true
}
