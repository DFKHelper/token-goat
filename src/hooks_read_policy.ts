import type { FirstReadSymbolPolicy, HintsConfig } from './config_types.js'
import type { HookEvent } from './hook_registry.js'
import { getReadNavigationEvidence, type NavigationEvidence } from './read_navigation_evidence.js'
import {
  describeSliceAdvice,
  editAnywayHint,
  estimateRequestedSlice,
  isSmallSlice,
  readRequestedSliceWindow,
  type RequestedSlice,
  type RequestedSliceWindow,
} from './hooks_read_slice.js'
import { displaySafePath } from './paths.js'
import { fencedCommand, leadWithCommand, quotedArg } from './hint_suggestion_guard.js'
import { hintTargetFromNames } from './hint_target.js'
import { countNoun, isWithinQuietHours } from './util.js'

/** Everything the evaluator reads, so it stays pure: the window and slice the caller already sized, and whether quiet hours hold back a warning. */
export interface ReadPolicyContext {
  readonly event: HookEvent
  readonly normalizedPath: string
  readonly shownPath: string
  readonly fileSize: number
  readonly window: RequestedSliceWindow
  readonly slice: RequestedSlice
  readonly quiet: boolean
  readonly firstReadSymbolBytes: number
  readonly firstReadSymbolPolicy: FirstReadSymbolPolicy
  readonly navigationEvidence?: NavigationEvidence | null
}

export type ReadPolicyDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'warn' | 'deny'; readonly message: string }

export function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

/** The size gate every first-read policy path shares: the policy is on, the byte threshold is positive, and the file reaches it. */
export function meetsFirstReadSymbolThreshold(policy: FirstReadSymbolPolicy, thresholdBytes: number, size: number): boolean {
  return policy !== 'off' && thresholdBytes > 0 && size >= thresholdBytes
}

/** Builds the evaluator's input at a call site from the config it already loaded. A caller that sized the window or slice passes them in; otherwise they are worked out here, the slice only when the read names a bounded window. */
export function buildReadPolicyContext(args: {
  readonly event: HookEvent
  readonly normalizedPath: string
  readonly shownPath: string
  readonly fileSize: number
  readonly hints: HintsConfig
  readonly window?: RequestedSliceWindow
  readonly slice?: RequestedSlice
}): ReadPolicyContext {
  const { event, normalizedPath, hints } = args
  const window = args.window ?? readRequestedSliceWindow(event)
  const slice = args.slice ?? (window.isExplicitSlice ? estimateRequestedSlice(event, normalizedPath) : { kind: 'unbounded' as const })
  return {
    event,
    normalizedPath,
    shownPath: args.shownPath,
    fileSize: args.fileSize,
    window,
    slice,
    quiet: isWithinQuietHours(hints.quiet_hours),
    firstReadSymbolBytes: hints.first_read_symbol_bytes,
    firstReadSymbolPolicy: hints.first_read_symbol_policy,
  }
}

/** Pure decision evaluator for first-read symbol policy. Identifies broad/whole-file reads on large indexed files with symbols or headings, while allowing small bounded slices (e.g. view_range: [1, 50] or small offset/limit). */
export function evaluateFirstReadSymbolPolicy(ctx: ReadPolicyContext): ReadPolicyDecision {
  const {
    event,
    normalizedPath,
    shownPath,
    fileSize,
    firstReadSymbolBytes,
    firstReadSymbolPolicy,
  } = ctx

  if (!meetsFirstReadSymbolThreshold(firstReadSymbolPolicy, firstReadSymbolBytes, fileSize)) return { action: 'allow' }
  if (event.toolName === 'Grep') return { action: 'allow' }
  // Quiet hours hold back advice, never a block: a deny stays in force, as every other deny in hooks_read.ts does.
  if (firstReadSymbolPolicy === 'warn' && ctx.quiet) return { action: 'allow' }

  // A bounded small slice bypasses warning and denial.
  if (ctx.window.isExplicitSlice && isSmallSlice(ctx.slice, firstReadSymbolBytes)) return { action: 'allow' }

  // Obtain navigation evidence
  const evidence = ctx.navigationEvidence !== undefined
    ? ctx.navigationEvidence
    : getReadNavigationEvidence(normalizedPath)

  if (!evidence || evidence.isStale) return { action: 'allow' }
  if (evidence.symbolCount + evidence.headingCount === 0) return { action: 'allow' }

  // Generate surgical suggestions. Every path goes through quotedArg: a `$` or backtick in a raw double-quoted path makes relay.ts's stripUnsafeSuggestions cut the command out, and with it everything up to the line's last backtick.
  const safeShown = displaySafePath(shownPath)
  const surgicalCommands: string[] = []

  if (evidence.symbolCount > 0 && evidence.topSymbols.length > 0) {
    const target = hintTargetFromNames(evidence.topSymbols.map((s) => s.name), 'symbol')
    if (target.real) {
      surgicalCommands.push('token-goat read ' + quotedArg(`${safeShown}::${target.name}`))
    }
  } else if (evidence.headingCount > 0 && evidence.topHeadings.length > 0) {
    const target = hintTargetFromNames(evidence.topHeadings.map((h) => h.name), 'section')
    if (target.real) {
      surgicalCommands.push('token-goat section ' + quotedArg(`${safeShown}::${target.name}`))
    }
  }

  const outlineCommand = 'token-goat outline ' + quotedArg(safeShown)
  const skeletonCommand = 'token-goat skeleton ' + quotedArg(safeShown)
  const primaryCommand = surgicalCommands[0] ?? outlineCommand
  const kb = formatKb(fileSize)
  const symbolDetails = evidence.symbolCount > 0
    ? `${countNoun(evidence.symbolCount, 'indexed symbol')}`
    : `${countNoun(evidence.headingCount, 'indexed heading')}`

  // A file the scan reads as a few very long lines has no line slice to retry with, so offer the byte-range advice the large-file deny gives instead of a window the next read would meet again.
  const sliceAdvice = ctx.window.isExplicitSlice && ctx.slice.kind === 'nearSingleLine'
    ? '. ' + describeSliceAdvice(ctx.slice, normalizedPath)
    : ', or re-read with offset/limit for a specific line slice.'

  if (firstReadSymbolPolicy === 'deny') {
    // The edit-anyway hint keeps its own line: where the quoting cannot place a refused command's end, the relay guard cuts it to its line's last backtick, so on a shared line a refused outline command would take the rest of the explanation with it.
    const message =
      leadWithCommand(
        primaryCommand,
        'to read surgically',
        `This file is large (${kb}KB with ${symbolDetails}). Whole-file first read denied by first_read_symbol_policy. ` +
        `Use ${fencedCommand(outlineCommand)} or ${fencedCommand(skeletonCommand)} to map structure${sliceAdvice}`,
      ) +
      '\n' + editAnywayHint(normalizedPath)

    return { action: 'deny', message }
  }

  // Warn (advisory) mode
  const message = leadWithCommand(
    primaryCommand,
    'to read surgically',
    `This file is ${kb}KB with ${symbolDetails}; prefer surgical reads or ${fencedCommand(outlineCommand)} over reading the whole file.`,
  )

  return { action: 'warn', message }
}
