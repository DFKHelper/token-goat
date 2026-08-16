/**
 * Type-resolved reference disambiguation for TypeScript, using the TypeScript compiler API.
 *
 * `read_commands.ts::runRefs` matches references by identifier NAME alone (the `refs` table has
 * no def-site linkage — see `db.ts`'s `refs` schema), so two unrelated symbols sharing a name
 * (two different classes each with a `run()` method) get conflated: a caller of one is reported
 * as a reference to the other. This module adds an opt-in "exact" tier for `.ts`/`.tsx`/`.mts`/
 * `.cts` symbols: given the symbol's definition site and its name-matched candidate references,
 * it uses `ts.Program` + the type checker's `getSymbolAtLocation` to resolve each candidate's
 * actual bound symbol and keeps only the ones whose declaration falls inside the definition's
 * own [lineStart, lineEnd] span.
 *
 * Lazily `require`s `typescript` (mirrors {@link ./embeddings.ts}'s `ensureTransformerLoaded`
 * pattern for `@xenova/transformers`) so a missing/broken install degrades to `null` instead of
 * throwing, and `typescript` never gets bundled into `dist/token-goat.mjs` (see
 * `esbuild.config.mjs`'s `EXTERNAL_NATIVE_DEPS` -- `typescript` is listed there for the same
 * "optional dependency must not get statically inlined" reason as `@xenova/transformers`).
 *
 * Scoping / performance: building a `ts.Program` for a whole project is the exact cost this
 * product exists to avoid paying on every `refs` call. Instead of the project's full tsconfig
 * `include` set, the program's `rootNames` are just the definition file plus the (deduped) set of
 * candidate reference files -- TypeScript still resolves each root's own `import` graph (that is
 * unavoidable: correctly resolving `foo.run()` requires knowing `foo`'s type, which requires
 * loading whatever module declares it), but never touches files outside that reachable closure.
 * On this repo's own ~600-file tree a single-symbol `refs` call with a handful of candidate files
 * type-checks in well under a second (see `tests/ts_refs.test.ts`'s perf-sanity case). As a
 * second guard against a pathologically interconnected project, {@link MAX_CANDIDATE_FILES} caps
 * how many distinct candidate files this tier will attempt before silently falling back to the
 * existing name-based results.
 */

import { createRequire } from 'node:module'
import * as path from 'node:path'
import type TsModule from 'typescript'
import type { RefEntry } from './parser_types.js'
import { registerReset } from './reset.js'

const _require = createRequire(import.meta.url)

// Above this many distinct candidate files, program construction cost is no longer bounded by
// "a handful of files near the definition" -- skip the tier and fall back to name-based results
// rather than risk `refs` becoming slow on a large, densely-interconnected project.
const MAX_CANDIDATE_FILES = 50

let _ts: typeof TsModule | null = null
let _tsError: Error | null = null
let _tsLoadAttempted = false
// `undefined` = no override (use the real lazy-loaded module); `null` or a module = forced value.
// Lets tests exercise the "typescript is unavailable" fallback path deterministically without
// needing to actually uninstall the package.
let _tsOverride: typeof TsModule | null | undefined = undefined

function loadTs(): typeof TsModule | null {
  if (_tsOverride !== undefined) return _tsOverride
  if (!_tsLoadAttempted) {
    _tsLoadAttempted = true
    try {
      _ts = _require('typescript') as typeof TsModule
    } catch (e) {
      _tsError = e instanceof Error ? e : new Error(String(e))
    }
  }
  return _ts
}

/** True when the `typescript` compiler API is loadable (installed and requires cleanly). */
export function isAvailable(): boolean {
  return loadTs() !== null
}

/** Last load error, for diagnostics (`token-goat doctor` style callers). Null when never attempted or loaded successfully. */
export function loadError(): Error | null {
  return _tsError
}

/** Test-only: force `isAvailable()`/internal resolution to use `mod` (or `null` to simulate "not installed") instead of the real lazily-`require`d module. Pass `undefined` to clear the override. */
export function setTsModuleForTesting(mod: typeof TsModule | null | undefined): void {
  _tsOverride = mod
}

