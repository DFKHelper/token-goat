/**
 * CLI handler for `token-goat memory --analyze` / `--fix`.
 *
 * `--analyze` (default, read-only): finds the CLAUDE.md files Claude Code
 * loads for the current project (via {@link findClaudeMdFiles}), runs
 * {@link auditClaudeMd} over them for exact-duplicate lines / duplicate
 * headings / cross-file overlaps, and runs {@link findContentDuplicates} over
 * the sibling auto-memory `*.md` files (if a `MEMORY.md` exists for this
 * project) for near-duplicate content clusters. Prints a report; never
 * writes.
 *
 * `--fix` (confirm-gated): builds on `--analyze`. The only mechanical,
 * auto-applicable change is removing exact-duplicate lines within a single
 * CLAUDE.md file (keep the first occurrence, drop the rest) -- that's a pure
 * structural dedup with no judgment call. Duplicate-heading and cross-file
 * overlap findings are advisory only: they often indicate content that
 * *should* move into a path-scoped `.claude/rules/` file or a subdirectory
 * CLAUDE.md, but choosing where is a judgment call this command does not
 * make, so those findings are reported and never auto-applied, with no diff
 * proposed for them. Each exact-dup-line fix is shown as a diff and gated by
 * {@link confirmAndApply} before anything is written.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { findClaudeMdFiles, findMemoryMd } from './cli_context_stats.js'
import { auditClaudeMd, findContentDuplicates, type ClaudeMdReport, type DupCluster } from './memory_prune.js'
import { resolveProjectRoot } from './project.js'
import { confirmAndApply, type FileChange } from './confirm_apply.js'

export interface MemoryCommandOptions {
  project?: string
  fix?: boolean
  yes?: boolean
}

/** Remove this file's exact-duplicate lines (keep the first occurrence of each). */
function removeExactDupLines(text: string, report: ClaudeMdReport): string {
  if (report.exactDupLines.length === 0) return text
  const toRemove = new Set(report.exactDupLines.map(([, dupIdx]) => dupIdx))
  return text
    .split('\n')
    .filter((_line, idx) => !toRemove.has(idx))
    .join('\n')
}

function printReport(reports: ClaudeMdReport[], clusters: DupCluster[]): void {
  const w = (text: string) => { process.stdout.write(text) }

  if (reports.length === 0) {
    w('No CLAUDE.md files found for this project.\n')
  } else {
    w(`## CLAUDE.md files (${reports.length})\n`)
    for (const report of reports) {
      w(`\n  ${report.path}  (${report.tokens} tok)\n`)

      if (report.exactDupLines.length === 0) {
        w('    exact-duplicate lines: none\n')
      } else {
        w(`    exact-duplicate lines: ${report.exactDupLines.length}\n`)
        for (const [firstLine, dupLine, stripped] of report.exactDupLines) {
          const shown = stripped.length > 70 ? `${stripped.slice(0, 70)}…` : stripped
          w(`      line ${dupLine + 1} duplicates line ${firstLine + 1}: "${shown}"\n`)
        }
      }

      if (report.dupSections.length === 0) {
        w('    duplicate headings: none\n')
      } else {
        w(`    duplicate headings: ${report.dupSections.length}  [advisory only]\n`)
        for (const [heading, lnos] of report.dupSections) {
          w(`      "${heading}" at lines ${lnos.map((n) => n + 1).join(', ')}\n`)
        }
      }

      if (report.crossFileOverlaps.length === 0) {
        w('    cross-file overlaps: none\n')
      } else {
        w(`    cross-file overlaps: ${report.crossFileOverlaps.length}  [advisory only]\n`)
        for (const overlap of report.crossFileOverlaps) {
          w(`      ${overlap}\n`)
        }
      }
    }
  }

  w('\n## Duplicate-content clusters (sibling auto-memory files)\n')
  if (clusters.length === 0) {
    w('  none\n')
  } else {
    for (const cluster of clusters) {
      w(
        `  [${cluster.method}, similarity ${cluster.similarity}, ~${cluster.tokens} tok] ` +
          `${cluster.members.map((m) => path.basename(m)).join(', ')}\n`,
      )
    }
  }
}

/** Run the `token-goat memory` command (analyze, or analyze+fix). */
export async function runMemoryCommand(opts: MemoryCommandOptions = {}): Promise<void> {
  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})

  process.stdout.write('\n# token-goat memory\n')
  process.stdout.write(`Project: ${projectRoot}\n\n`)

  const claudeMds = findClaudeMdFiles(projectRoot)
  const reports = auditClaudeMd(claudeMds)

  const memoryMdPath = findMemoryMd(projectRoot)
  const clusters = memoryMdPath !== null ? await findContentDuplicates(path.dirname(memoryMdPath)) : []

  printReport(reports, clusters)

  if (opts.fix !== true) return

  const changes: FileChange[] = []
  for (const report of reports) {
    if (report.exactDupLines.length === 0) continue
    let before: string
    try {
      before = fs.readFileSync(report.path, 'utf-8')
    } catch {
      continue
    }
    const after = removeExactDupLines(before, report)
    if (after === before) continue
    changes.push({ path: report.path, before, after, label: report.path })
  }

  const advisoryCount = reports.reduce((n, r) => n + r.dupSections.length + r.crossFileOverlaps.length, 0)

  if (changes.length === 0) {
    process.stdout.write('\n[--fix] No mechanical (exact-duplicate-line) fixes to apply.\n')
    if (advisoryCount > 0) {
      process.stdout.write(
        '[--fix] Duplicate-heading / cross-file-overlap findings above are advisory only; ' +
          'this command never auto-applies content migration.\n',
      )
    }
    return
  }

  process.stdout.write(
    `\n[--fix] ${changes.length} file(s) have exact-duplicate lines that can be safely removed.\n`,
  )
  const result = await confirmAndApply(changes, opts.yes === true ? { yes: true } : {})

  process.stdout.write(
    `\n[--fix] applied ${result.applied.length} file(s), skipped ${result.skipped.length} file(s)` +
      `${result.dryRun ? ' (dry run)' : ''}\n`,
  )
  if (advisoryCount > 0) {
    process.stdout.write(
      '[--fix] Duplicate-heading / cross-file-overlap findings above are advisory only; ' +
        'this command never auto-applies content migration.\n',
    )
  }
}
