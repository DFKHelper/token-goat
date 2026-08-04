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

import { confirmAndApply } from './confirm_apply.js'
import { pruneIndex } from './memory_prune.js'
import { resolveProjectRoot } from './project.js'

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

/**
 * Return CLAUDE.md files that Claude Code will load for the given project root.
 *
 * Claude Code loads the global ~/.claude/CLAUDE.md plus every CLAUDE.md found
 * walking up the directory tree from the project root.
 */
export function findClaudeMdFiles(projectRoot: string, homeDir = os.homedir()): string[] {
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

  const globalMd = path.join(homeDir, '.claude', 'CLAUDE.md')
  if (!seen.has(globalMd) && fs.existsSync(globalMd)) {
    found.push(globalMd)
  }

  return found
}

/**
 * Return the MEMORY.md path for the given project root by scanning
 * ~/.claude/projects/, or null if none is found.
 */
export function findMemoryMd(projectRoot: string, homeDir = os.homedir()): string | null {
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    if (!fs.existsSync(projectsDir)) return null

    const rootStr = path.resolve(projectRoot)
    // Real Claude Code project-dir naming convention: every non-alphanumeric char in the resolved path becomes '-', with no leading/trailing trim. A UNC root like \\server\share\proj starts with two backslashes, so its slug genuinely starts with two dashes -- trimming them (as this used to) points at a directory Claude Code never created and findMemoryMd silently misses it.
    const expectedSlug = rootStr.replace(/[^A-Za-z0-9]/g, '-')
    const candidate = path.join(projectsDir, expectedSlug, 'memory', 'MEMORY.md')
    if (fs.existsSync(candidate)) return candidate

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

export function buildStats(projectRoot: string, homeDir = os.homedir()): ContextStatsResult {
  const claudeMds = findClaudeMdFiles(projectRoot, homeDir)
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

  const memPath = findMemoryMd(projectRoot, homeDir)
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
  /** Apply --fix without prompting (non-interactive / scripted use), matching `memory --fix`'s --yes. */
  yes?: boolean
}

/** Run the ``token-goat context-stats`` command. */
export async function runContextStats(opts: ContextStatsOptions = {}): Promise<void> {
  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})
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
    if (result.memory_md_path === null) {
      process.stdout.write('[--fix] No MEMORY.md found; nothing to prune.\n')
    } else {
      const memPath = result.memory_md_path
      const pruneResult = pruneIndex(path.dirname(memPath), { dryRun: true })
      if (!pruneResult.changed || pruneResult.after === undefined) {
        process.stdout.write('[--fix] MEMORY.md already clean; nothing to prune.\n')
      } else {
        const before = fs.readFileSync(memPath, 'utf-8')
        const applyResult = await confirmAndApply(
          [{ path: memPath, before, after: pruneResult.after, label: 'MEMORY.md' }],
          opts.yes === true ? { yes: true } : {},
        )
        if (applyResult.applied.length > 0) {
          process.stdout.write('[--fix] Pruned MEMORY.md\n')
          process.stdout.write(`  removed ${pruneResult.removedDead.length} dead-link entries\n`)
          process.stdout.write(`  removed ${pruneResult.removedDup.length} duplicate entries\n`)
          process.stdout.write(`  kept ${pruneResult.kept} entries\n`)
          process.stdout.write(`  ${pruneResult.tokensSaved} tok saved\n`)
        } else {
          process.stdout.write(
            `[--fix] ${applyResult.dryRun ? 'Dry run' : 'Skipped'} -- MEMORY.md not written. Re-run with --yes to apply without prompting.\n`,
          )
        }
      }
    }
  }
}
