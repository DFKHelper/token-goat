/**
 * `token-goat dep-docs <package>` — surgical read for an installed npm dependency.
 *
 * Same "narrow slice instead of a whole-file/whole-directory dump" philosophy as
 * `symbol`/`read`/`section`/`outline`/`skeleton` (see `read_commands.ts`), applied to the
 * question "how do I use this library" instead of "what does this file contain". Rather than an
 * agent doing a raw Read/Grep sweep across `node_modules/<package>/`'s README, `package.json`,
 * and type declarations, this extracts exactly the three things that are cheap and reliable to
 * pull from an arbitrary installed package:
 *
 * 1. The README (most npm packages document their API there).
 * 2. A handful of `package.json` fields worth surfacing (description, version, entry points).
 * 3. If a `.d.ts` file is resolvable (bundled in the package, or via a companion
 *    `@types/<package>` install), a compact one-line-per-declaration signature outline of its
 *    top-level exported declarations — mirrors `read_commands.ts::runSkeleton`'s one-line-per-
 *    symbol format (kind + name + first line of body/signature), not a full-body dump.
 *
 * Uses the `typescript` compiler API the same way `ts_refs.ts` does: lazily `require`d so a
 * missing/broken install degrades to "no declaration outline" instead of throwing, and never
 * gets statically bundled into `dist/token-goat.mjs` (see `esbuild.config.mjs`'s
 * `EXTERNAL_NATIVE_DEPS`). Unlike `ts_refs.ts`, no `ts.Program`/type checker is needed here —
 * `.d.ts` declarations never contain bodies, so a single `ts.createSourceFile` syntactic parse of
 * the one file is enough to list its top-level exports.
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type TsModule from 'typescript'
import { resolveProjectRoot } from './project.js'
import { loadConfig } from './config.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { recordStat } from './stats.js'

const _require = createRequire(import.meta.url)

let _ts: typeof TsModule | null = null
let _tsLoadAttempted = false
// `undefined` = no override (use the real lazy-loaded module); `null` or a module = forced
// value. Mirrors `ts_refs.ts`'s `_tsOverride`, letting tests exercise the "typescript is
// unavailable" fallback deterministically without uninstalling the package.
let _tsOverride: typeof TsModule | null | undefined = undefined

function loadTs(): typeof TsModule | null {
  if (_tsOverride !== undefined) return _tsOverride
  if (!_tsLoadAttempted) {
    _tsLoadAttempted = true
    try {
      _ts = _require('typescript') as typeof TsModule
    } catch {
      _ts = null
    }
  }
  return _ts
}

/** Test-only: force the `typescript` module resolution. Pass `undefined` to clear the override. */
export function setTsModuleForTesting(mod: typeof TsModule | null | undefined): void {
  _tsOverride = mod
}

// ---- filesystem helpers -------------------------------------------------------

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function readFileTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// ---- "did you mean" for an unresolved package name ----------------------------

// Capped Levenshtein distance, mirroring config_commands.ts's didYouMeanKeySuffix helper and
// text_commands.ts's packageNameDistance (same cap, same top-N/sort-by-distance shape) for
// consistency across this CLI's "did you mean" suggestions.
function packageNameDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr.push(Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost))
    }
    prev.splice(0, prev.length, ...curr)
  }
  return prev[b.length] ?? cap + 1
}

