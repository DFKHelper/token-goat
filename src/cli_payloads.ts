/** `token-goat stats --payloads`: what token-goat itself adds to every session's context, measured rather than estimated from source. Everything here is read-only: it rebuilds each block the hooks would inject without running the parts that act (the drift sweep enqueues files, the resume packet reads a transcript), so a measurement never changes what it measures. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadConfig } from './config.js'
import { buildDeltaCapsule } from './evidence_cache.js'
import { installedClaudeMdBlock, installedSkillDescription, skillPath } from './install.js'
import { displaySafeJson, normalizePath } from './paths.js'
import { findProject } from './project.js'
import { anchorStatus } from './note_anchor.js'
import { loadDatedEntries, projectNotesFor } from './project_memory.js'
import { buildReminder, isIndexedProject } from './session_reminder.js'
import { sessionsDir } from './sessions_dir.js'

/** One block of injected text. `chars` is null when the block is absent (not installed, nothing to inject). */
export interface PayloadBlock {
  readonly name: string
  readonly chars: number | null
  readonly tokens: number | null
  readonly note: string
}

/** Whether the files one note names were opened after the note was set: a note that names files nobody opens again is spending its tokens every session for nothing. */
export interface NoteProbe {
  readonly key: string
  readonly setAt: string | null
  readonly named: readonly string[]
  readonly readAfter: readonly string[]
}

export interface PayloadReport {
  readonly projectRoot: string | null
  readonly sessionStart: readonly PayloadBlock[]
  readonly sessionStartTotal: { readonly chars: number; readonly tokens: number }
  readonly installed: readonly PayloadBlock[]
  readonly afterCompaction: readonly PayloadBlock[]
  readonly notes: readonly NoteProbe[]
}

/** Bytes / 4, the estimate every other token figure in stats uses (src/stats.ts::savedTokensFromBytes). */
function tokensOf(text: string): number {
  return Math.round(Buffer.byteLength(text, 'utf8') / 4)
}

function block(name: string, text: string | null, note: string): PayloadBlock {
  return text === null ? { name, chars: null, tokens: null, note } : { name, chars: text.length, tokens: tokensOf(text), note }
}

