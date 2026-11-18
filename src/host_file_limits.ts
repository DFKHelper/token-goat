/** Measures each host's always-on instruction files against the limit that host documents, for `bootstrap-audit`. Limits are reported, never enforced: nothing here caps what token-goat itself reads or writes. A host whose limit was not sourced prints `unknown` rather than a guessed number. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from 'smol-toml'
import { codexHomeDir } from './bridges/codex_install.js'
import { projectPathIsConsultable } from './bridges/project_scope_guard.js'
import { MAX_OLD_FILE_BYTES_FOR_DIFF } from './write_target.js'

// Claude Code loads a CLAUDE.md of up to 4 MiB in full and skips a larger one: https://code.claude.com/docs/en/memory (page carries no version or date, read 2026-10-19)
export const CLAUDE_MD_MAX_BYTES = 4 * 1024 * 1024
// Claude Code loads the first 200 lines of MEMORY.md, or the first 25KB, whichever comes first: https://code.claude.com/docs/en/memory (read 2026-10-19)
export const MEMORY_MD_MAX_LINES = 200
// The page writes "25KB" next to "4 MiB", so KB is read as 1000 bytes; the exact boundary is unverified: https://code.claude.com/docs/en/memory
export const MEMORY_MD_MAX_BYTES = 25_000
// The other reading of "25KB": 25 KiB. A byte cut between the two readings is reported as uncertain, never as a firm cut.
export const MEMORY_MD_MAX_BYTES_KIB = 25 * 1024
// "Under 200 lines" is advice for CLAUDE.md, not a limit: https://code.claude.com/docs/en/memory (read 2026-10-19)
export const CLAUDE_MD_GUIDELINE_LINES = 200
// Codex's default project_doc_max_bytes, a total across all project docs: https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs line 75 (DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024) and https://learn.chatgpt.com/docs/agent-configuration/agents-md
export const CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024
// Copilot documents no truncation, only "a maximum of about 1,000 lines" per instruction file before quality may deteriorate: https://docs.github.com/en/copilot/tutorials/use-custom-instructions (read 2026-10-19)
export const COPILOT_GUIDELINE_LINES = 1000

// Codex checks these names in each directory, in this order, and includes at most one file per directory: https://learn.chatgpt.com/docs/agent-configuration/agents-md and codex-rs/core/src/agents_md.rs candidate_filenames
const CODEX_LOCAL_NAME = 'AGENTS.override.md'
const CODEX_DEFAULT_NAME = 'AGENTS.md'
const COPILOT_INSTRUCTIONS_DIR_DEPTH = 3

export type HostName = 'claude' | 'codex' | 'copilot'
export type FileOutcome = 'loaded' | 'cut' | 'skipped' | 'uncertain'

export interface HostFileFinding {
  host: HostName
  kind: string
  path: string
  bytes: number
  /** null when the file was not read (a CLAUDE.md past the 4 MiB skip). */
  lines: number | null
  estimated_tokens: number
  outcome: FileOutcome
  not_loaded_bytes: number
  not_loaded_lines: number | null
  limit: string
  verdict: string
  advice: string | null
}

export interface UnknownLimit {
  host: string
  what: string
  limit: 'unknown'
}

export interface HostLimitReport {
  /** Ordered by what each file loses, then by what it costs: the first row is the one to look at first. */
  findings: HostFileFinding[]
  unknown: UnknownLimit[]
  codex: { budget_bytes: number; budget_source: 'configured' | 'project config' | 'default'; config_path: string; project_total_bytes: number }
  diagnostics: { path: string; reason: string }[]
}

export interface HostLimitInput {
  home: string
  project: string
  claudeMdPaths: readonly string[]
  memoryPath: string | null
}

interface FileScan {
  bytes: number
  lines: number
  loadedBytes: number
  loadedLines: number
}

