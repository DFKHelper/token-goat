/** Waste analysis for Copilot CLI sessions. Copilot records every session as an append-only event log at `<copilot-home>/session-state/<id>/events.jsonl`, which makes it a better measurement target than a Claude Code transcript rather than a worse one, for two reasons. First, `user.message.transformedContent` is the *assembled* prompt: it carries the `<current_datetime>` and `<system_reminder>` envelope that the sibling `content` field does not. So the harness-injected context can be read directly instead of reconstructed by working out what the renderer would have done with each record. Second, `session.shutdown` carries Copilot's own token accounting -- `systemTokens`, `toolDefinitionsTokens`, `conversationTokens` -- so the dominant cost can be reported in the unit that actually bills instead of a byte count standing in for one. On a real session here those read 6569 + 7268 + 111, i.e. over 13k tokens of fixed per-request overhead against 111 tokens of conversation. That ratio is the finding; no estimator of ours would have been trusted to produce it. The counterweight is that most of the file is not model-visible at all. `hook.start` and `hook.end` are the largest event types on disk in a token-goat-instrumented session and reach the model exactly never -- the same shape as Claude Code's `hook_success` attachments, which are ~10% of a transcript and ~0% of the bill. Reporting on-disk size as if it were context is the specific error this module exists to avoid, so hook records are measured separately and labelled as not billed. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { copilotCliUserRoot } from './bridges/copilot_cli_install.js'
import { readCopilotMcpTools, type CopilotMcpServerTools, type CopilotMcpToolsReport } from './copilot_mcp_tools.js'
import { canonicalize } from './path_containment.js'
import { findLatestTranscript, readFileLines } from './waste.js'

/** Event types verified to carry no model-visible content: they exist only in the on-disk log. */
const HOOK_RECORD_TYPES = new Set(['hook.start', 'hook.end'])

/** One class of injected block, aggregated across the session's turns. */
export interface CopilotBlockClass {
  /** Block label: the wrapper tag, or the first inner tag of a `<system_reminder>`. */
  kind: string
  count: number
  bytes: number
  /** Bytes belonging to a payload byte-identical to one already sent earlier this session. */
  repeatBytes: number
  repeatCount: number
}

/** Copilot's own token split for the session, as it reported it. */
export interface CopilotTokenSplit {
  systemTokens: number
  toolDefinitionsTokens: number
  conversationTokens: number
  currentTokens: number
}

export interface CopilotCompaction {
  trigger: string
  summaryBytes: number
  preTokens: number
  postTokens: number
}

export interface CopilotWasteReport {
  sessionPath: string
  sessionId: string
  turns: number
  /** Null when the session never emitted a shutdown event (still running, or killed). */
  tokens: CopilotTokenSplit | null
  blocks: CopilotBlockClass[]
  compactions: CopilotCompaction[]
  /** Bytes of hook.start/hook.end records: on disk, never in context. */
  hookRecordBytes: number
  totalEventBytes: number
  /** Per-MCP-server tool-definition weight, read from Copilot's own cache rather than from this session log. The log carries no tool events at all -- verified across every session on this machine, none of which contains a single one -- so the log cannot say which server the tool-definition budget went to. The cache can. */
  mcpTools: CopilotMcpToolsReport
  /** Calls this session made to each MCP server, keyed by the `mcpServerName` Copilot writes on every `tool.execution_start` for an MCP tool. Null when the log holds no tool executions at all, since a log that predates tool events cannot tell an unused server from an unrecorded one. */
  mcpCalls: Record<string, number> | null
}

/** Split an assembled prompt into its injected blocks. Only top-level `<tag>...</tag>` wrappers are treated as blocks; the user's own prose between them is deliberately not counted, since it is the one part of the prompt that is not overhead. A `<system_reminder>` is labelled by its first inner tag (`sql_tables`, `todo_status`, ...) because the wrapper name alone would collapse every distinct reminder into one bucket and hide which of them is actually repeating. */
export function splitInjectedBlocks(transformed: string): { kind: string; body: string }[] {
  const out: { kind: string; body: string }[] = []
  const blockRe = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(transformed)) !== null) {
    const tag = (m[1] ?? '').toLowerCase()
    const body = m[2] ?? ''
    let kind = tag
    if (tag === 'system_reminder') {
      const inner = /^\s*<([a-z_][a-z0-9_]*)>/i.exec(body)
      kind = inner !== null ? `reminder:${(inner[1] ?? '').toLowerCase()}` : 'reminder:text'
    }
    out.push({ kind, body: m[0] })
  }
  return out
}

