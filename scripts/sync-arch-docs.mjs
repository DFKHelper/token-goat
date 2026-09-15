#!/usr/bin/env node
/**
 * scripts/sync-arch-docs.mjs
 *
 * Automated Architecture Documentation Synchronization Engine.
 *
 * Keeps CLAUDE.arch.md's Component Map 100% in sync with the src/ codebase:
 * - Scans all source modules in src/**\/*.ts.
 * - Extracts architectural roles, docstrings, exports, and invariants.
 * - Preserves existing curated descriptions while documenting newly created/split modules.
 * - Enforces zero drift via --check (exit code 1 on mismatch) for pre-commit hooks & CI.
 * - Updates CLAUDE.arch.md in place with --write (default).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCH_DOC = path.join(ROOT, 'CLAUDE.arch.md')
const SRC_DIR = path.join(ROOT, 'src')

const MARKER_START = '<!-- ARCH_COMPONENTS_START -->'
const MARKER_END = '<!-- ARCH_COMPONENTS_END -->'

/**
 * Recursively discover all TypeScript source files in src/.
 */
export function scanSourceFiles(dir = SRC_DIR) {
  const files = []
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(full)
      }
    }
  }
  walk(dir)
  return files
}

/**
 * Normalise relative paths to POSIX slashes (src/foo.ts).
 */
export function toPosixRel(fullPath) {
  return path.relative(ROOT, fullPath).split(path.sep).join('/')
}

/**
 * Extract existing module descriptions from CLAUDE.arch.md.
 */
export function extractExistingDescriptions(content) {
  const descriptions = new Map()
  const rowRegex = /\|\s*\[?`?(src\/[a-zA-Z0-9_/.-]+\.ts)`?\]?(?:\([^)]+\))?\s*\|\s*([^|\r\n]+)\|/g
  let match
  while ((match = rowRegex.exec(content)) !== null) {
    const filePath = match[1].trim()
    const desc = match[2].trim()
    if (filePath && desc && !descriptions.has(filePath)) {
      descriptions.set(filePath, desc)
    }
  }
  return descriptions
}

/**
 * Derive an architectural role description for a module.
 */