/** What a budget read from the project's own .codex/config.toml must say beside it: Codex loads that layer but disables it for a project it does not trust, which the audit cannot tell (loader/mod.rs at rust-v0.163.0, "loaded but disabled when untrusted"). */
export const PROJECT_CONFIG_TRUST_NOTE = 'applies only if Codex trusts the project'

const UNKNOWN_LIMITS: readonly UnknownLimit[] = [
  { host: 'VS Code Chat', what: 'instruction file size cap', limit: 'unknown' },
  { host: 'Copilot cloud agent', what: 'instruction file size cap', limit: 'unknown' },
  { host: 'Copilot', what: 'user-level instructions size cap', limit: 'unknown' },
]

/** One pass over a file counting bytes and lines, plus how much of it survives a host that keeps only the first `maxLines` lines or `maxBytes` bytes, whichever ends first. A line cut mid-way counts as loaded. */
export function scanFile(filePath: string, prefix: { maxBytes: number; maxLines: number } = { maxBytes: Infinity, maxLines: Infinity }): FileScan {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(65536)
    let position = 0
    let newlines = 0
    let lastByte = -1
    let lineCutOffset = Infinity
    let newlinesAtByteLimit = -1
    let midLineAtByteLimit = false
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, position)
      if (n === 0) break
      for (let i = 0; i < n; i++) {
        const at = position + i
        if (at === prefix.maxBytes) {
          newlinesAtByteLimit = newlines
          midLineAtByteLimit = lastByte !== 10
        }
        const byte = buf[i] ?? -1
        if (byte === 10) {
          newlines++
          if (newlines === prefix.maxLines) lineCutOffset = at + 1
        }
        lastByte = byte
      }
      position += n
    }
    const bytes = position
    const lines = newlines + (bytes > 0 && lastByte !== 10 ? 1 : 0)
    if (Math.min(lineCutOffset, prefix.maxBytes) >= bytes) return { bytes, lines, loadedBytes: bytes, loadedLines: lines }
    if (lineCutOffset <= prefix.maxBytes) return { bytes, lines, loadedBytes: lineCutOffset, loadedLines: prefix.maxLines }
    return { bytes, lines, loadedBytes: prefix.maxBytes, loadedLines: newlinesAtByteLimit + (midLineAtByteLimit ? 1 : 0) }
  } finally {
    fs.closeSync(fd)
  }
}

function tokensOf(bytes: number): number {
  return Math.floor(bytes / 4)
}

function baseFinding(host: HostName, kind: string, filePath: string, bytes: number): Pick<HostFileFinding, 'host' | 'kind' | 'path' | 'bytes' | 'estimated_tokens'> {
  return { host, kind, path: filePath, bytes, estimated_tokens: tokensOf(bytes) }
}

function claudeMdFinding(filePath: string, diagnostics: HostLimitReport['diagnostics']): HostFileFinding | null {
  try {
    const size = fs.statSync(filePath).size
    const limit = `loaded in full up to ${CLAUDE_MD_MAX_BYTES} bytes (4 MiB), a larger file is skipped`
    if (size > CLAUDE_MD_MAX_BYTES) {
      return { ...baseFinding('claude', 'CLAUDE.md', filePath, size), lines: null, outcome: 'skipped', not_loaded_bytes: size, not_loaded_lines: null, limit, verdict: `skipped entirely: ${size} bytes is over the ${CLAUDE_MD_MAX_BYTES} byte limit, so none of it is loaded`, advice: `${filePath} is skipped by Claude Code (${size} bytes, limit ${CLAUDE_MD_MAX_BYTES}): none of its rules are live. Shrink it below 4 MiB.` }
    }
    const scan = scanFile(filePath)
    const overGuideline = scan.lines > CLAUDE_MD_GUIDELINE_LINES
    return {
      ...baseFinding('claude', 'CLAUDE.md', filePath, scan.bytes),
      lines: scan.lines,
      outcome: 'loaded',
      not_loaded_bytes: 0,
      not_loaded_lines: 0,
      limit,
      verdict: overGuideline ? `loaded in full; ${scan.lines} lines is over the ${CLAUDE_MD_GUIDELINE_LINES}-line guideline (a guideline, not a limit)` : 'loaded in full',
      advice: overGuideline ? `${filePath} has ${scan.lines} lines, over the ${CLAUDE_MD_GUIDELINE_LINES}-line guideline for CLAUDE.md. It still loads in full; the Claude Code docs only recommend staying under that.` : null,
    }
  } catch {
    diagnostics.push({ path: filePath, reason: 'unreadable CLAUDE.md' })
    return null
  }
}