// A relative or absolute file path with an extension, optionally followed by `::symbol` or `:line`; the suffix is dropped. Deliberately loose: a candidate only counts once it resolves to a file that exists under the project root.
const PATH_TOKEN_RE = /[A-Za-z0-9_.\-/\\:]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}(?=$|[\s`'"),;:\]])/g

function pathKey(p: string): string {
  const n = normalizePath(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** The existing files under `root` that `value` names, as absolute paths, first mention first. */
export function namedFiles(value: string, root: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(PATH_TOKEN_RE)) {
    const candidate = match[0].replace(/::.*$/, '')
    const abs = path.resolve(root, candidate)
    const rel = path.relative(root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    try {
      if (!fs.statSync(abs).isFile()) continue
    } catch {
      continue
    }
    const key = pathKey(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** Latest read time per file across every saved session whose state file changed at or after `since`. */
function readTimesSince(since: number, dir: string): Map<string, number> {
  const times = new Map<string, number>()
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return times
  }
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      if (fs.statSync(full).mtimeMs < since) continue
      const data = JSON.parse(fs.readFileSync(full, 'utf8')) as { files?: unknown }
      if (!Array.isArray(data.files)) continue
      for (const entry of data.files as Array<Record<string, unknown>>) {
        if (typeof entry !== 'object' || entry === null) continue
        const p = entry['path']
        const at = entry['lastReadAt']
        if (typeof p !== 'string' || typeof at !== 'number') continue
        const key = pathKey(p)
        if (at > (times.get(key) ?? Number.NEGATIVE_INFINITY)) times.set(key, at)
      }
    } catch {
      continue
    }
  }
  return times
}

/** Probe each note that names at least one existing file. An undated note (written before notes carried a set time, or by hand) has no "after", so it reports the files it names and none read. */
export function probeNotes(projectHash: string, root: string, dir: string = sessionsDir()): NoteProbe[] {
  const probes: NoteProbe[] = []
  const entries = Object.entries(loadDatedEntries(projectHash))
  const dated = entries.map(([, e]) => (e.setAt === undefined ? Number.NaN : Date.parse(e.setAt))).filter((t) => !Number.isNaN(t))
  const times = dated.length === 0 ? new Map<string, number>() : readTimesSince(Math.min(...dated), dir)
  for (const [key, entry] of entries) {
    const named = namedFiles(entry.value, root)
    if (named.length === 0) continue
    const setAt = entry.setAt === undefined ? null : Date.parse(entry.setAt)
    const readAfter = setAt === null ? [] : named.filter((f) => (times.get(pathKey(f)) ?? Number.NEGATIVE_INFINITY) > setAt)
    probes.push({ key, setAt: entry.setAt ?? null, named, readAfter })
  }
  return probes
}

/** Measure what token-goat injects for a session started in `cwd`. */
export function measurePayloads(cwd: string, dir?: string): PayloadReport {
  const config = loadConfig()
  const project = findProject(cwd)
  const reminderOn = config.hints.session_start_reminder

  const reminder = reminderOn ? buildReminder(isIndexedProject(cwd)) : null
  const capsule = reminderOn ? buildDeltaCapsule(cwd) : null
  // With the resolver session start passes, so the measured block carries the same markers.
  const notes = projectNotesFor(cwd, anchorStatus)
  const noteCount = project === null ? 0 : Object.keys(loadDatedEntries(project.hash)).length
  const sessionStart = [
    block('routing reminder', reminder, reminderOn ? 'every session start' : 'off (hints.session_start_reminder = false)'),
    block('project notes', notes, notes === null ? 'no notes for this project' : `${noteCount} note${noteCount === 1 ? '' : 's'}, every session start`),
    block('evidence delta', capsule, capsule === null ? 'nothing cached has changed' : 'while cached evidence is stale'),
  ]
  // Assembled the way sessionStartOutput joins its parts, so the total is the injected text, separators included.
  const assembled = [reminder, capsule, notes].filter((part): part is string => part !== null).join('\n\n')

  const claudeMd = installedClaudeMdBlock()
  const skillDescription = installedSkillDescription()
  const installed = [
    block('CLAUDE.md gate block', claudeMd, claudeMd === null ? 'not installed' : 'loaded with ~/.claude/CLAUDE.md, every session'),
    block('skill description', skillDescription, skillDescription !== null ? 'listed with the skills, every session' : fs.existsSync(skillPath()) ? 'installed skill has no description line' : 'skill not installed'),
  ]

  const manifestCap = config.compact_assist.enabled ? config.compact_assist.max_manifest_chars : null
  const afterCompaction: PayloadBlock[] = [
    manifestCap === null
      ? { name: 'compaction manifest', chars: null, tokens: null, note: 'off (compact_assist.enabled = false)' }
      : { name: 'compaction manifest', chars: manifestCap, tokens: Math.round(manifestCap / 4), note: 'at most, per compaction (compact_assist.max_manifest_chars)' },
    { name: 'resume packet', chars: null, tokens: null, note: 'varies with the session, per compaction' },
  ]

  return {
    projectRoot: project?.root ?? null,
    sessionStart,
    sessionStartTotal: { chars: assembled.length, tokens: tokensOf(assembled) },
    installed,
    afterCompaction,
    notes: project === null ? [] : probeNotes(project.hash, project.root, dir),
  }
}

function row(b: PayloadBlock): string {
  const size = b.chars === null ? '-' : `${b.chars.toLocaleString('en-US')} chars, ~${b.tokens?.toLocaleString('en-US') ?? 0} tok`
  return `  ${b.name.padEnd(22)} ${size.padEnd(26)} ${b.note}`
}

export function renderPayloads(report: PayloadReport): string {
  const lines = ['# token-goat context payloads', '', `project: ${report.projectRoot ?? '(not in a project)'}`, '', 'Every session start:']
  lines.push(...report.sessionStart.map(row))
  lines.push(`  ${'total'.padEnd(22)} ${report.sessionStartTotal.chars.toLocaleString('en-US')} chars, ~${report.sessionStartTotal.tokens.toLocaleString('en-US')} tok`)
  lines.push('', 'Installed instructions:', ...report.installed.map(row))
  lines.push('', 'After a compaction:', ...report.afterCompaction.map(row))
  if (report.notes.length > 0) {
    const named = report.notes.reduce((sum, n) => sum + n.named.length, 0)
    const read = report.notes.reduce((sum, n) => sum + n.readAfter.length, 0)
    lines.push('', `Notes that name files: ${report.notes.length}. Named files read after their note was set: ${read} of ${named}.`)
    for (const n of report.notes) {
      const when = n.setAt === null ? 'undated' : `set ${n.setAt}`
      lines.push(`  ${n.key}: ${n.readAfter.length} of ${n.named.length} named file${n.named.length === 1 ? '' : 's'} read since (${when})`)
    }
  }
  lines.push('', 'Tokens are bytes / 4, the same estimate as the rest of stats. Two more lines appear at session start only when they apply and are not counted: the drift notice, which comes from a sweep that queues files for reindexing, and the index-size warning.')
  return lines.join('\n')
}

export function runPayloads(json: boolean, cwd: string = process.cwd()): void {
  const report = measurePayloads(cwd)
  process.stdout.write(json ? `${displaySafeJson(report, 0)}\n` : `${renderPayloads(report)}\n`)
}
