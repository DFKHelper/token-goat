/**
 * Project map / overview (`token-goat map`).
 *
 * Walks a project tree, tallies files per detected {@link Language}, and pulls
 * the most-referenced symbols from the index to give a fast orientation summary
 * — the TS analogue of `cli.py::cmd_map`. The compact form trims the per-symbol
 * detail to fit a tight token budget (the `--compact` flag).
 *
 * The walk is dependency-free (no fast-glob): a bounded recursive `readdirSync`
 * that skips the usual heavyweight directories (node_modules, .git, dist, etc.)
 * so a `map` on a large repo stays cheap.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { globalDbPath } from './constants.js'
import { loadConfig } from './config.js'
import { getDb } from './db.js'
import { detectLanguage } from './parser_types.js'
import type { Language, SymbolEntry } from './parser_types.js'
import { isTestFile } from './util.js'

/** Summary of a project's shape: file/language counts and headline symbols. */
export interface ProjectMap {
  readonly rootDir: string
  readonly fileCount: number
  readonly languages: Record<string, number>
  readonly topSymbols: SymbolEntry[]
  readonly recentFiles: string[]
}

// Directories never worth walking for a project overview. Matched by basename.
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  // Installed Python packages live under <any-venv>/Lib/site-packages or lib/pythonX.Y/site-packages. Skip by this exact name so a non-standard venv directory name (e.g. tmptg-py313-venv) cannot smuggle dependency code into the symbol index — the enclosing venv dir name varies, but site-packages does not.
  'site-packages',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  '.idea',
  '.vscode',
])

// Cap the walk so a pathological tree cannot make `map` run unbounded. Also the "too much stuff" ceiling for the non-git walk-index fallback (see walk_index.ts).
export const MAX_FILES_SCANNED = 20000

export interface WalkResult {
  readonly files: string[]
  readonly languages: Record<string, number>
}

/**
 * Recursively collect source files under `rootDir`, skipping {@link SKIP_DIRS}
 * and any non-source ('unknown') extensions, tallying a language histogram.
 */
export function walkProject(rootDir: string, opts: { excludeTests?: boolean } = {}): WalkResult {
  const files: string[] = []
  const languages: Record<string, number> = {}
  const stack: string[] = [rootDir]
  const excludeTests = opts.excludeTests === true

  while (stack.length > 0 && files.length < MAX_FILES_SCANNED) {
    const dir = stack.pop()
    if (dir === undefined) break

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip it
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.') {
          // Skip hidden dirs (dotfiles dirs) other than the root itself.
          continue
        }
        stack.push(full)
      } else if (entry.isFile()) {
        const lang: Language = detectLanguage(full)
        if (lang === 'unknown') continue
        if (excludeTests && isTestFile(full)) continue
        files.push(full)
        languages[lang] = (languages[lang] ?? 0) + 1
        if (files.length >= MAX_FILES_SCANNED) break
      }
    }
  }

  return { files, languages }
}

/** Raw `symbols` row shape for the top-symbols aggregate query. */
interface TopSymbolRow {
  readonly file_path: string
  readonly name: string
  readonly kind: string
  readonly line_start: number
  readonly line_end: number
  readonly body: string | null
  readonly docstring: string | null
}

/**
 * Fetch headline symbols from the index: classes first, then functions, by
 * body length (a rough proxy for significance). Returns `[]` when the index is
 * empty or unavailable so `map` works before any indexing has happened.
 */
function fetchTopSymbols(limit: number, dbPath: string): SymbolEntry[] {
  try {
    const db = getDb(dbPath)
    const rows = db
      .prepare(
        `SELECT file_path, name, kind, line_start, line_end, body, docstring
         FROM symbols
         WHERE kind IN ('class', 'function', 'interface')
         ORDER BY CASE kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 ELSE 2 END,
                  LENGTH(COALESCE(body, '')) DESC
         LIMIT ?`,
      )
      .all(limit) as TopSymbolRow[]
    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      body: r.body ?? '',
      docstring: r.docstring ?? '',
    }))
  } catch {
    return []
  }
}

/**
 * Build a {@link ProjectMap} for `rootDir` (default: cwd).
 *
 * In compact mode the top-symbols list is trimmed (10 vs 30) to keep the
 * rendered output within a small token budget.
 */
export function buildProjectMap(
  rootDir: string = process.cwd(),
  opts: { compact?: boolean } = {},
): ProjectMap {
  const root = path.resolve(rootDir)
  const { files, languages } = walkProject(root, { excludeTests: loadConfig().repomap.exclude_tests })
  const symbolLimit = opts.compact ? 10 : 30
  const topSymbols = fetchTopSymbols(symbolLimit, globalDbPath())

  // Recent files: most-recently-modified source files, capped for the summary.
  const recentFiles = files
    .map((f) => {
      let mtime: number
      try {
        mtime = fs.statSync(f).mtimeMs
      } catch {
        mtime = 0
      }
      return { f, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, opts.compact ? 5 : 15)
    .map((x) => path.relative(root, x.f))

  return {
    rootDir: root,
    fileCount: files.length,
    languages,
    topSymbols,
    recentFiles,
  }
}

/**
 * Render a {@link ProjectMap} to a human-readable block.
 *
 * Compact mode emits a single language summary line and a short symbol list;
 * the full form adds a recent-files section and per-symbol locations. Compact
 * output is strictly fewer lines than the full form for the same map.
 */
export function formatProjectMap(map: ProjectMap, compact = false): string {
  const lines: string[] = []
  const rel = path.basename(map.rootDir)

  lines.push(`# Project map: ${rel}`)
  lines.push(`Files: ${map.fileCount}`)

  const langPairs = Object.entries(map.languages).sort((a, b) => b[1] - a[1])
  const langSummary = langPairs.map(([lang, n]) => `${lang} ${n}`).join(', ')
  lines.push(`Languages: ${langSummary || '(none)'}`)

  if (map.topSymbols.length > 0) {
    lines.push('')
    lines.push('## Top symbols')
    for (const s of map.topSymbols) {
      if (compact) {
        lines.push(`- ${s.name} (${s.kind})`)
      } else {
        const loc = `${path.basename(s.filePath)}:${s.lineStart}-${s.lineEnd}`
        lines.push(`- ${s.name} (${s.kind}) — ${loc}`)
      }
    }
  }

  if (!compact && map.recentFiles.length > 0) {
    lines.push('')
    lines.push('## Recent files')
    for (const f of map.recentFiles) {
      lines.push(`- ${f}`)
    }
  }

  return lines.join('\n')
}
