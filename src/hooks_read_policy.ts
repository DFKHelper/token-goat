import type { FirstReadSymbolPolicy } from './config_types.js'
import type { HookEvent } from './hook_registry.js'
import { getReadNavigationEvidence, type NavigationEvidence } from './index_reader.js'
import { editAnywayHint, estimateRequestedSlice, readRequestedSliceWindow } from './hooks_read_slice.js'
import { displaySafePath } from './paths.js'
import { fencedCommand, leadWithCommand, quotedArg, stripUnsafeSuggestions } from './hint_suggestion_guard.js'
import { isWithinQuietHours } from './util.js'
import { loadConfig } from './config.js'

export interface ReadPolicyContext {
  readonly event: HookEvent
  readonly normalizedPath: string
  readonly shownPath: string
  readonly fileSize: number
  readonly isFirstRead: boolean
  readonly firstReadSymbolBytes: number
  readonly firstReadSymbolPolicy: FirstReadSymbolPolicy
  readonly navigationEvidence?: NavigationEvidence | null
}

export type ReadPolicyDecision =
  | { readonly action: 'allow' }
  | {
      readonly action: 'warn'
      readonly reason: string
      readonly message: string
      readonly suggestions: readonly string[]
      readonly symbolCount: number
    }
  | {
      readonly action: 'deny'
      readonly reason: string
      readonly message: string
      readonly suggestions: readonly string[]
      readonly symbolCount: number
    }

export function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

/** Validates and sanitizes a candidate symbol or heading name for safe inclusion in an executable CLI suggestion string. Rejects symbols with shell-metacharacters, newlines, quotes, or suspicious length. */
export function safeSuggestionTarget(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 80) return null
  if (/[\r\n\t`"';\\${}|&<>*?~]/.test(trimmed)) return null
  if (trimmed.includes('::')) return null
  const probe = `token-goat read "test.ts::${trimmed}"`
  if (stripUnsafeSuggestions(probe) !== probe) return null
  return trimmed
}

/** Pure decision evaluator for first-read symbol policy. Identifies broad/whole-file reads on large indexed files with symbols or headings, while allowing small bounded slices (e.g. view_range: [1, 50] or small offset/limit). */
export function evaluateFirstReadSymbolPolicy(ctx: ReadPolicyContext): ReadPolicyDecision {
  const {
    event,
    normalizedPath,
    shownPath,
    fileSize,
    isFirstRead,
    firstReadSymbolBytes,
    firstReadSymbolPolicy,
  } = ctx

  if (firstReadSymbolPolicy === 'off') return { action: 'allow' }
  if (firstReadSymbolBytes <= 0) return { action: 'allow' }
  if (!isFirstRead) return { action: 'allow' }
  if (event.toolName === 'Grep') return { action: 'allow' }
  if (fileSize < firstReadSymbolBytes) return { action: 'allow' }
  // Quiet hours hold back advice, never a block: a deny stays in force, as every other deny in hooks_read.ts does.
  if (firstReadSymbolPolicy === 'warn' && isWithinQuietHours(loadConfig().hints.quiet_hours)) return { action: 'allow' }

  // Check requested slice window: bounded small slices bypass warning and denial
  const window = readRequestedSliceWindow(event)
  if (window.isExplicitSlice && window.limit !== undefined && window.limit > 0) {
    const slice = estimateRequestedSlice(event, normalizedPath)
    if (slice.kind === 'bytes' && slice.bytes < firstReadSymbolBytes) {
      return { action: 'allow' }
    }
  }

  // Obtain navigation evidence
  const evidence = ctx.navigationEvidence !== undefined
    ? ctx.navigationEvidence
    : getReadNavigationEvidence(normalizedPath)

  if (!evidence || evidence.isStale) return { action: 'allow' }
  const totalSymbols = evidence.symbolCount + evidence.headingCount
  if (totalSymbols === 0) return { action: 'allow' }

  // Generate surgical suggestions. Every path goes through quotedArg: a `$` or backtick in a raw double-quoted path makes relay.ts's stripUnsafeSuggestions cut the command out, and with it everything up to the line's last backtick.
  const suggestions: string[] = []
  const safeShown = displaySafePath(shownPath)

  if (evidence.symbolCount > 0 && evidence.topSymbols.length > 0) {
    const top = evidence.topSymbols[0]!
    const safeName = safeSuggestionTarget(top.name)
    if (safeName) {
      suggestions.push('token-goat read ' + quotedArg(`${safeShown}::${safeName}`))
    }
  } else if (evidence.headingCount > 0 && evidence.topHeadings.length > 0) {
    const top = evidence.topHeadings[0]!
    const safeName = safeSuggestionTarget(top.name)
    if (safeName) {
      suggestions.push('token-goat section ' + quotedArg(`${safeShown}::${safeName}`))
    }
  }

  const outlineCommand = 'token-goat outline ' + quotedArg(safeShown)
  const skeletonCommand = 'token-goat skeleton ' + quotedArg(safeShown)
  suggestions.push(outlineCommand, skeletonCommand)

  const primaryCommand = suggestions[0]!
  const kb = formatKb(fileSize)
  const symbolDetails = evidence.symbolCount > 0
    ? `${evidence.symbolCount} indexed symbol${evidence.symbolCount === 1 ? '' : 's'}`
    : `${evidence.headingCount} indexed heading${evidence.headingCount === 1 ? '' : 's'}`

  if (firstReadSymbolPolicy === 'deny') {
    // The edit-anyway hint keeps its own line: the relay guard cuts a refused command to its line's last backtick, so on a shared line a refused outline command would take the rest of the explanation with it.
    const message =
      leadWithCommand(
        primaryCommand,
        'to read surgically',
        `${safeShown} is large (${kb}KB with ${symbolDetails}). Whole-file first read denied by first_read_symbol_policy. ` +
        `Use ${fencedCommand(outlineCommand)} or ${fencedCommand(skeletonCommand)} to map structure, or re-read with offset/limit for a specific line slice.`,
      ) +
      '\n' + editAnywayHint(normalizedPath)

    return {
      action: 'deny',
      reason: 'first_read_symbol_deny',
      message,
      suggestions,
      symbolCount: totalSymbols,
    }
  }

  // Warn (advisory) mode
  const message = leadWithCommand(
    primaryCommand,
    'to read surgically',
    `${safeShown} is ${kb}KB with ${symbolDetails}; prefer surgical reads or ${fencedCommand(outlineCommand)} over reading the whole file.`,
  )

  return {
    action: 'warn',
    reason: 'first_read_symbol_warn',
    message,
    suggestions,
    symbolCount: totalSymbols,
  }
}