export interface FindCopilotSessionOptions {
  projectRoot?: string | undefined
  onlyActive?: boolean | undefined
}

/** Check if two paths point to the same location, through the same canonicalizer every other project-root producer in this codebase uses. */
function pathsMatch(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === '' || b === '') return false
  // canonicalize, not a bare path.resolve: the project root this is compared against comes from resolveProjectRoot, which canonicalizes, and Copilot's workspace.yaml records whatever spelling its own process saw. path.resolve reconciles neither of the two aliases that differ between those producers -- macOS exposes /var as /private/var, and Windows varies drive-letter case and 8.3 short segments -- so a session whose cwd sat under either one never matched its own project and auto-discovery silently fell through to the Claude transcript instead. One shared canonicalizer rather than a hand-rolled win32 lowercase, so the rule cannot drift from the producer's.
  return canonicalize(a) === canonicalize(b)
}

/** Extract `cwd` and `git_root` from Copilot's `workspace.yaml` in a session directory. Returns null if the file cannot be read or parsed. */
export function readCopilotWorkspace(sessionDir: string): { cwd?: string | undefined; gitRoot?: string | undefined; id?: string | undefined } | null {
  const wsFile = path.join(sessionDir, 'workspace.yaml')
  let raw: string
  try {
    raw = fs.readFileSync(wsFile, 'utf8')
  } catch {
    return null
  }
  let cwd: string | undefined
  let gitRoot: string | undefined
  let id: string | undefined
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('cwd:')) {
      cwd = trimmed.slice(4).trim().replace(/^['"]|['"]$/g, '')
    } else if (trimmed.startsWith('git_root:')) {
      gitRoot = trimmed.slice(9).trim().replace(/^['"]|['"]$/g, '')
    } else if (trimmed.startsWith('id:')) {
      id = trimmed.slice(3).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return { cwd, gitRoot, id }
}

/** Check if a process ID is currently running on the system. */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as { code?: string })?.code === 'EPERM'
  }
}

/** Check whether a session directory represents an actively running Copilot CLI session. */
export function isCopilotSessionActive(sessionDir: string, sessionId?: string): boolean {
  const sid = sessionId ?? path.basename(sessionDir)
  const envSessionId = process.env['COPILOT_AGENT_SESSION_ID']
  if (envSessionId !== undefined && envSessionId.trim() === sid) {
    return true
  }

  try {
    const files = fs.readdirSync(sessionDir)
    for (const f of files) {
      if (f.startsWith('inuse.') && f.endsWith('.lock')) {
        const pidStr = f.slice(6, -5)
        const pid = parseInt(pidStr, 10)
        if (!Number.isNaN(pid) && isProcessAlive(pid)) {
          return true
        }
      }
    }
  } catch {
    // Session directory unreadable
  }

  try {
    const opLock = path.join(path.dirname(sessionDir), '.session-operation-locks', `${sid}.lock`)
    if (fs.existsSync(opLock)) {
      return true
    }
  } catch {
    // Ignore
  }

  return false
}

/** Checks if a given file path is a Copilot CLI event log rather than a Claude Code transcript. */
export function isCopilotTranscript(filePath: string): boolean {
  if (path.basename(filePath) === 'events.jsonl') return true
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(512)
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0)
    fs.closeSync(fd)
    const prefix = buf.toString('utf8', 0, bytesRead)
    return /"type"\s*:\s*"(?:session\.|user\.message|assistant\.message|tool\.)/.test(prefix)
  } catch {
    return false
  }
}

/** Find the active Copilot session for a given project, or active session overall if no project specified. */
export function findActiveCopilotSession(projectRoot?: string): string | null {
  return findLatestCopilotSession({ projectRoot, onlyActive: true })
}