function suggestPackageNames(query: string, names: string[]): string[] {
  return [...new Set(names)]
    .map((n) => ({ n, d: packageNameDistance(query.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.n)
}

/** Every installed package name directly under `nodeModulesDir` (top-level plus scoped `@scope/name`). */
function listInstalledPackageNames(nodeModulesDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped: fs.Dirent[]
      try {
        scoped = fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of scoped) {
        if (s.isDirectory()) names.push(`${entry.name}/${s.name}`)
      }
      continue
    }
    names.push(entry.name)
  }
  return names
}

// ---- README resolution ---------------------------------------------------------

const README_NAME_RE = /^readme(\.(md|markdown|txt))?$/i

function findReadmeFile(pkgDir: string): string | null {
  const direct = findReadmeIn(pkgDir)
  if (direct !== null) return direct
  return findReadmeIn(path.join(pkgDir, 'docs'))
}

function findReadmeIn(dir: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const matches = entries.filter((e) => e.isFile() && README_NAME_RE.test(e.name))
  if (matches.length === 0) return null
  // Prefer README.md over extensionless README over README.txt.
  const rank = (name: string): number => {
    if (/\.md$|\.markdown$/i.test(name)) return 0
    if (/\.txt$/i.test(name)) return 2
    return 1
  }
  matches.sort((a, b) => rank(a.name) - rank(b.name))
  return path.join(dir, (matches[0] as fs.Dirent).name)
}

// ---- types (.d.ts) resolution ---------------------------------------------------

interface TypesLocation {
  path: string
  source: 'bundled' | '@types'
}

/** npm's `@types/<name>` package directory name for a (possibly scoped) package name. */
function typesPackageDirName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const rest = pkgName.slice(1)
    const slash = rest.indexOf('/')
    if (slash === -1) return rest
    return `${rest.slice(0, slash)}__${rest.slice(slash + 1)}`
  }
  return pkgName
}

/** Recursively finds a `"types"` string anywhere in a package.json `exports` map's self-entry. */
function findTypesInExports(exportsField: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof exportsField !== 'object' || exportsField === null) return undefined
  const obj = exportsField as Record<string, unknown>
  if (typeof obj['types'] === 'string') return obj['types']
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') continue
    const found = findTypesInExports(v, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function resolveTypesLocation(pkgDir: string, pkgJson: Record<string, unknown>, nodeModulesDir: string, pkgName: string): TypesLocation | null {
  const declared =
    (typeof pkgJson['types'] === 'string' ? pkgJson['types'] : undefined) ??
    (typeof pkgJson['typings'] === 'string' ? pkgJson['typings'] : undefined) ??
    findTypesInExports(pkgJson['exports'])

  if (declared !== undefined) {
    const candidates = [declared, declared.endsWith('.d.ts') ? declared : `${declared}.d.ts`, declared.replace(/\.[cm]?[jt]s$/, '.d.ts')]
    for (const c of candidates) {
      const p = path.join(pkgDir, c)
      if (fileExists(p)) return { path: p, source: 'bundled' }
    }
  }

  // Common convention: an `index.d.ts` sitting beside the main entry with no explicit
  // "types"/"typings" field declaring it.
  const main = typeof pkgJson['main'] === 'string' ? (pkgJson['main'] as string) : 'index.js'
  const mainDts = path.join(pkgDir, main.replace(/\.[cm]?js$/, '.d.ts'))
  if (fileExists(mainDts)) return { path: mainDts, source: 'bundled' }
  const indexDts = path.join(pkgDir, 'index.d.ts')
  if (fileExists(indexDts)) return { path: indexDts, source: 'bundled' }

  // Companion @types/<package> package.
  const typesDirName = typesPackageDirName(pkgName)
  const typesPkgDir = path.join(nodeModulesDir, '@types', typesDirName)
  const typesPkgJsonRaw = readFileTextOrNull(path.join(typesPkgDir, 'package.json'))
  if (typesPkgJsonRaw !== null) {
    try {
      const typesPkgJson = JSON.parse(typesPkgJsonRaw) as Record<string, unknown>
      const entry =
        (typeof typesPkgJson['types'] === 'string' ? typesPkgJson['types'] : undefined) ??
        (typeof typesPkgJson['main'] === 'string' ? typesPkgJson['main'] : undefined) ??
        'index.d.ts'
      const entryPath = path.join(typesPkgDir, entry.endsWith('.d.ts') ? entry : `${entry}.d.ts`)
      if (fileExists(entryPath)) return { path: entryPath, source: '@types' }
    } catch {
      // Malformed @types package.json -- fall through to the plain index.d.ts guess below.
    }
    const fallback = path.join(typesPkgDir, 'index.d.ts')
    if (fileExists(fallback)) return { path: fallback, source: '@types' }
  }

  return null
}

// ---- .d.ts signature outline -----------------------------------------------------

export interface DeclarationRow {
  kind: string
  name: string
  line: number
  signature: string
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
}

function isExportedStatement(ts: typeof TsModule, node: TsModule.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/** One-line-per-declaration outline of a `.d.ts` file's top-level exported declarations, mirroring `read_commands.ts::runSkeleton`'s format. */
export function extractDtsOutline(filePath: string, content: string): DeclarationRow[] | null {
  const ts = loadTs()
  if (ts === null) return null

  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const rows: DeclarationRow[] = []

  const push = (kind: string, name: string, node: TsModule.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    rows.push({ kind, name, line, signature: firstLine(node.getText(sourceFile)) })
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && isExportedStatement(ts, stmt)) {
      push('function', stmt.name.text, stmt)
    } else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined && isExportedStatement(ts, stmt)) {
      push('class', stmt.name.text, stmt)
    } else if (ts.isInterfaceDeclaration(stmt) && isExportedStatement(ts, stmt)) {
      push('interface', stmt.name.text, stmt)
    } else if (ts.isTypeAliasDeclaration(stmt) && isExportedStatement(ts, stmt)) {
      push('type', stmt.name.text, stmt)
    } else if (ts.isEnumDeclaration(stmt) && isExportedStatement(ts, stmt)) {
      push('enum', stmt.name.text, stmt)
    } else if (ts.isModuleDeclaration(stmt) && isExportedStatement(ts, stmt)) {
      push('namespace', stmt.name.getText(sourceFile), stmt)
    } else if (ts.isVariableStatement(stmt) && isExportedStatement(ts, stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) push('const', decl.name.text, decl)
      }
    } else if (ts.isExportAssignment(stmt)) {
      push(stmt.isExportEquals === true ? 'export=' : 'export default', '(default)', stmt)
    }
  }

  return rows
}

