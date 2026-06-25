/**
 * CLI handler for ``token-goat context-stats``.
 *
 * Inspects the CLAUDE.md and MEMORY.md files that Claude Code loads for the
 * current project and reports estimated token usage.  The ``--fix`` flag
 * delegates to memory_prune to drop stale entries; ``--json`` emits machine-
 * readable output.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ---- helpers ----------------------------------------------------------------

/** Estimate tokens for a file (bytes / 4, matching Python cli_context_stats._tok). */
export function tok(filePath: string): number {
  try {
    const size = fs.statSync(filePath).size
    return Math.floor(size / 4)
  } catch {
    return 0
  }
}

/** Format a fraction as a percentage string, e.g. "12.3%". */
export function pct(a: number, b: number): string {
  if (b === 0) return '0.0%'
  return `${((a / b) * 100).toFixed(1)}%`
}

/**
 * Return CLAUDE.md files that Claude Code will load for the given project root.
 *
 * Claude Code loads the global ~/.claude/CLAUDE.md plus every CLAUDE.md found
 * walking up the directory tree from the project root.
 */
export function findClaudeMdFiles(projectRoot: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  let current = path.resolve(projectRoot)
  while (true) {
    const candidate = path.join(current, 'CLAUDE.md')
    if (!seen.has(candidate) && fs.existsSync(candidate)) {
      found.push(candidate)
      seen.add(candidate)
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const globalMd = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  if (!seen.has(globalMd) && fs.existsSync(globalMd)) {
    found.push(globalMd)
  }

  return found
}

/**
 * Return the MEMORY.md path for the given project root by scanning
 * ~/.claude/projects/, or null if none is found.
 */
export function findMemoryMd(projectRoot: string): string | null {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    if (!fs.existsSync(projectsDir)) return null

    const rootStr = path.resolve(projectRoot)
    const expectedSlug = rootStr.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+|-+$/g, '')
    const candidate = path.join(projectsDir, expectedSlug, 'memory', 'MEMORY.md')
    if (fs.existsSync(candidate)) return candidate

    for (const entry of fs.readdirSync(projectsDir)) {
      const mem = path.join(projectsDir, entry, 'memory', 'MEMORY.md')
      if (entry === expectedSlug && fs.existsSync(mem)) return mem
    }
    return null
  } catch {
    return null
  }
}

// ---- output -----------------------------------------------------------------

interface ContextStatsRow {
  label: string
  tokens: number
  path: string
}

interface ContextStatsResult {
  claude_md_rows: ContextStatsRow[]
  claude_md_total: number
  memory_md_path: string | null
  memory_md_tokens: number
  total_tokens: number
}

function buildStats(projectRoot: string): ContextStatsResult {
  const claudeMds = findClaudeMdFiles(projectRoot)
  const claudeMdRows: ContextStatsRow[] = []
  let claudeMdTotal = 0

  for (const p of claudeMds) {
    const t = tok(p)
    claudeMdTotal += t
    const parentDir = path.basename(path.dirname(p))
    const label =
      parentDir === '.claude'
        ? '~/.claude/CLAUDE.md'
        : (() => {
            try {
              return path.relative(projectRoot, p)
            } catch {
              return p
            }
          })()
    claudeMdRows.push({ label, tokens: t, path: p })
  }

  const memPath = findMemoryMd(projectRoot)
  const memTok = memPath !== null ? tok(memPath) : 0
  const total = claudeMdTotal + memTok

  return {
    claude_md_rows: claudeMdRows,
    claude_md_total: claudeMdTotal,
    memory_md_path: memPath,
    memory_md_tokens: memTok,
    total_tokens: total,
  }
}

// ---- public entry point -----------------------------------------------------

export interface ContextStatsOptions {
  /** Apply automatic fixes (prune stale memory entries). */
  fix?: boolean
  /** Emit JSON instead of human-readable output. */
  json?: boolean
  /** Project root to analyse (defaults to cwd). */
  project?: string
}

/** Run the ``token-goat context-stats`` command. */
export function runContextStats(opts: ContextStatsOptions = {}): void {
  const projectRoot = path.resolve(opts.project ?? process.cwd())
  const result = buildStats(projectRoot)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  process.stdout.write(`\n# token-goat context-stats\n`)
  process.stdout.write(`Project: ${projectRoot}\n\n`)

  if (result.claude_md_rows.length === 0) {
    process.stdout.write('No CLAUDE.md files found.\n')
  } else {
    process.stdout.write('## CLAUDE.md files\n')
    for (const row of result.claude_md_rows) {
      process.stdout.write(`  ${row.tokens.toString().padStart(6)} tok  ${row.label}\n`)
    }
    process.stdout.write(
      `  ${'─'.repeat(6)}     total\n  ${result.claude_md_total.toString().padStart(6)} tok\n\n`,
    )
  }

  if (result.memory_md_path !== null) {
    process.stdout.write('## MEMORY.md\n')
    process.stdout.write(`  ${result.memory_md_tokens.toString().padStart(6)} tok  ${result.memory_md_path}\n\n`)
  } else {
    process.stdout.write('## MEMORY.md\n  (not found)\n\n')
  }

  process.stdout.write(`## Total estimated context overhead\n`)
  process.stdout.write(`  ${result.total_tokens.toString().padStart(6)} tok\n\n`)

  if (opts.fix === true) {
    process.stdout.write(
      '[--fix] Automatic memory pruning is not yet implemented in the TypeScript port.\n',
    )
  }
}