function memoryMdFinding(filePath: string, diagnostics: HostLimitReport['diagnostics']): HostFileFinding | null {
  try {
    const scan = scanFile(filePath, { maxBytes: MEMORY_MD_MAX_BYTES, maxLines: MEMORY_MD_MAX_LINES })
    const lostBytes = scan.bytes - scan.loadedBytes
    const lostLines = scan.lines - scan.loadedLines
    const limit = `first ${MEMORY_MD_MAX_LINES} lines or first 25KB (${MEMORY_MD_MAX_BYTES} or ${MEMORY_MD_MAX_BYTES_KIB} bytes, the docs do not say which), whichever comes first`
    const base = baseFinding('claude', 'MEMORY.md', filePath, scan.bytes)
    if (lostBytes === 0) return { ...base, lines: scan.lines, outcome: 'loaded', not_loaded_bytes: 0, not_loaded_lines: 0, limit, verdict: 'loaded in full', advice: null }
    // Cut under the 25 KiB reading too (by lines or bytes) means cut under either; otherwise only the 25000-byte reading cuts it.
    const generous = scanFile(filePath, { maxBytes: MEMORY_MD_MAX_BYTES_KIB, maxLines: MEMORY_MD_MAX_LINES })
    if (generous.bytes - generous.loadedBytes === 0) {
      const verdict = `uncertain: the docs say 25KB, and this ${scan.bytes}-byte file is cut only if that means ${MEMORY_MD_MAX_BYTES} bytes (KB), which would leave out the last ${lostLines} lines (${lostBytes} bytes); it loads in full if it means ${MEMORY_MD_MAX_BYTES_KIB} bytes (KiB)`
      return { ...base, lines: scan.lines, outcome: 'uncertain', not_loaded_bytes: 0, not_loaded_lines: 0, limit, verdict, advice: `${filePath} is ${scan.bytes} bytes, between 25KB read as ${MEMORY_MD_MAX_BYTES} bytes and as ${MEMORY_MD_MAX_BYTES_KIB} bytes; whether Claude Code cuts it depends on which the docs mean. Trimming it under ${MEMORY_MD_MAX_BYTES} bytes removes the doubt.` }
    }
    return {
      ...base,
      lines: scan.lines,
      outcome: 'cut',
      not_loaded_bytes: lostBytes,
      not_loaded_lines: lostLines,
      limit,
      verdict: `cut: ${lostLines} lines and ${lostBytes} bytes at the end are not loaded`,
      advice: `${filePath} loses its last ${lostLines} lines (${lostBytes} bytes): Claude Code loads only ${MEMORY_MD_MAX_LINES} lines or 25KB. Fold or trim entries so the ones you need come first.`,
    }
  } catch {
    diagnostics.push({ path: filePath, reason: 'unreadable MEMORY.md' })
    return null
  }
}

