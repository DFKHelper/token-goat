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
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { suggestedIndexCommand } from './index_health.js'
import { projectScopeClause } from './sql_path.js'
import { isTestFile } from './util.js'
import { normalizePath, toDisplayPath } from './paths.js'
import { findClaudeMdFiles } from './cli_context_stats.js'

/** Summary of a project's shape: file/language counts and headline symbols. */
export interface ProjectMap {
  readonly rootDir: string
  readonly fileCount: number
  readonly languages: Record<string, number>
  readonly topSymbols: SymbolEntry[]
  readonly recentFiles: string[]
  // Effective compact decision this map was built with -- true when the caller passed --compact, OR the file count crossed repomap.compact_file_threshold. Callers MUST pass this (not their own raw opts.compact) to formatProjectMap so the rendering matches what topSymbols/recentFiles were actually sized for.
  readonly compact: boolean
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
export function walkProject(
  rootDir: string,
  opts: { excludeTests?: boolean; includeEmbeddableDocuments?: boolean; maxFiles?: number } = {},
): WalkResult {
  const files: string[] = []
  const languages: Record<string, number> = {}
  const stack: string[] = [rootDir]
  const excludeTests = opts.excludeTests === true
  // Opt-in only (walk_index.ts's collectWalkIndexFiles for `token-goat index --walk`): other
  // walkProject callers (project-map, grep-across-project text commands) must keep skipping
  // PDF/DOCX/PPTX/XLSX -- they have no Language entry and treating them as source text there
  // would misreport project-map's language histogram or grep binary bytes as text.
  const includeEmbeddableDocuments = opts.includeEmbeddableDocuments === true
  // indexing.skip_dirs (config.toml `[indexing] skip_dirs = [...]`, see config.ts's
  // IndexingConfig) merges with the always-skipped SKIP_DIRS set above, so project-specific
  // generated directories can be excluded from a non-git walk the same way they already are
  // from a git-tracked `index` run (see isUnderSkipDir in parser.ts).
  const extraSkipDirs = loadConfig().indexing.skip_dirs
  // Callers that have explicitly opted past the default ceiling (`index --walk --force`, see
  // walk_index.ts) raise it here. Still a finite bound, never unlimited: an unbounded walk is
  // how a mistyped root turns into a whole-drive scan.
  const maxFiles = opts.maxFiles ?? MAX_FILES_SCANNED

  while (stack.length > 0 && files.length < maxFiles) {
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
        if (SKIP_DIRS.has(entry.name) || extraSkipDirs.includes(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.') {
          // Skip hidden dirs (dotfiles dirs) other than the root itself.
          continue
        }
        stack.push(full)
      } else if (entry.isFile()) {
        const lang: Language = detectLanguage(full)
        if (lang === 'unknown' && !(includeEmbeddableDocuments && isEmbeddableDocument(full))) continue
        if (excludeTests && isTestFile(full)) continue
        files.push(full)
        languages[lang] = (languages[lang] ?? 0) + 1
        if (files.length >= maxFiles) break
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
  readonly parent: string | null
}

/**
 * Fetch headline symbols from the index: ranked by how often they're
 * referenced elsewhere in the project (most-referenced first), with the
 * class/interface/function kind ordering and body length as tie-breaks.
 * Reference count is a much better orientation signal than body length --
 * a heavily-called function matters more than a long, never-referenced
 * class. Returns `[]` when the index is empty or unavailable so `map` works
 * before any indexing has happened.
 *
 * `global.db` is a single machine-wide index keyed by absolute path across every
 * project ever indexed (see constants.ts), so this query MUST be scoped to
 * `rootDir` via {@link projectScopeClause} -- otherwise `map` mixes in headline
 * symbols from unrelated projects that happen to share the same index.
 *
 * `refs` rows carry only a `name` (no target-symbol column), so the ref count
 * is aggregated once per name in a subquery -- scoped to the same project via
 * `projectScopeClause('file_path')` -- and left-joined onto `symbols`, rather
 * than joining the raw `refs` table per symbol row.
 */
/**
 * The exact SQL {@link fetchTopSymbols} runs, exported so its query plan can be asserted against
 * the shipping string rather than a copy retyped in a test -- a copy would keep passing while
 * production silently regressed. See tests/baseline_top_symbols_plan.test.ts.
 */
export function buildTopSymbolsSql(): string {
  const { clause } = projectScopeClause('file_path')
  const refScope = projectScopeClause('file_path')
  // refs carry only a bare name, so a name defined N times cannot claim all N copies' references: divide by the number of same-named definitions, and keep one representative per name so a generic helper like `apply` occupies one slot instead of seven.
        // Ranking selects only each body's LENGTH, never its text, and the rowid join pulls bodies back for the `limit` survivors alone. Selecting `body` inside the window query instead makes SQLite carry every symbol's full text (up to boundSymbolBody's 131072 chars) through both window functions before LIMIT discards nearly all of it.
        // Both path filters are range predicates (sql_path.ts), so the planner picks the file_path index on its own and no INDEXED BY override is needed to keep it off a full scan of the machine-wide index. An earlier LIKE-based clause did need one on the refs aggregate, because a LIKE carrying an ESCAPE cannot drive an index at all and the planner then preferred whichever index made GROUP BY sort-free.
  return `SELECT s.file_path, s.name, s.kind, s.line_start, s.line_end, s.body, s.docstring, s.parent
         FROM (
           SELECT rid, kind, score, body_len
           FROM (
             SELECT t.rid, t.name, t.kind, t.body_len,
                    COALESCE(r.ref_count, 0) * 1.0 / COUNT(*) OVER (PARTITION BY t.name) AS score,
                    ROW_NUMBER() OVER (
                      PARTITION BY t.name
                      ORDER BY t.body_len DESC, t.file_path
                    ) AS rn
             FROM (
               SELECT rowid AS rid, file_path, name, kind, LENGTH(COALESCE(body, '')) AS body_len
               FROM symbols
               WHERE kind IN ('class', 'function', 'interface') AND ${clause}
                 AND LENGTH(name) >= 4
                                                   AND file_path NOT LIKE '%/tests/%' ESCAPE '\\'
                                                   AND file_path NOT LIKE '%/test/%' ESCAPE '\\'
                                                   AND file_path NOT LIKE '%/__tests__/%' ESCAPE '\\'
                                                   AND file_path NOT LIKE '%/spec/%' ESCAPE '\\'
                 AND file_path NOT LIKE '%.test.%'
                 AND file_path NOT LIKE '%.spec.%'
             ) t
             LEFT JOIN (
               SELECT name, COUNT(DISTINCT file_path) AS ref_count
               FROM refs
               WHERE ${refScope.clause}
               GROUP BY name
             ) r ON r.name = t.name
           )
           WHERE rn = 1
           ORDER BY score DESC,
                    CASE kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 ELSE 2 END,
                    body_len DESC
           LIMIT ?
         ) top
         JOIN symbols s ON s.rowid = top.rid
         ORDER BY top.score DESC,
                  CASE top.kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 ELSE 2 END,
                  top.body_len DESC`
}

function fetchTopSymbols(limit: number, dbPath: string, rootDir: string): SymbolEntry[] {
  try {
    const db = getDb(dbPath)
    // Bind order follows the SQL text: the symbols filter's bounds, then the refs aggregate's.
    const bounds = projectScopeClause('file_path').params(rootDir)
    const rows = db.prepare(buildTopSymbolsSql()).all(...bounds, ...bounds, limit) as TopSymbolRow[]
    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      body: r.body ?? '',
      docstring: r.docstring ?? '',
      parent: r.parent ?? '',
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
  const config = loadConfig()
  const { files, languages } = walkProject(root, { excludeTests: config.repomap.exclude_tests })
  // Auto-switch to the compact rendering once a project's file count crosses repomap.compact_file_threshold, even when the caller didn't pass --compact -- keeps the default `map`/`baseline` output within a sane token budget on large repos without requiring every large-project user to remember the flag.
  const compact = opts.compact === true || files.length > config.repomap.compact_file_threshold
  const symbolLimit = compact ? 10 : 30
  const topSymbols = fetchTopSymbols(symbolLimit, globalDbPath(), root)

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
    .slice(0, compact ? 5 : 15)
    .map((x) => path.relative(root, x.f))

  return {
    rootDir: root,
    fileCount: files.length,
    languages,
    topSymbols,
    recentFiles,
    compact,
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
    // Name the file in BOTH modes. Compact used to omit it entirely, and since
    // repomap.compact_file_threshold defaults to 50, compact is what every real project actually
    // renders -- so in practice a top symbol was never addressable without a follow-up `symbol`
    // call, which is worst for exactly the generic names this list surfaces (`out`, `file`,
    // `matches`). Full mode named only path.basename(), which is ambiguous across directories
    // (every project has several index.ts) and is not a resolvable spec. A root-relative display
    // path is, so `- normalizePath (function) — src/paths.ts:12-23` can be fed straight back in as
    // `read "src/paths.ts::normalizePath"`. Costs ~10 tokens a line and saves a round trip each.
    for (const s of map.topSymbols) {
      const loc = `${toDisplayPath(map.rootDir, s.filePath)}:${s.lineStart}-${s.lineEnd}`
      lines.push(`- ${s.name} (${s.kind}) — ${loc}`)
    }
  } else {
    // Reuses checkSymbolCount's wording (cli_doctor.ts) for the same empty-index condition, so a `map` against an unindexed project says so instead of silently omitting the whole section -- otherwise the missing heading reads as "this project has no notable symbols" rather than "this project has never been indexed". The command is built by suggestedIndexCommand rather than hardcoded: a bare `token-goat index .` refuses outright in a non-git folder, which is exactly the case this branch fires in most, so the hardcoded form printed a command that could not run as shown.
    lines.push('')
    lines.push(`## Top symbols: none — no files indexed for this project; run '${suggestedIndexCommand(map.rootDir)}'`)
  }

  if (!compact && map.recentFiles.length > 0) {
    lines.push('')
    lines.push('## Recent files')
    for (const f of map.recentFiles) {
      lines.push(`- ${f}`)
    }
  }


  return lines.join(String.fromCharCode(10))
}

/**
 * Approximate the bytes a `map` call saves versus reading its surfaced files individually, for the
 * `map_lookup` stat. "Full source" is the on-disk size of every file the map surfaces (recentFiles
 * + topSymbols' files), deduplicated, minus the map text actually emitted.
 *
 * The dedup is why both path lists must be canonicalized through {@link normalizePath} first:
 * recentFiles are RELATIVE to `map.rootDir` (see {@link buildProjectMap}) while topSymbols'
 * filePaths are ABSOLUTE and stored via normalizePath (forward-slash, 8.3-expanded, lower-cased
 * drive on Windows). Without canonicalizing, a file present in BOTH lists lands as two distinct
 * Set keys -- e.g. `'src/cli.ts'` and `'c:/proj/src/cli.ts'`, or (on Windows) a native
 * back-slash resolve vs the forward-slash normalized form -- that never dedup, so its size is
 * counted twice and the stat is inflated. Shared by cmdMap (cli.ts) and the MCP `map` tool
 * (mcp_server.ts) so the two accountings cannot drift.
 */
export function mapLookupBytesSaved(map: ProjectMap, emittedText: string): number {
  const referencedFiles = new Set<string>([
    ...map.recentFiles.map((f) => normalizePath(path.resolve(map.rootDir, f))),
    ...map.topSymbols.map((s) => normalizePath(s.filePath)),
  ])
  // The full on-disk size of every referenced file is not a real counterfactual: nobody reads
  // every file surfaced by `map` in full. The realistic alternative to `map` is a plain
  // directory listing of the same files, so the baseline is the byte cost of listing their
  // paths, not the bytes of their contents.
  const listingText = Array.from(referencedFiles).sort().join('\n')
  const fullSourceBytes = Buffer.byteLength(listingText, 'utf8')
  const emittedBytes = Buffer.byteLength(emittedText, 'utf8')
  return Math.max(1, fullSourceBytes - emittedBytes)
}

/** A bullet line that isn't itself a heading, list continuation, or blank -- a lightweight, single-line markdown bullet. */
const BULLET_LINE_RE = /^[-*]\s+\S.*$/
/** Heading text naming an obviously-structural section (Architecture, File Structure, ...) whose bullets are inventory/reference content, not preference-shaped. */
const STRUCTURAL_HEADING_RE = /\b(architecture|file structure|directory structure|repository structure|project structure|folder structure)\b/i
/** Heading text marking a must-enforce/critical directive section -- content that has to stay in the deterministic system-prompt channel, never migrated to a queryable memory store. */
const CRITICAL_HEADING_RE = /\b(MANDATORY|REQUIRED|CRITICAL|NEVER|ALWAYS)\b/

/** One CLAUDE.md/AGENTS.md file with a count of preference-shaped bullet lines found in it. */
export interface MemSuggestion {
  readonly path: string
  readonly count: number
}

/**
 * Scans a project's CLAUDE.md/AGENTS.md files for preference/decision-shaped bullet lines
 * that are candidates for `mem import --from-md` migration: single-line bullets that are
 * NOT under an obviously-structural heading (Architecture, File Structure, ...) and NOT
 * under a heading that reads as a must-enforce directive (MANDATORY/REQUIRED/CRITICAL/
 * NEVER/ALWAYS as a heading marker) -- that content must stay in the deterministic
 * system-prompt channel, never migrated to a queryable memory store.
 *
 * This is a lightweight heuristic kept in the spirit of (not byte-identical to) the
 * mem-side `mem import --from-md` classifier, so behavior doesn't surprise a user running
 * both. Purely advisory: it never invokes `mem`, never writes anything, and works whether
 * or not `mem` is installed -- it is just a text hint about a command the user could run.
 */
export function findMemSuggestionCandidates(projectRoot: string): MemSuggestion[] {
  const claudeMdFiles = findClaudeMdFiles(projectRoot)
  const candidateFiles = new Set<string>(claudeMdFiles)
  for (const claudeMd of claudeMdFiles) {
    const agentsMd = path.join(path.dirname(claudeMd), 'AGENTS.md')
    if (fs.existsSync(agentsMd)) candidateFiles.add(agentsMd)
  }

  const suggestions: MemSuggestion[] = []
  for (const filePath of candidateFiles) {
    let text: string
    try {
      text = fs.readFileSync(filePath, { encoding: 'utf-8' })
    } catch {
      continue
    }

    let count = 0
    let skipSection = false
    let skipLevel = 0
    for (const rawLine of text.split(String.fromCharCode(10))) {
      const line = rawLine.trim()
      if (line.startsWith('#')) {
        const level = /^#+/.exec(line)?.[0].length ?? 0
        // A deeper subheading with no CRITICAL/structural keyword of its own is still nested
        // inside the enclosing skip section -- only a heading at the same or shallower level
        // can end it.
        if (skipSection && level > skipLevel) continue
        const heading = line.replace(/^#+\s*/, '')
        skipSection = STRUCTURAL_HEADING_RE.test(heading) || CRITICAL_HEADING_RE.test(heading)
        skipLevel = level
        continue
      }
      if (skipSection) continue
      if (BULLET_LINE_RE.test(line)) count++
    }

    if (count > 0) suggestions.push({ path: filePath, count })
  }

  return suggestions
}

/**
 * Renders the `--suggest-mem` advisory block for `token-goat baseline`: one
 * `mem import --from-md <path>` suggestion per qualifying CLAUDE.md/AGENTS.md file.
 * Returns '' when there is nothing to suggest.
 */
export function formatMemSuggestions(projectRoot: string): string {
  const suggestions = findMemSuggestionCandidates(projectRoot)
  if (suggestions.length === 0) return ''

  const lines: string[] = ['', '## mem suggestions']
  for (const s of suggestions) {
    const basename = path.basename(s.path)
    lines.push(
      'Consider: mem import --from-md ' + s.path + '  # migrates ' + s.count + ' preference-shaped lines from ' + basename + ' as pending facts for review',
    )
  }
  return lines.join(String.fromCharCode(10))
}
