import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { buildStats } from './cli_context_stats.js'
import { resolveProjectRoot } from './project.js'

export interface BootstrapAuditOptions {
  project?: string
  home?: string
  followLinks?: boolean
  json?: boolean
  top?: number
  warnTokens?: number
  failTokens?: number
  warnBytes?: number
  failBytes?: number
}

interface MetadataEntry {
  kind: 'agent' | 'skill'
  path: string
  description_bytes: number
  tools_bytes: number
  metadata_bytes: number
  estimated_tokens: number
}

interface Diagnostic {
  path: string
  reason: string
}

export interface BootstrapAuditResult {
  project: string
  home: string
  claude_md_tokens: number
  memory_md_tokens: number
  metadata_bytes: number
  metadata_tokens: number
  total_estimated_tokens: number
  counts: { agents: number; skills: number; metadata_files: number }
  largest: MetadataEntry[]
  diagnostics: Diagnostic[]
  budgets: {
    warn_tokens: number | null
    fail_tokens: number | null
    warn_bytes: number | null
    fail_bytes: number | null
    warnings: string[]
    failures: string[]
  }
}

const FRONTMATTER_KEYS = new Set(['description', 'tools', 'allowed-tools', 'allowed_tools'])

function parseBudget(name: string, value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

async function readFrontmatter(filePath: string): Promise<{ description: string; tools: string } | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let first = true
  let inFrontmatter = false
  let key: string | null = null
  let description = ''
  let tools = ''
  try {
    for await (const rawLine of lines) {
      const line = String(rawLine)
      if (first) {
        first = false
        if (line.trim() !== '---') return null
        inFrontmatter = true
        continue
      }
      if (!inFrontmatter) continue
      if (line === '---') {
        lines.close()
        return { description, tools }
      }
      const match = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line)
      const field = match?.[1]
      if (field !== undefined && FRONTMATTER_KEYS.has(field)) {
        key = field === 'description' ? 'description' : 'tools'
        const value = match?.[2] ?? ''
        if (key === 'description') description += (description ? '\n' : '') + value
        else tools += (tools ? '\n' : '') + value
      } else if (key !== null && /^\s+/.test(line)) {
        if (key === 'description') description += '\n' + line.trim()
        else tools += '\n' + line.trim()
      } else {
        key = null
      }
    }
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function scanMetadataRoot(
  root: string,
  kind: 'agent' | 'skill',
  diagnostics: Diagnostic[],
  visitedDirs = new Set<string>(),
  seenFiles = new Set<string>(),
  followLinks = false,
): Promise<MetadataEntry[]> {
  const entries: MetadataEntry[] = []
  let logicalRoot: string
  let rootIsLink: boolean
  try {
    rootIsLink = (await fs.promises.lstat(root)).isSymbolicLink()
    logicalRoot = await fs.promises.realpath(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries
    diagnostics.push({ path: path.resolve(root), reason: 'unreadable root' })
    return entries
  }
  if (rootIsLink && !followLinks) {
    diagnostics.push({ path: path.resolve(root), reason: 'external root link skipped (use --follow-links)' })
    return entries
  }
  const canonicalKey = (candidate: string): string =>
    process.platform === 'win32' ? candidate.toLocaleLowerCase() : candidate
  const isContained = (candidate: string, allowedRoot: string): boolean => {
    const relative = path.relative(canonicalKey(allowedRoot), canonicalKey(candidate))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  async function visit(candidate: string, allowedRoot?: string, topLevel = false): Promise<void> {
    let real: string
    let candidateIsLink: boolean
    try {
      candidateIsLink = (await fs.promises.lstat(candidate)).isSymbolicLink()
      real = await fs.promises.realpath(candidate)
    } catch {
      diagnostics.push({ path: path.resolve(candidate), reason: 'broken or unreadable link' })
      return
    }
    const withinAllowedRoot = allowedRoot === undefined ? isContained(real, logicalRoot) : isContained(real, allowedRoot)
    const canFollowExternal = followLinks && topLevel
    if (!withinAllowedRoot && !canFollowExternal) {
      diagnostics.push({ path: path.resolve(candidate), reason: candidateIsLink ? 'external link skipped (use --follow-links)' : 'canonical target outside scan root' })
      return
    }
    const trustedRoot = !withinAllowedRoot && canFollowExternal ? real : allowedRoot ?? real
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(real)
    } catch {
      diagnostics.push({ path: path.resolve(candidate), reason: 'unreadable' })
      return
    }
    const canonical = process.platform === 'win32' ? real.toLocaleLowerCase() : real
    if (stat.isDirectory()) {
      if (visitedDirs.has(canonical)) return
      visitedDirs.add(canonical)
      let children: fs.Dirent[]
      try {
        children = await fs.promises.readdir(real, { withFileTypes: true })
      } catch {
        diagnostics.push({ path: path.resolve(candidate), reason: 'unreadable directory' })
        return
      }
      children.sort((a, b) => a.name.localeCompare(b.name))
      for (const child of children) await visit(path.join(real, child.name), trustedRoot)
      return
    }
    if (!stat.isFile() || path.extname(real).toLowerCase() !== '.md') return
    if (seenFiles.has(canonical)) return
    seenFiles.add(canonical)
    try {
      const metadata = await readFrontmatter(real)
      if (metadata === null) return
      const descriptionBytes = Buffer.byteLength(metadata.description, 'utf8')
      const toolsBytes = Buffer.byteLength(metadata.tools, 'utf8')
      entries.push({
        kind,
        path: path.resolve(real),
        description_bytes: descriptionBytes,
        tools_bytes: toolsBytes,
        metadata_bytes: descriptionBytes + toolsBytes,
        estimated_tokens: Math.floor((descriptionBytes + toolsBytes) / 4),
      })
    } catch {
      diagnostics.push({ path: path.resolve(candidate), reason: 'unreadable file' })
    }
  }

  try {
    const children = await fs.promises.readdir(logicalRoot, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) await visit(path.join(logicalRoot, child.name), undefined, true)
  } catch {
    diagnostics.push({ path: path.resolve(root), reason: 'unreadable root' })
  }
  return entries
}

export async function buildBootstrapAudit(opts: BootstrapAuditOptions = {}): Promise<BootstrapAuditResult> {
  const project = resolveProjectRoot(opts.project === undefined ? {} : { project: opts.project })
  const home = path.resolve(opts.home ?? os.homedir())
  const context = buildStats(project, home)
  const diagnostics: Diagnostic[] = []
  const top = opts.top === undefined ? 10 : parseBudget('--top', opts.top) ?? 10
  const visitedDirs = new Set<string>()
  const seenFiles = new Set<string>()
  const agents = await scanMetadataRoot(path.join(home, '.claude', 'agents'), 'agent', diagnostics, visitedDirs, seenFiles, opts.followLinks === true)
  const skills = await scanMetadataRoot(path.join(home, '.claude', 'skills'), 'skill', diagnostics, visitedDirs, seenFiles, opts.followLinks === true)
  const largest = [...agents, ...skills]
    .sort((a, b) => b.metadata_bytes - a.metadata_bytes || a.path.localeCompare(b.path))
    .slice(0, top)
  const metadataBytes = [...agents, ...skills].reduce((sum, entry) => sum + entry.metadata_bytes, 0)
  const totalTokens = context.total_tokens + Math.floor(metadataBytes / 4)
  const warnTokens = parseBudget('--warn-tokens', opts.warnTokens)
  const failTokens = parseBudget('--fail-tokens', opts.failTokens)
  const warnBytes = parseBudget('--warn-bytes', opts.warnBytes)
  const failBytes = parseBudget('--fail-bytes', opts.failBytes)
  const warnings: string[] = []
  const failures: string[] = []
  if (warnTokens !== null && totalTokens > warnTokens) warnings.push(`estimated tokens ${totalTokens} exceed warning budget ${warnTokens}`)
  if (failTokens !== null && totalTokens > failTokens) failures.push(`estimated tokens ${totalTokens} exceed failure budget ${failTokens}`)
  if (warnBytes !== null && metadataBytes > warnBytes) warnings.push(`metadata bytes ${metadataBytes} exceed warning budget ${warnBytes}`)
  if (failBytes !== null && metadataBytes > failBytes) failures.push(`metadata bytes ${metadataBytes} exceed failure budget ${failBytes}`)
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason))
  return {
    project,
    home,
    claude_md_tokens: context.claude_md_total,
    memory_md_tokens: context.memory_md_tokens,
    metadata_bytes: metadataBytes,
    metadata_tokens: Math.floor(metadataBytes / 4),
    total_estimated_tokens: totalTokens,
    counts: { agents: agents.length, skills: skills.length, metadata_files: agents.length + skills.length },
    largest,
    diagnostics,
    budgets: { warn_tokens: warnTokens, fail_tokens: failTokens, warn_bytes: warnBytes, fail_bytes: failBytes, warnings, failures },
  }
}