/** The text of a Codex config.toml, or null when it is absent or must not be read. A config under the project is written by whoever wrote the repository, so `projectRoot` is set for it: a link leading out of the project is not followed. Both layers must be a regular file no larger than the cap the Write hook already holds for the largest file it reads, so a FIFO cannot hang the audit and a huge file cannot exhaust it. */
function readConfigText(configPath: string, projectRoot: string | null, diagnostics: HostLimitReport['diagnostics']): string | null {
  const refuse = (reason: string): null => {
    diagnostics.push({ path: configPath, reason: `${reason}; the default budget is assumed` })
    return null
  }
  if (projectRoot !== null && !projectPathIsConsultable(configPath, projectRoot)) return refuse('Codex config.toml leads outside the project, so it is not read')
  let stat: fs.Stats
  try {
    stat = fs.statSync(configPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return refuse('unreadable Codex config.toml')
  }
  if (!stat.isFile()) return refuse('Codex config.toml is not a regular file')
  if (stat.size > MAX_OLD_FILE_BYTES_FOR_DIFF) return refuse(`Codex config.toml is over ${MAX_OLD_FILE_BYTES_FOR_DIFF} bytes`)
  try {
    return fs.readFileSync(configPath, 'utf8')
  } catch {
    return refuse('unreadable Codex config.toml')
  }
}

function readCodexConfig(configPath: string, projectRoot: string | null, diagnostics: HostLimitReport['diagnostics']): { budget: number | null; fallbackNames: string[] | null } {
  const text = readConfigText(configPath, projectRoot, diagnostics)
  if (text === null) return { budget: null, fallbackNames: null }
  try {
    const parsed = parse(text)
    const raw = parsed['project_doc_max_bytes']
    const budget = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
    const names = parsed['project_doc_fallback_filenames']
    const fallbackNames = !Array.isArray(names) ? null : names.filter((n): n is string => typeof n === 'string' && n !== '' && path.basename(n) === n)
    return { budget, fallbackNames }
  } catch {
    diagnostics.push({ path: configPath, reason: 'Codex config.toml is not valid TOML; the default budget is assumed' })
    return { budget: null, fallbackNames: null }
  }
}

function firstExistingFile(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not there: try the next name
    }
  }
  return null
}

