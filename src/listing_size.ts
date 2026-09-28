/** `token-goat listing-size`: price the skill and agent listings Claude Code puts in context. Claude Code sends every skill's and every subagent type's name and description as `skill_listing` and `agent_listing_delta` attachments in the session transcript, and sends them again after a compaction, so a long description is paid once per re-send, not once per session. `skill-size` prices skill bodies, which load only when a skill runs; this prices the listing, which loads whether anything runs or not. The listing is read from the transcript rather than rebuilt from the skill and agent files on disk, because the transcript is what the model actually received: it includes plugin and nested-directory skills, and reflects whatever Claude Code trimmed. */

import * as fs from 'node:fs'
import * as readline from 'node:readline'

import { displaySafeText } from './paths.js'

export interface ListingEntry {
  name: string
  bytes: number
}

export interface ListingSummary {
  /** Entries in the listing as it stood at the end of the transcript, largest first. */
  entries: ListingEntry[]
  /** Bytes of that final listing: what one more re-send would cost. */
  bytes: number
  /** Attachments of this kind in the transcript, the initial listing and every re-send or delta. */
  injections: number
  /** Bytes summed over every one of those attachments. */
  injectedBytes: number
}

export interface ListingReport {
  transcript: string
  skills: ListingSummary
  agents: ListingSummary
}

/** Split a `skill_listing` content string into its entries. Each entry opens with `- name: ` at the start of a line; a description can run over several lines, and every line up to the next entry belongs to it. A name can itself carry a colon (a plugin skill is `plugin:skill`), so the name ends at the first `: `, not the first `:`. */
export function splitListingContent(content: string): ListingEntry[] {
  const entries: ListingEntry[] = []
  let current: { name: string; text: string } | null = null
  for (const line of content.split('\n')) {
    const m = /^- (.+?): /.exec(line)
    if (m !== null) {
      if (current !== null) entries.push({ name: current.name, bytes: Buffer.byteLength(current.text, 'utf8') })
      current = { name: m[1]!, text: line }
    } else if (current !== null) {
      current.text += '\n' + line
    }
  }
  if (current !== null) entries.push({ name: current.name, bytes: Buffer.byteLength(current.text, 'utf8') })
  return entries
}

interface ListingState {
  current: Map<string, number>
  injections: number
  injectedBytes: number
}

function newState(): ListingState {
  return { current: new Map(), injections: 0, injectedBytes: 0 }
}

/** Apply one transcript attachment to the running listing state. An initial listing replaces what came before (it is a fresh copy after a compaction or at session start); a non-initial one adds to it, and an agent delta can also remove types. */
export function applyListingAttachment(attachment: Record<string, unknown>, skills: ListingState, agents: ListingState): void {
  const type = attachment['type']
  const initial = attachment['isInitial'] === true
  if (type === 'skill_listing') {
    const content = typeof attachment['content'] === 'string' ? attachment['content'] : ''
    if (initial) skills.current.clear()
    for (const e of splitListingContent(content)) skills.current.set(e.name, e.bytes)
    skills.injections++
    skills.injectedBytes += Buffer.byteLength(content, 'utf8')
  } else if (type === 'agent_listing_delta') {
    const lines = Array.isArray(attachment['addedLines']) ? attachment['addedLines'].filter((l): l is string => typeof l === 'string') : []
    const types = Array.isArray(attachment['addedTypes']) ? attachment['addedTypes'] : []
    const removed = Array.isArray(attachment['removedTypes']) ? attachment['removedTypes'] : []
    if (initial) agents.current.clear()
    for (const r of removed) if (typeof r === 'string') agents.current.delete(r)
    let added = 0
    lines.forEach((line, i) => {
      const named = types[i]
      const name = typeof named === 'string' ? named : (/^- (.+?): /.exec(line)?.[1] ?? line.slice(0, 40))
      const bytes = Buffer.byteLength(line, 'utf8')
      agents.current.set(name, bytes)
      added += bytes
    })
    // A delta that only removes types re-sends nothing, so it is not counted as an injection.
    if (lines.length > 0) {
      agents.injections++
      agents.injectedBytes += added
    }
  }
}

function summarize(state: ListingState): ListingSummary {
  const entries = [...state.current].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
  return { entries, bytes: entries.reduce((n, e) => n + e.bytes, 0), injections: state.injections, injectedBytes: state.injectedBytes }
}

/** Read a Claude Code transcript line by line and price its skill and agent listings. Lines that are not JSON, or carry no listing attachment, are skipped. */
export async function measureListings(transcriptPath: string): Promise<ListingReport> {
  const skills = newState()
  const agents = newState()
  const rl = readline.createInterface({ input: fs.createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    // A cheap substring test first: nearly every line is a turn, and parsing each one would dominate the run on a large transcript.
    if (!line.includes('_listing')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const attachment = (parsed as { attachment?: unknown } | null)?.attachment
    if (attachment !== null && typeof attachment === 'object') applyListingAttachment(attachment as Record<string, unknown>, skills, agents)
  }
  return { transcript: transcriptPath, skills: summarize(skills), agents: summarize(agents) }
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function summaryLine(label: string, s: ListingSummary): string {
  if (s.injections === 0) return `${label}: no listing in this transcript`
  const times = s.injections === 1 ? 'once' : `${s.injections} times`
  return `${label}: ${s.entries.length} listed, ${kb(s.bytes)} (~${Math.floor(s.bytes / 4)} tokens) per listing; sent ${times} in this session, ${kb(s.injectedBytes)} in all`
}

/** Render the report as text: a line per listing, then the largest descriptions in each. */
export function renderListingReport(report: ListingReport, top: number): string {
  const lines = [`# listing size: ${displaySafeText(report.transcript)}`, summaryLine('Skills', report.skills), summaryLine('Agents', report.agents)]
  for (const [label, s] of [['skill', report.skills], ['agent', report.agents]] as const) {
    if (s.entries.length === 0 || top === 0) continue
    lines.push('', `## Largest ${label} descriptions`)
    for (const e of s.entries.slice(0, top)) {
      const share = s.bytes > 0 ? ((e.bytes / s.bytes) * 100).toFixed(1) : '0.0'
      lines.push(`  ${String(e.bytes).padStart(6)} B  ${share.padStart(5)}%  ${displaySafeText(e.name)}`)
    }
  }
  if (report.skills.injections + report.agents.injections > 0) {
    lines.push('', 'Every byte above is paid again each time Claude Code re-sends the listing. Shorten the largest descriptions first, and keep the words that decide when the skill or agent is picked.')
  }
  return lines.join('\n')
}
