import type { FirstReadSymbolPolicy } from './config_types.js'
import type { HookEvent } from './hook_registry.js'
import { getReadNavigationEvidence, type NavigationEvidence } from './index_reader.js'
import { editAnywayHint, estimateRequestedSlice, readRequestedSliceWindow } from './hooks_read_slice.js'
import { displaySafePath, displaySafeText } from './paths.js'

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

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

/**
 * Pure decision evaluator for first-read symbol policy.
 * Identifies broad/whole-file reads on large indexed files with symbols or headings,
 * while allowing small bounded slices (e.g. view_range: [1, 50] or small offset/limit).
 */
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

  // Check requested slice window: bounded small slices bypass warning and denial
  const window = readRequestedSliceWindow(event)
  if (window.isExplicitSlice && window.limit !== undefined && window.limit > 0) {
    const slice = estimateRequestedSlice(event, normalizedPath)
    if (slice.kind === 'bytes' && slice.bytes < firstReadSymbolBytes) {
      return { action: 'allow' }
    }
    if (slice.kind === 'nearSingleLine') {
      return { action: 'allow' }
    }
  }

  // Obtain navigation evidence
  const evidence = ctx.navigationEvidence !== undefined
    ? ctx.navigationEvidence
    : getReadNavigationEvidence(normalizedPath)

  if (!evidence) return { action: 'allow' }
  const totalSymbols = evidence.symbolCount + evidence.headingCount
  if (totalSymbols === 0) return { action: 'allow' }

  // Generate surgical suggestions
  const suggestions: string[] = []
  const safeShown = displaySafePath(shownPath)

  if (evidence.symbolCount > 0 && evidence.topSymbols.length > 0) {
    const top = evidence.topSymbols[0]!
    const safeSymbolName = displaySafeText(top.name)
    suggestions.push(`token-goat read "${safeShown}::${safeSymbolName}"`)
  } else if (evidence.headingCount > 0 && evidence.topHeadings.length > 0) {
    const top = evidence.topHeadings[0]!
    const safeHeadingName = displaySafeText(top.name)
    suggestions.push(`token-goat section "${safeShown}::${safeHeadingName}"`)
  }

  suggestions.push(`token-goat outline "${safeShown}"`)
  suggestions.push(`token-goat skeleton "${safeShown}"`)

  const primaryCommand = suggestions[0]!
  const kb = formatKb(fileSize)
  const symbolDetails = evidence.symbolCount > 0
    ? `${evidence.symbolCount} indexed symbol${evidence.symbolCount === 1 ? '' : 's'}`
    : `${evidence.headingCount} indexed heading${evidence.headingCount === 1 ? '' : 's'}`

  if (firstReadSymbolPolicy === 'deny') {
    const message =
      `Run \`${primaryCommand}\` to read surgically. ` +
      `${safeShown} is large (${kb}KB with ${symbolDetails}). Whole-file first read denied by first_read_symbol_policy. ` +
      `Use \`token-goat outline "${safeShown}"\` or \`token-goat skeleton "${safeShown}"\` to map structure, or re-read with offset/limit for a specific line slice. ` +
      editAnywayHint(normalizedPath)

    return {
      action: 'deny',
      reason: 'first_read_symbol_deny',
      message,
      suggestions,
      symbolCount: totalSymbols,
    }
  }

  // Warn (advisory) mode
  const message =
    `Run \`${primaryCommand}\` to read surgically. ` +
    `${safeShown} is ${kb}KB with ${symbolDetails}; prefer surgical reads or \`token-goat outline "${safeShown}"\` over reading the whole file.`

  return {
    action: 'warn',
    reason: 'first_read_symbol_warn',
    message,
    suggestions,
    symbolCount: totalSymbols,
  }
}