function codexFindings(input: HostLimitInput, diagnostics: HostLimitReport['diagnostics']): { findings: HostFileFinding[]; codex: HostLimitReport['codex'] } {
  const codexHome = (process.env['CODEX_HOME'] ?? '') !== '' ? codexHomeDir() : path.join(input.home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const userConfig = readCodexConfig(configPath, null, diagnostics)
  // The project's own .codex/config.toml is a config layer above the user's, and project_doc_max_bytes is not among the keys Codex strips from a project layer (PROJECT_LOCAL_CONFIG_DENYLIST in codex-rs/config/src/loader/mod.rs at rust-v0.163.0, read 2026-10-19; the layer is disabled for an untrusted project, which the audit cannot tell). Only the project root is checked, not the parent directories Codex also walks.
  const projectConfigPath = path.join(input.project, '.codex', 'config.toml')
  const projectConfig = readCodexConfig(projectConfigPath, input.project, diagnostics)
  const budgetFromProject = projectConfig.budget !== null
  const configuredBudget = projectConfig.budget ?? userConfig.budget
  const fallbackNames = projectConfig.fallbackNames ?? userConfig.fallbackNames ?? []
  const budgetBytes = configuredBudget ?? CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES
  const budgetSource = configuredBudget === null ? 'default' : budgetFromProject ? 'project config' : 'configured'
  const budgetConfigPath = budgetFromProject ? projectConfigPath : configPath
  const findings: HostFileFinding[] = []
  const limit = `project_doc_max_bytes ${budgetBytes} (${budgetSource}${budgetFromProject ? `, ${PROJECT_CONFIG_TRUST_NOTE}` : ''}), a total across all project docs`
  let remaining = budgetBytes
  let projectTotal = 0
  // Codex walks from the project root down to the working directory; the audit has only the project root, so that is the one directory checked.
  const projectDoc = firstExistingFile(input.project, [CODEX_LOCAL_NAME, CODEX_DEFAULT_NAME, ...fallbackNames])
  const docs = projectDoc === null ? [] : [projectDoc]
  // A doc named only by the project config's fallback list was chosen by that layer, so it carries the same trust caveat as a project budget.
  const docName = projectDoc === null ? '' : path.basename(projectDoc)
  const fallbackFromProject = projectConfig.fallbackNames?.includes(docName) === true && docName !== CODEX_LOCAL_NAME && docName !== CODEX_DEFAULT_NAME
  const projectSources: string[] = []
  if (budgetFromProject) projectSources.push('the budget comes from the project config')
  if (fallbackFromProject) projectSources.push('the doc was found through project_doc_fallback_filenames in the project config')
  const trustNote = projectSources.length > 0 ? `; ${projectSources.join(' and ')}, which ${PROJECT_CONFIG_TRUST_NOTE}` : ''
  const adviceSentence = projectSources.join(' and ')
  const adviceTrustNote = projectSources.length > 0 ? ` ${adviceSentence.charAt(0).toUpperCase()}${adviceSentence.slice(1)}, which ${PROJECT_CONFIG_TRUST_NOTE}.` : ''
  for (const doc of docs) {
    let size: number
    try {
      size = fs.statSync(doc).size
    } catch {
      diagnostics.push({ path: doc, reason: 'unreadable AGENTS.md' })
      continue
    }
    const kind = path.basename(doc)
    if (size === 0) {
      findings.push({ ...baseFinding('codex', kind, doc, size), lines: 0, outcome: 'skipped', not_loaded_bytes: 0, not_loaded_lines: 0, limit, verdict: 'empty, Codex skips empty files', advice: null })
      continue
    }
    projectTotal += size
    const lines = scanFile(doc).lines
    if (remaining === 0) {
      findings.push({ ...baseFinding('codex', kind, doc, size), lines, outcome: 'skipped', not_loaded_bytes: size, not_loaded_lines: lines, limit, verdict: `skipped: the ${budgetBytes} byte budget is already used up, so none of it is loaded${trustNote}`, advice: `${doc} is skipped by Codex: the ${budgetBytes} byte project_doc_max_bytes budget (${budgetSource}) is already spent. Trim the files before it, split instructions across nested directories, or raise project_doc_max_bytes in ${budgetConfigPath}.${adviceTrustNote}` })
      continue
    }
    if (size > remaining) {
      const cutAt = remaining
      const loaded = scanFile(doc, { maxBytes: cutAt, maxLines: Infinity })
      const lostBytes = size - cutAt
      const lostLines = lines - loaded.loadedLines
      remaining = 0
      findings.push({ ...baseFinding('codex', kind, doc, size), lines, outcome: 'cut', not_loaded_bytes: lostBytes, not_loaded_lines: lostLines, limit, verdict: `cut at byte ${cutAt} of ${size}: the last ${lostBytes} bytes (${lostLines} lines) are not loaded${trustNote}`, advice: `${doc} is cut by Codex at ${cutAt} bytes (budget ${budgetBytes}, ${budgetSource}); ${lostBytes} bytes are not loaded. Trim it, split instructions across nested directories, or raise project_doc_max_bytes in ${budgetConfigPath}.${adviceTrustNote}` })
      continue
    }
    remaining -= size
    findings.push({ ...baseFinding('codex', kind, doc, size), lines, outcome: 'loaded', not_loaded_bytes: 0, not_loaded_lines: 0, limit, verdict: `loaded in full (${size} of ${budgetBytes} budget bytes)${trustNote}`, advice: null })
  }
  // The user-level file is passed to Codex separately from the project docs, so it does not draw on the project_doc_max_bytes budget (codex-rs/core/src/agents_md.rs load_project_instructions: `remaining = config.project_doc_max_bytes` is set after the user instructions are loaded).
  const globalDoc = firstExistingFile(codexHome, [CODEX_LOCAL_NAME, CODEX_DEFAULT_NAME])
  if (globalDoc !== null) {
    try {
      const scan = scanFile(globalDoc)
      findings.push({ ...baseFinding('codex', `global ${path.basename(globalDoc)}`, globalDoc, scan.bytes), lines: scan.lines, outcome: 'loaded', not_loaded_bytes: 0, not_loaded_lines: 0, limit: 'not counted against project_doc_max_bytes', verdict: 'loaded in full; every session pays for it', advice: null })
    } catch {
      diagnostics.push({ path: globalDoc, reason: 'unreadable global AGENTS.md' })
    }
  }
  return { findings, codex: { budget_bytes: budgetBytes, budget_source: budgetSource, config_path: budgetConfigPath, project_total_bytes: projectTotal } }
}

function listInstructionFiles(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.endsWith('.instructions.md')) out.push(full)
    else if (entry.isDirectory() && depth > 0) listInstructionFiles(full, depth - 1, out)
  }
}

