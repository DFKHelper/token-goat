/**
 * Accounting for the context the harness injects and token-goat's hooks never see.
 *
 * `waste` attributes tool-call cost, which is the part token-goat mediates. Measured against real
 * transcripts, that part is no longer where the bulk of the context lives: across the six largest
 * transcripts on this machine, `tool_result` content is a small fraction of what arrives as
 * harness-injected `attachment` lines -- `task_reminder` alone was 126.9 MB over 5,689 events
 * (avg 21.8 KB), re-injected in full whenever the task list changes. None of it passes through a
 * hook, so nothing could intercept it; but all of it is written to the transcript file whose path
 * every hook payload already carries, so it can at least be counted and reported.
 *
 * Transcript shapes this module reads (undocumented harness internals, confirmed empirically
 * against `~/.claude/projects/<slug>/*.jsonl`, and parsed defensively because a shape change must
 * degrade to zero counts rather than to an exception in a hook):
 *
 * - `{ attachment: { type, ... } }` -- one injected context block. `task_reminder` additionally
 *   carries `itemCount` and `content: [{ id, subject, description, activeForm, status, owner,
 *   blocks, blockedBy }]`, where `status` is `completed` | `in_progress` | `pending`.
 * - `{ type: 'user', isMeta: true, message: { content } }` -- among other things, a slash command's
 *   full skill body, expanded into prompt text. This is a different path from the Skill tool, and
 *   the `<!-- COMPACT_END -->` marker that trims a Skill-tool load does not apply to it.
 * - `{ type: 'system', subtype: 'compact_boundary' }` -- the authoritative record that a compaction
 *   happened. Counting `SessionStart` hook firings instead conflates compactions with plain session
 *   resumes; this marker does not.
 *
 * Everything here counts *injected bytes*, which is what the transcript actually records. How long
 * any of it stays resident, and what it is ultimately billed at, is not recorded anywhere this code
 * can see -- so the token figures are labelled estimates and the rendered text says "injected",
 * never "billed". This mirrors the existing "re-send CEILING, not real spend" discipline in
 * waste.ts, and exists for the same reason.
 */

import * as fs from 'node:fs'

import { estimateTokensFromLength } from './overflow_guard.js'

/**
 * A task list at or above this size is worth telling the agent about. Measured: lists that stayed
 * lean cost almost nothing across a whole session, while a single 613 KB reminder re-injected
 * hundreds of times dominated its session's new context.
 */
export const LARGE_TASK_LIST_BYTES = 20_000

/** A slash-expanded skill body at or above this size is worth attributing when it repeats. */
export const LARGE_SKILL_BODY_BYTES = 20_000

/** A skill body injected this many times is a repeat worth reporting. */
export const SKILL_BODY_REPEAT_THRESHOLD = 2

/**
 * How much of the transcript tail a hook may read. A hook runs on the user's turn and its startup
 * cost already dominates its logic, so the scan is bounded by bytes rather than by line count: the
 * records this module cares about are appended, and the newest task list is the only one that can
 * still be acted on.
 */
export const RESIDENT_TAIL_MAX_BYTES = 1_048_576

/** Per-class rollup of injected attachment bytes. */
export interface AttachmentClassCost {
  type: string
  count: number
  bytes: number
}

/** The composition of one `task_reminder` injection, which is what makes it actionable. */
export interface TaskListSnapshot {
  /** Size of the transcript line carrying this reminder. */
  bytes: number
  itemCount: number
  completed: number
  inProgress: number
  pending: number
  /** Total bytes of every item's `description` field. */
  descriptionBytes: number
  /** Bytes of `description` on completed items only -- the portion that can be pruned. */
  completedDescriptionBytes: number
}

/** One skill whose full body was injected as prompt text by slash-command expansion. */
export interface SkillBodyInjection {
  skill: string
  count: number
  bytes: number
}

/** Mutable accumulator. Built by {@link createResidentContextStats}, fed by {@link accumulateResidentLine}. */
export interface ResidentContextStats {
  attachmentsByType: Map<string, { count: number; bytes: number }>
  /** The most recent task list seen, which is the only one still worth acting on. */
  latestTaskList: TaskListSnapshot | null
  taskReminderCount: number
  taskReminderBytes: number
  skillBodies: Map<string, { count: number; bytes: number }>
  compactionCount: number
}

