/** The nudge after a tool call named a path that does not exist: when an existing path is plausibly the one meant (path_suggest.ts), say so once, so the model does not spend a `ls` and a retry finding it. Silent when nothing close exists. Only reached for a failure tool_error_class.ts classed `path_not_found`. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { applyHintTracking, uncorrelatedHint } from './hint_stats.js'
import { canQuoteArg, echoedValue, fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import { contextOutput, getCwd } from './hooks_common.js'
import { displaySafeText } from './paths.js'
import { suggestPaths } from './path_suggest.js'
import { resolveProjectRoot } from './project.js'
import { sessionSidecarPath } from './session_store.js'
import { atomicWriteText, ensureDirSync } from './util.js'

const SEEN_SUFFIX = '.path-miss'

/** Signatures remembered per session; the oldest is dropped past this. */
const MAX_SEEN = 50

/** Missing paths one failure is looked up for, at most: a command naming three missing files is answered for the first two. */
const MAX_MISSING_PATHS = 2

/** Longest path taken out of an error message. */
const MAX_PATH_CHARS = 512

/** Keys a tool call carries its path under, in the order they are tried: Claude Code's file_path and notebook_path, the `path` of Grep and Glob and of Copilot CLI's file tools, and Antigravity's TargetFile. */
const TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path', 'TargetFile'] as const

/** Shell and runtime wordings of a missing path, each capturing the path: coreutils `ls: cannot access 'x': No such file or directory`, Python `can't open file 'x': [Errno 2] No such file or directory`, Node `ENOENT: no such file or directory, open 'x'`. */
const QUOTED_PATH_PATTERNS: readonly RegExp[] = [
  /(?:cannot|can't|could not) (?:access|open|stat|read|find)(?: file)? '([^']+)'.*No such file or directory/,
  /ENOENT: no such file or directory, \w+ '([^']+)'/,
]

/** The program (and `line N`) prefixes of `prog: path: No such file or directory`, as `cat: x: ...` and `bash: line 1: ./x.sh: ...` write them. */
const SHELL_PREFIX = /^(?:(?:[\w.+-]+|line \d+): )+/

const NO_SUCH_FILE = /:\s*No such file or directory\s*$/

/** The paths a failed Bash command reported as missing, in the order they were reported. */
export function missingPathsFromStderr(errorText: string): string[] {
  const found: string[] = []
  for (const raw of errorText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!/No such file or directory/i.test(line)) continue
    let target: string | undefined
    for (const pattern of QUOTED_PATH_PATTERNS) {
      target = pattern.exec(line)?.[1]
      if (target !== undefined) break
    }
    if (target === undefined && NO_SUCH_FILE.test(line)) target = line.replace(NO_SUCH_FILE, '').replace(SHELL_PREFIX, '')
    if (target !== undefined && target !== '' && target.length <= MAX_PATH_CHARS && !found.includes(target)) found.push(target)
  }
  return found
}

/** The path a non-Bash tool call named, or undefined. */
function pathFromToolInput(event: HookEvent): string | undefined {
  for (const key of TOOL_PATH_KEYS) {
    const value = event.toolInput[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function seenPath(event: HookEvent): string | null {
  return event.sessionId ? sessionSidecarPath(sessionStateKey(event), SEEN_SUFFIX) : null
}

function readSeen(target: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function writeSeen(target: string, seen: string[]): void {
  try {
    ensureDirSync(dirname(target))
    atomicWriteText(target, JSON.stringify(seen.slice(-MAX_SEEN)))
  } catch {
    // Best-effort, like the failure ledger: an unwritten entry only means the same miss may be answered twice.
  }
}

/** A hash rather than the path: the memory of what was said needs only to match, not to be read back. */
function signatureOf(cwd: string, missing: string): string {
  return createHash('sha256').update(`${cwd}\0${missing}`).digest('hex').slice(0, 16)
}

/** One candidate as a fenced, quoted argument, or null when no quote mark holds it or it carries a backtick that would close the fence. */
function fencedCandidate(candidate: string): string | null {
  const shown = displaySafeText(candidate)
  if (shown !== candidate || shown.includes('`') || !canQuoteArg(shown)) return null
  return fencedCommand(quotedArg(shown))
}

/** The line to append to a `path_not_found` failure's advice, or null when no path was named, nothing close exists, or this miss was already answered this session. */
export function pathMissAfterFailure(event: HookEvent, failure: { toolName: string | undefined; errorText: string }): string | null {
  try {
    const target = seenPath(event)
    if (target === null) return null
    const named = failure.toolName === 'Bash' ? missingPathsFromStderr(failure.errorText) : [pathFromToolInput(event)].filter((p): p is string => p !== undefined)
    if (named.length === 0) return null
    const cwd = getCwd(event) ?? process.cwd()
    const rootDir = resolveProjectRoot({ project: cwd })
    const seen = readSeen(target)
    const lines: string[] = []
    for (const missing of named.slice(0, MAX_MISSING_PATHS)) {
      const signature = signatureOf(cwd, missing)
      if (seen.includes(signature)) continue
      seen.push(signature)
      const fenced = suggestPaths(missing, cwd, rootDir).map(fencedCandidate).filter((c): c is string => c !== null)
      if (fenced.length === 0) continue
      lines.push(`[token-goat] ${echoedValue(missing)} does not exist. Existing paths that look like it:`, ...fenced)
    }
    writeSeen(target, seen)
    if (lines.length === 0) return null
    const out = applyHintTracking(event, contextOutput(lines.join('\n')), uncorrelatedHint('path_miss'))
    return out.hookType === 'context' ? out.context : null
  } catch {
    return null
  }
}