export function deriveModuleRole(fullPath, relPath, existingDesc) {
  if (existingDesc) {
    return existingDesc
  }

  const content = fs.readFileSync(fullPath, 'utf8')
  const base = path.basename(relPath, '.ts')

  // 1. Try JSDoc / block comment at start of file
  const docMatch = content.match(/^\s*\/\*\*([\s\S]*?)\*\//)
  if (docMatch) {
    const cleaned = docMatch[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('@'))
      .join(' ')
    if (cleaned.length > 10) {
      const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0]
      return firstSentence.slice(0, 180).trim()
    }
  }

  // 2. Subsystem domain heuristics
  if (relPath.startsWith('src/languages/')) {
    const lang = base.replace(/_(idx|frontend|grammar)$/, '')
    return `Language extractor and symbol parser for ${lang}`
  }
  if (relPath.startsWith('src/tool_filters/')) {
    return `Bash output compression and normalization filter for ${base.replace(/_filter$/, '')}`
  }
  if (relPath.startsWith('src/bridges/')) {
    return `Harness bridge integration and hook configuration for ${base}`
  }
  if (relPath.startsWith('src/hints/')) {
    return `Session hint generator submodule for ${base.replace(/_hints?$/, '')}`
  }
  if (relPath.startsWith('src/render/')) {
    return `Terminal output formatting and rendering for ${base}`
  }
  if (relPath.startsWith('src/cli_cmd_')) {
    return `CLI command group registration and execution for ${base.replace(/^cli_cmd_/, '')}`
  }
  if (relPath.startsWith('src/read_')) {
    return `Surgical read implementation for ${base.replace(/^read_/, '')}`
  }
  if (relPath.startsWith('src/text_')) {
    return `Text processing, analysis, and transformation for ${base.replace(/^text_/, '')}`
  }
  if (relPath.startsWith('src/cli_doctor_')) {
    return `Doctor diagnostic health checks for ${base.replace(/^cli_doctor_/, '')}`
  }
  if (relPath.startsWith('src/util_')) {
    return `Utility helper submodule for ${base.replace(/^util_/, '')}`
  }

  // 3. Key exports
  const exports = []
  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z0-9_]+)/g
  let expMatch
  while ((expMatch = exportRegex.exec(content)) !== null) {
    if (!exports.includes(expMatch[1])) exports.push(expMatch[1])
    if (exports.length >= 4) break
  }
  if (exports.length > 0) {
    return `Exports: ${exports.map((e) => `\`${e}\``).join(', ')}`
  }

  return `Core implementation module for ${base}`
}

/**
 * Assign a source file to an architectural category.
 */
export function categorizeModule(relPath) {
  if (relPath.startsWith('src/bridges/')) return 'Harness Bridges'
  if (relPath.startsWith('src/languages/')) return 'Language Adapters'
  if (relPath.startsWith('src/tool_filters/')) return 'Bash Output, Compression, and Tool Filters'
  if (relPath.startsWith('src/hints/')) return 'Hints, Guidance, and Formatting'
  if (relPath.startsWith('src/render/')) return 'Hints, Guidance, and Formatting'

  const base = path.basename(relPath)

  if (/^(main|cli|cli_dispatch|cli_help|cli_cmd_.*|mcp_server|types)\.ts$/.test(base)) {
    return 'Entry and CLI Dispatch'
  }
  if (/^(parser|parser_.*|worker|index_prune|fingerprint|reconcile|tree_sitter_.*)\.ts$/.test(base)) {
    return 'Indexer and Worker (Critical Path)'
  }
  if (/^(db|db_.*|index_reader|section_reader|constants|stats|stats_.*)\.ts$/.test(base)) {
    return 'Storage and Database'
  }
  if (/^(embeddings|embed_.*|semantic_.*)\.ts$/.test(base)) {
    return 'Embeddings and Semantic Search'
  }
  if (/^(paths|project|repomap|file_.*)\.ts$/.test(base)) {
    return 'Paths, Filesystem, and Project Detection'
  }
  if (/^(hook_registry|relay|hooks_.*|image_shrink|install|code_fold)\.ts$/.test(base)) {
    return 'Hook Subsystem'
  }
  if (/^(session|session_.*|compact|compact_.*|skill_cache|snapshots|resume)\.ts$/.test(base)) {
    return 'Session, Compaction, and Audit'
  }
  if (/^(read_commands|read_.*|text_.*|diff_.*|sanitize_.*|token_.*)\.ts$/.test(base)) {
    return 'Surgical Reads and Text Processing'
  }
  if (/^(bash_.*|filters)\.ts$/.test(base)) {
    return 'Bash Output, Compression, and Tool Filters'
  }
  if (/^(cli_doctor|cli_doctor_.*|reclaim_.*|pack|ask)\.ts$/.test(base)) {
    return 'Diagnostics, Doctor, and Maintenance'
  }
  if (/^(bash_output_cache|web_cache|mcp_cache|gdrive|webfetch|project_memory|disk_cache)\.ts$/.test(base)) {
    return 'Caches and Output Stores'
  }
  if (/^(config|util|util_.*|env|version|reset)\.ts$/.test(base)) {
    return 'Configuration and Utilities'
  }
  if (/^(office_.*|pdf_.*|image_.*|media_.*|json_.*|yaml_.*|xml_.*|sqlite_.*)\.ts$/.test(base)) {
    return 'Media, Documents, and Structured Formats'
  }

  return 'Specialized Subsystems'
}

const CATEGORY_ORDER = [
  'Entry and CLI Dispatch',
  'Indexer and Worker (Critical Path)',
  'Storage and Database',
  'Embeddings and Semantic Search',
  'Paths, Filesystem, and Project Detection',
  'Hook Subsystem',
  'Session, Compaction, and Audit',
  'Surgical Reads and Text Processing',
  'Harness Bridges',
  'Language Adapters',
  'Bash Output, Compression, and Tool Filters',
  'Hints, Guidance, and Formatting',
  'Diagnostics, Doctor, and Maintenance',
  'Caches and Output Stores',
  'Configuration and Utilities',
  'Media, Documents, and Structured Formats',
  'Specialized Subsystems',
]

/**
 * Generate the Markdown component tables for all discovered modules.
 */
export function generateComponentTables(modules) {
  const byCategory = new Map()
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, [])
  }

  for (const m of modules) {
    const list = byCategory.get(m.category) || []
    list.push(m)
    byCategory.set(m.category, list)
  }

  const sections = []

  for (const cat of CATEGORY_ORDER) {
    const list = byCategory.get(cat)
    if (!list || list.length === 0) continue

    list.sort((a, b) => a.relPath.localeCompare(b.relPath))

    const lines = [
      `**${cat}**`,
      '',
      '| Module | Role |',
      '|--------|------|',
    ]

    for (const item of list) {
      lines.push(`| [\`${item.relPath}\`](${item.relPath}) | ${item.role} |`)
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}