export function createResidentContextStats(): ResidentContextStats {
  return {
    attachmentsByType: new Map(),
    latestTaskList: null,
    taskReminderCount: 0,
    taskReminderBytes: 0,
    skillBodies: new Map(),
    compactionCount: 0,
  }
}

function bump(map: Map<string, { count: number; bytes: number }>, key: string, bytes: number): void {
  const entry = map.get(key)
  if (entry === undefined) map.set(key, { count: 1, bytes })
  else {
    entry.count += 1
    entry.bytes += bytes
  }
}

/** Flatten a `message.content` that is either a plain string or an array of `{type:'text',text}` blocks. */
function messageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>)['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as Record<string, unknown>)['text']
    if (typeof text === 'string') out += text
  }
  return out
}

/**
 * Name of the skill whose body this text is, or null if it does not look like one.
 *
 * The `Base directory for this skill:` preamble is preferred over the body's own H1 because it
 * carries the directory name, which is the name the user actually types after the slash -- an H1
 * reads "Superman (Claude Skill)" where the invocation is `/superman`. The H1 is the fallback for
 * bodies injected without the preamble.
 */
export function skillNameFromBody(text: string): string | null {
  const dir = /^Base directory for this skill:\s*(.+?)\s*$/m.exec(text)
  if (dir?.[1] !== undefined) {
    const segments = dir[1].split(/[\\/]/).filter((s) => s.length > 0)
    const last = segments[segments.length - 1]
    if (last !== undefined && last.length > 0) return last
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(text)
  if (heading?.[1] !== undefined && heading[1].length > 0) return heading[1]
  return null
}

/** Read one `task_reminder` attachment's `content` array into a snapshot. */
function readTaskList(attachment: Record<string, unknown>, bytes: number): TaskListSnapshot {
  const snapshot: TaskListSnapshot = {
    bytes,
    itemCount: typeof attachment['itemCount'] === 'number' ? attachment['itemCount'] : 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
    descriptionBytes: 0,
    completedDescriptionBytes: 0,
  }
  const content = attachment['content']
  if (!Array.isArray(content)) return snapshot
  // `itemCount` is the harness's own figure and is trusted when present, but an empty or trimmed
  // `content` must not silently report a full list, so the walked length wins when it is larger.
  if (content.length > snapshot.itemCount) snapshot.itemCount = content.length
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const status = typeof record['status'] === 'string' ? record['status'] : ''
    const description = typeof record['description'] === 'string' ? record['description'] : ''
    snapshot.descriptionBytes += description.length
    if (status === 'completed') {
      snapshot.completed += 1
      snapshot.completedDescriptionBytes += description.length
    } else if (status === 'in_progress') snapshot.inProgress += 1
    else if (status === 'pending') snapshot.pending += 1
  }
  return snapshot
}

/**
 * Fold one already-parsed transcript line into `acc`.
 *
 * `bytes` is the size of the raw line the object came from, passed in rather than recomputed: every
 * caller already has the string, and re-serializing to measure it would both cost more and report a
 * different number than the file actually holds.
 *
 * Never throws. The shapes above are undocumented and can change without notice, and one of this
 * function's two callers is a hook on the user's turn.
 */
/**
 * Fold an `invoked_skills` attachment's bodies into the skill accumulator.
 *
 * Each entry is `{name, path, content}`. The name is taken from `name` when present and otherwise
 * from the last segment of `path`, which is the same rule {@link skillNameFromBody} uses for the
 * slash-expansion channel -- both end up keyed on the name the user types after the slash, so the
 * two channels aggregate together instead of splitting one skill across two labels.
 *
 * Applies the same size floor as the other channel. A body arriving here is often truncated by the
 * harness to a fixed cap, so it is the injection COUNT that carries the signal, not the length.
 */
function collectInvokedSkills(acc: ResidentContextStats, record: Record<string, unknown>): void {
  const skills = record['skills']
  if (!Array.isArray(skills)) return
  for (const entry of skills) {
    if (entry === null || typeof entry !== 'object') continue
    const skill = entry as Record<string, unknown>
    const content = skill['content']
    if (typeof content !== 'string' || content.length < LARGE_SKILL_BODY_BYTES) continue
    const name = skillName(skill)
    if (name !== null) bump(acc.skillBodies, name, content.length)
  }
}