/** Discover the newest (or active) `events.jsonl` under the Copilot session-state directory. If projectRoot is specified, only sessions whose workspace.yaml cwd or git_root matches are returned. */
export function findLatestCopilotSession(projectRootOrOpts?: string | FindCopilotSessionOptions): string | null {
  const opts: FindCopilotSessionOptions = typeof projectRootOrOpts === 'string'
    ? { projectRoot: projectRootOrOpts }
    : (projectRootOrOpts ?? {})

  const root = path.join(copilotCliUserRoot(), 'session-state')

  const envSessionId = process.env['COPILOT_AGENT_SESSION_ID']
  if (envSessionId !== undefined && envSessionId.trim() !== '') {
    const sid = envSessionId.trim()
    const sessionDir = path.join(root, sid)
    const candidate = path.join(sessionDir, 'events.jsonl')
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isFile()) {
          if (opts.projectRoot !== undefined) {
            const ws = readCopilotWorkspace(sessionDir)
            if (ws && (pathsMatch(ws.cwd, opts.projectRoot) || pathsMatch(ws.gitRoot, opts.projectRoot))) {
              return candidate
            }
          } else {
            return candidate
          }
        }
      } catch {
        // Continue to filesystem scan
      }
    }
  }

  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return null
  }

  let bestActive: string | null = null
  let bestActiveMtime = -Infinity
  let bestInactive: string | null = null
  let bestInactiveMtime = -Infinity

  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const sessionDir = path.join(root, entry)
    const candidate = path.join(sessionDir, 'events.jsonl')
    let st: fs.Stats
    try {
      st = fs.statSync(candidate)
      if (!st.isFile()) continue
    } catch {
      continue
    }

    if (opts.projectRoot !== undefined) {
      const ws = readCopilotWorkspace(sessionDir)
      if (!ws || (!pathsMatch(ws.cwd, opts.projectRoot) && !pathsMatch(ws.gitRoot, opts.projectRoot))) {
        continue
      }
    }

    const active = isCopilotSessionActive(sessionDir, entry)
    if (active) {
      if (st.mtimeMs > bestActiveMtime) {
        bestActiveMtime = st.mtimeMs
        bestActive = candidate
      }
    } else if (opts.onlyActive !== true) {
      if (st.mtimeMs > bestInactiveMtime) {
        bestInactiveMtime = st.mtimeMs
        bestInactive = candidate
      }
    }
  }

  return bestActive ?? (opts.onlyActive === true ? null : bestInactive)
}

export interface DetectedSession {
  path: string
  kind: 'copilot' | 'claude'
}