// ---- overflow guarding ------------------------------------------------------------

function guardText(text: string): string {
  const cfg = loadConfig()
  return cfg.overflow_guard.enabled ? trimToBudget(text, cfg.overflow_guard.max_tokens, 'dep-docs') : text
}

function guardReadmeField(text: string): { text: string; truncated: boolean } {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return { text, truncated: false }
  const trimmed = trimToBudget(text, cfg.overflow_guard.max_tokens, 'dep-docs')
  return { text: trimmed, truncated: trimmed !== text }
}

function guardDeclarationRows(rows: readonly DeclarationRow[]): JsonRowCapResult<DeclarationRow> {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return { items: [...rows], truncated: false, totalCount: rows.length }
  return capJsonRows(rows, cfg.overflow_guard.max_tokens)
}

function recordDepDocsStat(fullSourceBytes: number, emittedText: string, packageName: string): void {
  const emittedBytes = Buffer.byteLength(emittedText, 'utf8')
  const bytesSaved = Math.max(1, fullSourceBytes - emittedBytes)
  recordStat('dep_docs', bytesSaved, Math.round(bytesSaved / 4), undefined, packageName)
}

// ---- public entry point ------------------------------------------------------

export interface DepDocsOptions {
  packageName: string
  json?: boolean
  /** Project root `packageName` resolves `node_modules/` against. Defaults to `process.cwd()`. */
  projectRoot?: string
}

export interface DepDocsResult {
  text: string
  code: number
}