/**
 * Core sync logic: reads source files, synchronizes or checks CLAUDE.arch.md.
 */
export function syncArchDocs({ check = false } = {}) {
  const sourceFiles = scanSourceFiles().map(toPosixRel)
  const sourceSet = new Set(sourceFiles)

  if (!fs.existsSync(ARCH_DOC)) {
    throw new Error(`Architecture document not found at: ${ARCH_DOC}`)
  }

  const rawDoc = fs.readFileSync(ARCH_DOC, 'utf8')
  const existingDesc = extractExistingDescriptions(rawDoc)

  // Validate coverage
  const documentedFiles = new Set(existingDesc.keys())
  const missingFiles = sourceFiles.filter((f) => !documentedFiles.has(f))
  const deadLinks = [...documentedFiles].filter((f) => !sourceSet.has(f))

  if (check) {
    let hasDrift = false
    const errors = []

    if (missingFiles.length > 0) {
      hasDrift = true
      errors.push(`Missing from architecture documentation (${missingFiles.length} files):\n` +
        missingFiles.map((f) => `  - ${f}`).join('\n'))
    }
    if (deadLinks.length > 0) {
      hasDrift = true
      errors.push(`Stale/deleted files in architecture documentation (${deadLinks.length} files):\n` +
        deadLinks.map((f) => `  - ${f}`).join('\n'))
    }

    if (hasDrift) {
      process.stderr.write(
        `\n[ERROR] Architecture documentation (CLAUDE.arch.md) is out of sync with src/!\n\n` +
        errors.join('\n\n') +
        `\n\nRun 'npm run docs:arch' to regenerate the component map automatically.\n\n`
      )
      return { ok: false, missingFiles, deadLinks }
    }

    process.stdout.write(`All ${sourceFiles.length} modules in src/ are documented in CLAUDE.arch.md. Zero drift.\n`)
    return { ok: true, count: sourceFiles.length }
  }

  // Build the complete module manifest
  const modules = sourceFiles.map((relPath) => {
    const fullPath = path.join(ROOT, relPath)
    const role = deriveModuleRole(fullPath, relPath, existingDesc.get(relPath))
    const category = categorizeModule(relPath)
    return { relPath, role, category }
  })

  const generatedTables = generateComponentTables(modules)
  const wrappedContent = `${MARKER_START}\n\n${generatedTables}\n\n${MARKER_END}`

  let updatedDoc
  if (rawDoc.includes(MARKER_START) && rawDoc.includes(MARKER_END)) {
    const startIdx = rawDoc.indexOf(MARKER_START)
    const endIdx = rawDoc.indexOf(MARKER_END) + MARKER_END.length
    updatedDoc = rawDoc.slice(0, startIdx) + wrappedContent + rawDoc.slice(endIdx)
  } else {
    // If markers don't exist yet, insert under ## Component Map and before ## Storage Layout
    const compHeader = '## Component Map\n\n'
    const storageHeader = '\n## Storage Layout'
    const compIdx = rawDoc.indexOf(compHeader)
    const storageIdx = rawDoc.indexOf(storageHeader)

    if (compIdx !== -1 && storageIdx !== -1) {
      updatedDoc =
        rawDoc.slice(0, compIdx + compHeader.length) +
        wrappedContent +
        rawDoc.slice(storageIdx)
    } else {
      throw new Error('Could not locate "## Component Map" or "## Storage Layout" in CLAUDE.arch.md')
    }
  }

  // Normalize line endings
  const normalized = updatedDoc.replace(/\r\n/g, '\n')
  fs.writeFileSync(ARCH_DOC, normalized, 'utf8')

  process.stdout.write(`Updated ${ARCH_DOC}: synchronized all ${modules.length} modules across ${CATEGORY_ORDER.length} categories.\n`)
  return { ok: true, count: modules.length }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const check = process.argv.includes('--check')
  const result = syncArchDocs({ check })
  if (!result.ok) {
    process.exit(1)
  }
}