export async function runBootstrapAudit(opts: BootstrapAuditOptions = {}): Promise<void> {
  const result = await buildBootstrapAudit(opts)
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write('# token-goat bootstrap-audit\n')
    process.stdout.write(`Project: ${result.project}\n`)
    process.stdout.write(`Claude context: ${result.claude_md_tokens} tok CLAUDE.md + ${result.memory_md_tokens} tok MEMORY.md\n`)
    process.stdout.write(`Agent/skill metadata: ${result.metadata_bytes} bytes (~${result.metadata_tokens} tok)\n`)
    process.stdout.write(`Total estimated startup context: ${result.total_estimated_tokens} tok\n`)
    process.stdout.write(`Entries: ${result.counts.metadata_files} (${result.counts.agents} agents, ${result.counts.skills} skills)\n\n`)
    process.stdout.write('Largest metadata entries:\n')
    for (const entry of result.largest) process.stdout.write(`  ${entry.metadata_bytes.toString().padStart(7)} bytes  ${entry.path}\n`)
    for (const diagnostic of result.diagnostics) process.stderr.write(`token-goat: bootstrap-audit: skipped ${diagnostic.path} (${diagnostic.reason})\n`)
    for (const warning of result.budgets.warnings) process.stderr.write(`token-goat: bootstrap-audit: warning: ${warning}\n`)
    for (const failure of result.budgets.failures) process.stderr.write(`token-goat: bootstrap-audit: failure: ${failure}\n`)
  }
  if (result.budgets.failures.length > 0) process.exitCode = 3
}