export function runDepDocs(opts: DepDocsOptions): DepDocsResult {
  const root = resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() })
  const nodeModulesDir = path.join(root, 'node_modules')
  const pkgDir = path.join(nodeModulesDir, opts.packageName)
  const pkgJsonPath = path.join(pkgDir, 'package.json')

  if (!dirExists(pkgDir) || !fileExists(pkgJsonPath)) {
    const known = listInstalledPackageNames(nodeModulesDir)
    const suggestions = suggestPackageNames(opts.packageName, known)
    const hint = suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : ''
    return { text: `Package '${opts.packageName}' not found under ${nodeModulesDir}${hint}`, code: 1 }
  }

  const pkgJsonRaw = fs.readFileSync(pkgJsonPath, 'utf8')
  let pkgJson: Record<string, unknown>
  try {
    pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>
  } catch (e) {
    return { text: `Malformed package.json for '${opts.packageName}': ${e instanceof Error ? e.message : String(e)}`, code: 1 }
  }

  const name = typeof pkgJson['name'] === 'string' ? (pkgJson['name'] as string) : opts.packageName
  const version = typeof pkgJson['version'] === 'string' ? (pkgJson['version'] as string) : null
  const description = typeof pkgJson['description'] === 'string' ? (pkgJson['description'] as string) : null
  const main = typeof pkgJson['main'] === 'string' ? (pkgJson['main'] as string) : null

  const readmeFile = findReadmeFile(pkgDir)
  const readmeRaw = readmeFile !== null ? (readFileTextOrNull(readmeFile) ?? '') : ''

  const typesLocation = resolveTypesLocation(pkgDir, pkgJson, nodeModulesDir, opts.packageName)
  const typescriptAvailable = loadTs() !== null
  const dtsContent = typesLocation !== null ? readFileTextOrNull(typesLocation.path) : null
  const declarations = dtsContent !== null ? extractDtsOutline(typesLocation?.path ?? '', dtsContent) : null

  const fullSourceBytes =
    (readmeFile !== null ? Buffer.byteLength(readmeRaw, 'utf8') : 0) +
    Buffer.byteLength(pkgJsonRaw, 'utf8') +
    (dtsContent !== null ? Buffer.byteLength(dtsContent, 'utf8') : 0)

  if (opts.json === true) {
    const readmeField = readmeFile !== null ? guardReadmeField(readmeRaw) : null
    const declCap = declarations !== null ? guardDeclarationRows(declarations) : null
    const payload = {
      package: name,
      version,
      description,
      main,
      packageJsonPath: pkgJsonPath,
      readme:
        readmeField !== null
          ? { file: readmeFile as string, text: readmeField.text, truncated: readmeField.truncated }
          : null,
      types:
        typesLocation !== null ? { entry: typesLocation.path, source: typesLocation.source } : null,
      typescriptAvailable,
      declarations:
        declCap !== null ? { items: declCap.items, truncated: declCap.truncated, totalCount: declCap.totalCount } : null,
    }
    const text = JSON.stringify(payload, null, 2)
    recordDepDocsStat(fullSourceBytes, text, opts.packageName)
    return { text, code: 0 }
  }

  const lines: string[] = [`# ${name}${version !== null ? `  v${version}` : ''}`]
  if (description !== null) lines.push(description)
  lines.push('')
  lines.push(`Package: ${pkgDir}`)
  if (main !== null) lines.push(`Main: ${main}`)

  if (typesLocation !== null) {
    lines.push(`Types: ${typesLocation.path}  (${typesLocation.source})`)
    if (!typescriptAvailable) lines.push('  (declaration outline not extracted: typescript compiler API not installed)')
  } else if (!typescriptAvailable) {
    lines.push('Types: not extracted (typescript compiler API not installed)')
  } else {
    lines.push('Types: none found (no bundled .d.ts, no companion @types package)')
  }

  if (declarations !== null) {
    lines.push('')
    lines.push(`## Type declarations (${declarations.length})`)
    for (const d of declarations) {
      lines.push(`  ${d.line.toString().padStart(6)}  ${d.kind.padEnd(10)}  ${d.name}  ${d.signature}`)
    }
  }

  lines.push('')
  if (readmeFile !== null) {
    lines.push(`## README (${readmeFile})`)
    lines.push('')
    lines.push(readmeRaw)
  } else {
    lines.push('## README')
    lines.push('(none found)')
  }

  const text = guardText(lines.join('\n'))
  recordDepDocsStat(fullSourceBytes, text, opts.packageName)
  return { text, code: 0 }
}