registerReset(() => {
  _tsOverride = undefined
})

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** True when `filePath`'s extension is a TypeScript source extension (`.ts`/`.tsx`/`.mts`/`.cts`). */
export function isTsPath(filePath: string): boolean {
  return TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export interface ResolveTypedRefsInput {
  /** Absolute (index-normalized) path of the file that DEFINES the symbol. */
  defFile: string
  /** 1-based start line of the definition's span (`SymbolEntry.lineStart`). */
  defLineStart: number
  /** 1-based end line of the definition's span (`SymbolEntry.lineEnd`). */
  defLineEnd: number
  /** The symbol's name, used only as a sanity check that a resolved node's text matches. */
  symbolName: string
  /** Name-matched candidate references to disambiguate (from `queryRefs`). */
  candidates: readonly RefEntry[]
}

/**
 * Filter `input.candidates` down to the ones whose TypeScript-resolved binding actually points at
 * the definition described by `input.defFile`/`defLineStart`/`defLineEnd`.
 *
 * Returns `null` (never throws) when the tier cannot be applied at all -- `typescript` isn't
 * available, the definition isn't a TS file, there are too many distinct candidate files
 * ({@link MAX_CANDIDATE_FILES}), the program can't be built, or the definition's own declaration
 * can't be located in it -- so callers should treat `null` as "fall back to the name-based
 * `candidates` list unchanged", not as "zero references found".
 *
 * A candidate whose own position can't be resolved to an identifier (e.g. tree-sitter/TS parse
 * drift, or a non-TS/JS candidate file) is kept rather than dropped: this tier only ever narrows
 * results by proven type mismatch, never by uncertainty, so a resolution gap degrades toward the
 * old name-based behavior for that one row instead of silently losing a real reference.
 */
export function resolveTypedRefs(input: ResolveTypedRefsInput): RefEntry[] | null {
  const ts = loadTs()
  if (ts === null) return null
  if (!isTsPath(input.defFile)) return null

  const candidateFiles = new Set<string>()
  for (const c of input.candidates) candidateFiles.add(c.filePath)
  if (candidateFiles.size > MAX_CANDIDATE_FILES) return null

  const rootNames = Array.from(new Set([input.defFile, ...candidateFiles]))

  let program: TsModule.Program
  try {
    program = buildScopedProgram(ts, rootNames, input.defFile)
  } catch {
    return null
  }

  const checker = program.getTypeChecker()
  const defSourceFile = program.getSourceFile(input.defFile)
  if (defSourceFile === undefined) return null

  const defSymbol = findDeclarationSymbolInRange(
    ts,
    checker,
    defSourceFile,
    input.symbolName,
    input.defLineStart,
    input.defLineEnd,
  )
  if (defSymbol === null) return null

  const out: RefEntry[] = []
  for (const ref of input.candidates) {
    if (!TS_JS_EXTENSIONS.has(path.extname(ref.filePath).toLowerCase())) {
      out.push(ref)
      continue
    }
    const sourceFile = program.getSourceFile(ref.filePath)
    if (sourceFile === undefined) {
      out.push(ref)
      continue
    }
    const matches = refMatchesDefinition(ts, checker, sourceFile, ref, input.symbolName, defSymbol)
    if (matches === null || matches) out.push(ref)
  }
  return out
}

/**
 * Builds a `ts.Program` rooted at exactly `rootNames` (the definition file plus its name-matched
 * candidate reference files), using the nearest `tsconfig.json` above `defFile` for compiler
 * options (module resolution, path aliases, `jsx`, etc.) if one exists, falling back to a
 * permissive default set otherwise. `fileNames`/`include` from that tsconfig are intentionally
 * NOT used as the root set -- only its `options` -- so this never balloons into a whole-project
 * program; TypeScript still follows `rootNames`' own `import`/`require` graph as needed to type
 * them, which is unavoidable for correct resolution (see module doc).
 */
function buildScopedProgram(
  ts: typeof TsModule,
  rootNames: readonly string[],
  searchFrom: string,
): TsModule.Program {
  const options: TsModule.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    esModuleInterop: true,
  }

  const configPath = ts.findConfigFile(path.dirname(searchFrom), ts.sys.fileExists, 'tsconfig.json')
  if (configPath !== undefined) {
    try {
      const raw = ts.readConfigFile(configPath, ts.sys.readFile)
      if (raw.error === undefined) {
        const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath))
        Object.assign(options, parsed.options)
      }
    } catch {
      // Malformed/unreadable tsconfig.json -- keep the permissive defaults above rather than fail
      // the whole tier over an unrelated config problem.
    }
  }
  // noEmit must stay true regardless of what the project's own tsconfig says -- this program is
  // only ever used for type resolution, never for emitting output.
  options.noEmit = true

  // Parsing every JSDoc comment in every file the program pulls in is pure waste here: this tier
  // only ever asks the checker whether two identifiers resolve to the same declaration, and never
  // reads a doc comment or reports a diagnostic. Skipping it in .ts files takes program
  // construction from ~700ms to ~600ms on this repo, with the same 626 files loaded.
  // ParseForTypeErrors rather than ParseNone so JSDoc in plain .js files, where it is the only
  // place a type can be declared, is still parsed. The enum arrived in TypeScript 5.3 and
  // typescript is an optional dependency, so an older install just keeps the default host.
  const jsDocParsingMode = ts.JSDocParsingMode?.ParseForTypeErrors
  if (jsDocParsingMode === undefined) {
    return ts.createProgram({ rootNames: [...rootNames], options })
  }
  const host = ts.createCompilerHost(options)
  host.jsDocParsingMode = jsDocParsingMode
  return ts.createProgram({ rootNames: [...rootNames], options, host })
}