function copilotFindings(input: HostLimitInput, diagnostics: HostLimitReport['diagnostics']): HostFileFinding[] {
  const files: { kind: string; path: string }[] = []
  const main = path.join(input.project, '.github', 'copilot-instructions.md')
  const scoped: string[] = []
  listInstructionFiles(path.join(input.project, '.github', 'instructions'), COPILOT_INSTRUCTIONS_DIR_DEPTH, scoped)
  scoped.sort()
  const agents = path.join(input.project, CODEX_DEFAULT_NAME)
  for (const candidate of [{ kind: 'copilot-instructions.md', path: main }, ...scoped.map((p) => ({ kind: '*.instructions.md', path: p })), { kind: 'AGENTS.md', path: agents }]) {
    try {
      if (fs.statSync(candidate.path).isFile()) files.push(candidate)
    } catch {
      // absent: nothing to report
    }
  }
  const findings: HostFileFinding[] = []
  for (const file of files) {
    try {
      const scan = scanFile(file.path)
      const over = scan.lines > COPILOT_GUIDELINE_LINES
      findings.push({
        ...baseFinding('copilot', file.kind, file.path, scan.bytes),
        lines: scan.lines,
        outcome: 'loaded',
        not_loaded_bytes: 0,
        not_loaded_lines: 0,
        limit: 'no truncation limit documented',
        verdict: over ? `no cut documented; ${scan.lines} lines is over the ~${COPILOT_GUIDELINE_LINES}-line per-file guideline (a quality guideline, not a limit)` : 'no cut documented',
        advice: over ? `${file.path} has ${scan.lines} lines. GitHub advises about ${COPILOT_GUIDELINE_LINES} lines per instruction file at most, past which response quality may deteriorate; nothing is documented as cut.` : null,
      })
    } catch {
      diagnostics.push({ path: file.path, reason: `unreadable ${file.kind}` })
    }
  }
  return findings
}

/** Files that lose content come first (most bytes lost first), then the rest by estimated tokens, so the first row is where to start. */
export function compareByCost(a: HostFileFinding, b: HostFileFinding): number {
  return b.not_loaded_bytes - a.not_loaded_bytes || b.estimated_tokens - a.estimated_tokens || a.path.localeCompare(b.path)
}

export function buildHostLimitReport(input: HostLimitInput): HostLimitReport {
  const diagnostics: HostLimitReport['diagnostics'] = []
  const findings: HostFileFinding[] = []
  for (const claudeMd of input.claudeMdPaths) {
    const finding = claudeMdFinding(claudeMd, diagnostics)
    if (finding !== null) findings.push(finding)
  }
  if (input.memoryPath !== null) {
    const finding = memoryMdFinding(input.memoryPath, diagnostics)
    if (finding !== null) findings.push(finding)
  }
  const codex = codexFindings(input, diagnostics)
  findings.push(...codex.findings, ...copilotFindings(input, diagnostics))
  findings.sort(compareByCost)
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason))
  return { findings, unknown: UNKNOWN_LIMITS.map((u) => ({ ...u })), codex: codex.codex, diagnostics }
}