/** The skill's name from an `invoked_skills` entry: explicit `name`, else the last path segment. */
function skillName(skill: Record<string, unknown>): string | null {
  const name = skill['name']
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  const path = skill['path']
  if (typeof path !== 'string') return null
  const segments = path.split(/[\\/]/).filter((part) => part !== '')
  const last = segments[segments.length - 1]
  return last === undefined || last === '' ? null : last
}

export function accumulateResidentLine(acc: ResidentContextStats, parsed: unknown, bytes: number): void {
  try {
    if (parsed === null || typeof parsed !== 'object') return
    const line = parsed as Record<string, unknown>

    if (line['type'] === 'system' && line['subtype'] === 'compact_boundary') acc.compactionCount += 1

    const attachment = line['attachment']
    if (attachment !== null && typeof attachment === 'object') {
      const record = attachment as Record<string, unknown>
      const type = typeof record['type'] === 'string' ? record['type'] : 'unknown'
      bump(acc.attachmentsByType, type, bytes)
      if (type === 'task_reminder') {
        acc.taskReminderCount += 1
        acc.taskReminderBytes += bytes
        acc.latestTaskList = readTaskList(record, bytes)
      }
      // A skill body reaches the model through TWO channels, and counting only one of them
      // under-reports the same skill several-fold. Slash expansion sends it as prompt text (the
      // isMeta branch below); the Skill tool sends it here, as `{skills:[{name, path, content}]}`.
      // Measured on a real transcript: `superman` arrived 94 times this way against 12 the other,
      // so attributing only the isMeta channel credited under a third of one skill's real cost.
      // Both feed the same accumulator, so a repeat is a repeat regardless of how it arrived.
      if (type === 'invoked_skills') collectInvokedSkills(acc, record)
    }

    if (line['isMeta'] === true && line['type'] === 'user') {
      const text = messageText(line['message'])
      if (text.length >= LARGE_SKILL_BODY_BYTES) {
        const skill = skillNameFromBody(text)
        if (skill !== null) bump(acc.skillBodies, skill, text.length)
      }
    }
  } catch {
    // A shape this code did not expect is missing data, not a failure: counting nothing is correct,
    // and throwing out of a hook would be worse than under-reporting.
  }
}

/** Read `acc` into sorted, rendering-ready lists. */
export interface ResidentContextSummary {
  attachmentClasses: AttachmentClassCost[]
  totalAttachmentBytes: number
  latestTaskList: TaskListSnapshot | null
  taskReminderCount: number
  taskReminderBytes: number
  /** Skill bodies injected more than once, largest first. */
  repeatedSkillBodies: SkillBodyInjection[]
  compactionCount: number
}