/**
 * Finds the symbol bound to the declaration name inside `sourceFile` whose own line falls within
 * `[lineStart, lineEnd]` (1-based, inclusive) and whose identifier text is `name`. Returns `null`
 * if no such declaration identifier is found.
 */
function findDeclarationSymbolInRange(
  ts: typeof TsModule,
  checker: TsModule.TypeChecker,
  sourceFile: TsModule.SourceFile,
  name: string,
  lineStart: number,
  lineEnd: number,
): TsModule.Symbol | null {
  let found: TsModule.Symbol | null = null

  const visit = (node: TsModule.Node): void => {
    if (found !== null) return
    if (ts.isIdentifier(node) && node.text === name) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      if (line >= lineStart && line <= lineEnd && isDeclarationName(ts, node)) {
        const symbol = checker.getSymbolAtLocation(node)
        if (symbol !== undefined) {
          found = symbol
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** True when `node` is the NAME identifier of a declaration (not a reference/use of it). */
function isDeclarationName(ts: typeof TsModule, node: TsModule.Identifier): boolean {
  const parent = node.parent as TsModule.Node | undefined
  if (parent === undefined) return false
  if (
    (ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return true
  }
  return false
}

/**
 * Resolves the identifier matching `ref` inside `sourceFile` and returns whether its bound symbol's
 * declaration(s) include `defSymbol`. Returns `null` (rather than `false`) when the position can't
 * be resolved to a matching identifier at all, so the caller treats it as "uncertain, keep the
 * candidate" instead of "proven mismatch, drop it".
 */
function refMatchesDefinition(
  ts: typeof TsModule,
  checker: TsModule.TypeChecker,
  sourceFile: TsModule.SourceFile,
  ref: RefEntry,
  symbolName: string,
  defSymbol: TsModule.Symbol,
): boolean | null {
  const line0 = ref.line - 1
  if (line0 < 0 || line0 >= sourceFile.getLineStarts().length) return null
  let position: number
  try {
    position = sourceFile.getPositionOfLineAndCharacter(line0, ref.col)
  } catch {
    return null
  }

  const node = findIdentifierNearPosition(ts, sourceFile, line0, position, symbolName)
  if (node === null) return null

  let symbol = checker.getSymbolAtLocation(node)
  if (symbol === undefined) return null
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol)
    } catch {
      // Unresolvable alias (e.g. ambient/global) -- fall through and compare the alias symbol
      // itself, which will simply fail to match rather than throw.
    }
  }
  if (symbol === defSymbol) return true

  const declarations = symbol.getDeclarations() ?? []
  const defDeclarations = defSymbol.getDeclarations() ?? []
  for (const d of declarations) {
    for (const dd of defDeclarations) {
      if (d === dd) return true
    }
  }
  return false
}

/**
 * Finds the identifier matching `name` closest to (at or after) `position` on source line
 * `line0` (0-based).
 *
 * `refs`' recorded (line, col) is the START of the enclosing expression the extractor matched
 * (e.g. for `foo.run()` it is `foo`'s column, not `run`'s -- see `extractRefs`/`calleeName` in
 * `parser.ts`, whose `record(name, node)` passes the whole call-expression node, not the callee
 * identifier), so this can't require the position to land exactly inside the target identifier's
 * span. Instead it scans every identifier on that line and picks the leftmost one whose text
 * matches `name` and whose start is at or after `position` -- correct as long as `extractRefs`'s
 * own per-(name, line) dedup holds (it does: see the `seen` set in `extractRefs`), since then
 * there is at most one real occurrence of `name` at/after the recorded column on that line.
 */
function findIdentifierNearPosition(
  ts: typeof TsModule,
  sourceFile: TsModule.SourceFile,
  line0: number,
  position: number,
  name: string,
): TsModule.Identifier | null {
  const lineStarts = sourceFile.getLineStarts()
  const lineStart = lineStarts[line0]
  const lineEnd = line0 + 1 < lineStarts.length ? (lineStarts[line0 + 1] as number) : sourceFile.text.length
  if (lineStart === undefined) return null

  let best: TsModule.Identifier | null = null
  const visit = (node: TsModule.Node): void => {
    const start = node.getStart(sourceFile)
    if (node.getEnd() < lineStart || start >= lineEnd) return
    if (ts.isIdentifier(node) && node.text === name && start >= position) {
      if (best === null || start < best.getStart(sourceFile)) best = node
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return best
}