/** Discovers the active or most recent session for a project across Copilot CLI and Claude Code. Active sessions take priority over inactive sessions; otherwise newest modification time wins. */
export function findProjectSession(projectRoot: string): DetectedSession | null {
  const copilotSession = findActiveCopilotSession(projectRoot) ?? findLatestCopilotSession(projectRoot)
  const claudeTranscript = findLatestTranscript(projectRoot)

  if (copilotSession !== null && claudeTranscript !== null) {
    if (findActiveCopilotSession(projectRoot) !== null) {
      return { path: copilotSession, kind: 'copilot' }
    }
    let cpTime = 0
    let clTime = 0
    try {
      cpTime = fs.statSync(copilotSession).mtimeMs
    } catch {
      // Non-fatal if stat fails
    }
    try {
      clTime = fs.statSync(claudeTranscript).mtimeMs
    } catch {
      // Non-fatal if stat fails
    }
    return cpTime >= clTime
      ? { path: copilotSession, kind: 'copilot' }
      : { path: claudeTranscript, kind: 'claude' }
  }

  if (copilotSession !== null) {
    return { path: copilotSession, kind: 'copilot' }
  }

  if (claudeTranscript !== null) {
    return { path: claudeTranscript, kind: 'claude' }
  }

  return null
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Cached MCP servers this session never called, largest first, or null when the log cannot tell (see {@link CopilotWasteReport.mcpCalls}). */
export function unusedMcpServers(report: CopilotWasteReport): CopilotMcpServerTools[] | null {
  const calls = report.mcpCalls
  return calls === null ? null : report.mcpTools.servers.filter((server) => (calls[server.serverName] ?? 0) === 0)
}

/** How to undo a disable and how to drop a server for one run, both verified against Copilot CLI 1.0.88's own help; `mcp disable` accepts the built-in github-mcp-server too, persisting it under `disabledMcpServers` in settings.json. */
export const MCP_DISABLE_NOTE = "'copilot mcp enable <name>' restores one, and '--disable-mcp-server <name>' drops one for a single run instead."

/** Parse one Copilot session event log into a waste report. */
export function buildCopilotWasteReport(eventsPath: string): CopilotWasteReport {
  const report: CopilotWasteReport = {
    sessionPath: eventsPath,
    sessionId: path.basename(path.dirname(eventsPath)),
    turns: 0,
    tokens: null,
    blocks: [],
    compactions: [],
    hookRecordBytes: 0,
    // Measured off the file rather than off a string of its contents: an event log large enough for this number to matter is exactly the one readFileSync cannot return, since V8 caps a string at about 512 MB.
    totalEventBytes: fs.statSync(eventsPath).size,
    // Read through the real resolution chain rather than passed in. Copilot's own COPILOT_CACHE_HOME override is what tests point at a fixture, so the shipping path is the tested path and there is no seam here that only a test ever supplies.
    mcpTools: readCopilotMcpTools(),
    mcpCalls: null,
  }

  const classes = new Map<string, CopilotBlockClass>()
  const seen = new Map<string, Set<string>>()
  const mcpCalls = new Map<string, number>()
  let toolExecutions = 0

  for (const line of readFileLines(eventsPath)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // A partially-flushed final line is normal on a live session; skip it rather than abort.
      continue
    }
    const type = typeof event['type'] === 'string' ? (event['type'] as string) : ''
    const data = (event['data'] ?? {}) as Record<string, unknown>

    if (HOOK_RECORD_TYPES.has(type)) {
      report.hookRecordBytes += Buffer.byteLength(trimmed, 'utf-8')
      continue
    }

    if (type === 'session.shutdown') {
      // Last one wins: a resumed session writes several, and the final split is the current one.
      report.tokens = {
        systemTokens: readNumber(data, 'systemTokens'),
        toolDefinitionsTokens: readNumber(data, 'toolDefinitionsTokens'),
        conversationTokens: readNumber(data, 'conversationTokens'),
        currentTokens: readNumber(data, 'currentTokens'),
      }
      continue
    }

    if (type === 'session.compaction_complete') {
      const summary = typeof data['summaryContent'] === 'string' ? (data['summaryContent'] as string) : ''
      report.compactions.push({
        trigger: typeof data['trigger'] === 'string' ? (data['trigger'] as string) : 'unknown',
        summaryBytes: Buffer.byteLength(summary, 'utf-8'),
        preTokens: readNumber(data, 'preCompactionTokens'),
        postTokens: readNumber(data, 'postCompactionTokens'),
      })
      continue
    }

    if (type === 'tool.execution_start') {
      toolExecutions += 1
      const server = data['mcpServerName']
      if (typeof server === 'string') mcpCalls.set(server, (mcpCalls.get(server) ?? 0) + 1)
      continue
    }

    if (type !== 'user.message') continue
    const transformed = typeof data['transformedContent'] === 'string' ? (data['transformedContent'] as string) : ''
    if (transformed === '') continue
    report.turns += 1

    for (const block of splitInjectedBlocks(transformed)) {
      const bytes = Buffer.byteLength(block.body, 'utf-8')
      let cls = classes.get(block.kind)
      if (cls === undefined) {
        cls = { kind: block.kind, count: 0, bytes: 0, repeatBytes: 0, repeatCount: 0 }
        classes.set(block.kind, cls)
      }
      cls.count += 1
      cls.bytes += bytes
      let bucket = seen.get(block.kind)
      if (bucket === undefined) {
        bucket = new Set<string>()
        seen.set(block.kind, bucket)
      }
      if (bucket.has(block.body)) {
        cls.repeatBytes += bytes
        cls.repeatCount += 1
      } else {
        bucket.add(block.body)
      }
    }
  }

  report.blocks = [...classes.values()].sort((a, b) => b.bytes - a.bytes)
  report.mcpCalls = toolExecutions === 0 ? null : Object.fromEntries(mcpCalls)
  return report
}