export function summarizeResidentContext(acc: ResidentContextStats): ResidentContextSummary {
  const attachmentClasses = [...acc.attachmentsByType.entries()]
    .map(([type, v]) => ({ type, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.type.localeCompare(b.type))
  const repeatedSkillBodies = [...acc.skillBodies.entries()]
    .filter(([, v]) => v.count >= SKILL_BODY_REPEAT_THRESHOLD)
    .map(([skill, v]) => ({ skill, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.skill.localeCompare(b.skill))
  return {
    attachmentClasses,
    totalAttachmentBytes: attachmentClasses.reduce((n, c) => n + c.bytes, 0),
    latestTaskList: acc.latestTaskList,
    taskReminderCount: acc.taskReminderCount,
    taskReminderBytes: acc.taskReminderBytes,
    repeatedSkillBodies,
    compactionCount: acc.compactionCount,
  }
}

/** `1234567` -> `1.2 MB`, `21800` -> `21 KB`. Sizes here span three orders of magnitude. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** `52000` -> `52K`. Token counts here are estimates and a rounded magnitude is the honest precision. */
export function formatTokenEstimate(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1000)}K` : String(tokens)
}

/**
 * Advice for an oversized task list, or null when there is nothing worth saying.
 *
 * Deliberately advisory. A task list can hold items owned by other agents in a multi-agent session,
 * so this names the tool the agent would use and leaves the decision there; token-goat never edits
 * a task itself.
 */
export function taskListPruneHint(snapshot: TaskListSnapshot | null): string | null {
  if (snapshot === null) return null
  if (snapshot.bytes < LARGE_TASK_LIST_BYTES) return null
  if (snapshot.completed === 0) return null
  const tokens = formatTokenEstimate(estimateTokensFromLength(snapshot.bytes))
  const prunable = formatBytes(snapshot.completedDescriptionBytes)
  return (
    `Your task list is ${formatBytes(snapshot.bytes)} (~${tokens} tok est) and is re-injected in full whenever it changes; ` +
    `${snapshot.completed} of ${snapshot.itemCount} items are already completed and their descriptions alone are ${prunable}. ` +
    'Prune completed items or shorten their descriptions with TaskUpdate. Check ownership first if other agents share this list.'
  )
}

/**
 * Advice for a skill body that slash-command expansion has injected more than once, or null.
 *
 * token-goat cannot prevent the injection -- the harness owns slash expansion, and it happens
 * before any hook runs. This reports what it cost and points at the two things that do help.
 */
export function repeatedSkillBodyHint(injections: readonly SkillBodyInjection[]): string | null {
  const worst = injections[0]
  if (worst === undefined) return null
  if (worst.count < SKILL_BODY_REPEAT_THRESHOLD || worst.bytes < LARGE_SKILL_BODY_BYTES) return null
  const tokens = formatTokenEstimate(estimateTokensFromLength(worst.bytes))
  return (
    `The \`${worst.skill}\` skill body has been injected ${worst.count} times this session ` +
    `(${formatBytes(worst.bytes)} total, ~${tokens} tok est). Slash expansion and the Skill tool both send the ` +
    'whole body every time, and no hook can intercept either. If it is already loaded, work from it instead of ' +
    're-invoking; to reread one part, ' +
    `use \`token-goat skill-section ${worst.skill} '<heading>'\`.`
  )
}

/**
 * The last `maxBytes` of a transcript, split into lines.
 *
 * Reads a byte window rather than the whole file so a hook's cost stays bounded on a transcript
 * that has grown to hundreds of megabytes. When the window starts mid-file it almost certainly
 * starts mid-line; that leading fragment is dropped, because it is neither parseable nor a correct
 * measure of the record it belongs to.
 *
 * Returns an empty list for anything unreadable -- a hook has no better answer than "no data".
 */
export function readTranscriptTail(transcriptPath: string, maxBytes: number = RESIDENT_TAIL_MAX_BYTES): string[] {
  let fd: number | null = null
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return []
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    fd = fs.openSync(transcriptPath, 'r')
    const buf = Buffer.allocUnsafe(length)
    const read = fs.readSync(fd, buf, 0, length, start)
    const lines = buf.subarray(0, read).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Closing a descriptor that is already gone is not a reportable condition.
      }
    }
  }
}

/**
 * Cheap pre-parse test: could this raw line carry a signal {@link accumulateResidentLine} acts on?
 *
 * A transcript tail is mostly assistant text and tool results, none of which this module counts, and
 * `JSON.parse` on all of it is the dominant cost of a hook-side scan. A substring test is roughly
 * two orders of magnitude cheaper and rejects the overwhelming majority of lines, so the hook path
 * filters with this first.
 *
 * Deliberately not used on the `waste` path: that one wants the full per-class attachment rollup, and
 * it is already parsing every line for tool calls, so a filter there would exclude data for no saving.
 * A false positive here is harmless (the line parses and contributes nothing); the patterns are the
 * literal JSON spellings of the three shapes, so a false negative would need the harness to change
 * its field names, which changes the shapes anyway.
 */
export function lineMayCarryResidentSignal(line: string): boolean {
  // The first two are JSON *values*, so their spelling on disk is fixed. `isMeta` is a key, and a
  // key is followed by however much whitespace the writer emits -- matching `"isMeta":true` would
  // tie this to one serializer's formatting and silently stop matching if that ever changed, with
  // no failure anywhere to notice. Match the key alone and let accumulateResidentLine do the real
  // `=== true` check; a line mentioning the key at all is only ever a candidate here.
  return (
    line.includes('"task_reminder"') ||
    line.includes('"compact_boundary"') ||
    line.includes('"invoked_skills"') ||
    line.includes('"isMeta"')
  )
}

/** Fold a list of raw JSONL lines into a fresh accumulator, skipping blanks and unparseable lines. */
export function accumulateResidentLines(lines: readonly string[]): ResidentContextStats {
  const acc = createResidentContextStats()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    accumulateResidentLine(acc, parsed, trimmed.length)
  }
  return acc
}
