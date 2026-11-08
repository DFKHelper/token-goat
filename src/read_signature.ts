import * as path from 'node:path'
import { bodyFromDeclaration, firstBodyLine } from './read_suggest.js'
import {
  extractTsSignatureInfos,
  extractTsTypeDefinitions,
  extractTsTypeImports,
} from './parser_treesitter.js'
import type { TsNode, TsTypeDefinition, TsTypeImportBinding } from './parser_ts_types.js'

export interface SignatureTypeContextSource {
  readonly filePath: string
  readonly root: TsNode
}

interface ParsedTypeContextSource {
  readonly filePath: string
  readonly key: string
  readonly root: TsNode
  readonly definitions: readonly TsTypeDefinition[]
  readonly imports: readonly TsTypeImportBinding[]
}

interface ResolvedTypeDefinition {
  readonly definition: TsTypeDefinition
  readonly alias?: string
}

function typeContextPathKey(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/')
}

function importedFileKey(
  importerPath: string,
  moduleSpecifier: string,
  availableFiles: ReadonlySet<string>,
): string | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined

  const base = path.resolve(path.dirname(importerPath), moduleSpecifier)
  const extension = path.extname(base).toLowerCase()
  const candidates = [base]
  if (extension === '') {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.d.ts`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
      path.join(base, 'index.mts'),
      path.join(base, 'index.cts'),
    )
  } else if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const stem = base.slice(0, -extension.length)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.d.ts`)
  }
  return candidates.map(typeContextPathKey).find((candidate) => availableFiles.has(candidate))
}

function typeDefinitionKey(definition: TsTypeDefinition): string {
  return `${typeContextPathKey(definition.filePath)}\0${definition.name}\0${definition.kind}\0${definition.source}`
}

function resolveTypeReference(
  name: string,
  source: ParsedTypeContextSource,
  sources: readonly ParsedTypeContextSource[],
  sourcesByKey: ReadonlyMap<string, ParsedTypeContextSource>,
  availableFileKeys: ReadonlySet<string>,
): ResolvedTypeDefinition[] {
  const local = source.definitions.filter((definition) => definition.name === name)
  if (local.length > 0) return local.map((definition) => ({ definition }))

  const separator = name.indexOf('.')
  const localName = separator < 0 ? name : name.slice(0, separator)
  const binding = source.imports.find((candidate) => candidate.localName === localName)
  if (binding !== undefined) {
    const moduleKey = importedFileKey(
      source.filePath,
      binding.moduleSpecifier,
      availableFileKeys,
    )
    const importedSource = moduleKey === undefined ? undefined : sourcesByKey.get(moduleKey)
    if (importedSource !== undefined) {
      const importedName = binding.namespace ? name.slice(separator + 1) : binding.importedName
      const definitions = importedSource.definitions.filter((definition) => {
        return binding.importedName === 'default'
          ? definition.defaultExport
          : definition.exported && definition.name === importedName
      })
      if (definitions.length > 0) {
        return definitions.map((definition) => ({
          definition,
          ...(!binding.namespace && binding.localName !== definition.name ? { alias: binding.localName } : {}),
        }))
      }
    }
  }

  const exported = sources.flatMap((candidate) =>
    candidate.definitions
      .filter((definition) => definition.name === name && definition.exported)
      .map((definition) => ({ source: candidate, definition })),
  )
  const sourceKeys = new Set(exported.map((candidate) => candidate.source.key))
  if (sourceKeys.size !== 1) return []
  return exported.map(({ definition }) => ({ definition }))
}

function resolveTypeDefinitions(
  references: readonly string[],
  source: ParsedTypeContextSource,
  sources: readonly ParsedTypeContextSource[],
  sourcesByKey: ReadonlyMap<string, ParsedTypeContextSource>,
  availableFileKeys: ReadonlySet<string>,
): { definitions: TsTypeDefinition[]; aliases: Map<string, TsTypeDefinition> } {
  const definitions: TsTypeDefinition[] = []
  const aliases = new Map<string, TsTypeDefinition>()
  const visited = new Set<string>()
  const pending = references.map((name) => ({ name, source }))

  while (pending.length > 0) {
    const current = pending.shift()
    if (current === undefined) break
    for (const resolved of resolveTypeReference(
      current.name,
      current.source,
      sources,
      sourcesByKey,
      availableFileKeys,
    )) {
      const definition = resolved.definition
      if (resolved.alias !== undefined && !aliases.has(resolved.alias)) {
        aliases.set(resolved.alias, definition)
      }
      const key = typeDefinitionKey(definition)
      if (visited.has(key)) continue
      visited.add(key)
      definitions.push(definition)
      const definitionSource = sourcesByKey.get(typeContextPathKey(definition.filePath))
      if (definitionSource !== undefined) {
        for (const reference of definition.references) {
          pending.push({ name: reference, source: definitionSource })
        }
      }
    }
  }
  return { definitions, aliases }
}

function renderTypeAlias(alias: string, definition: TsTypeDefinition): string {
  const argumentsList =
    definition.typeParameterNames.length === 0 ? '' : `<${definition.typeParameterNames.join(', ')}>`
  return `type ${alias}${definition.typeParameters} = ${definition.name}${argumentsList}`
}

/**
 * Return the signature(s) and transitively referenced TS type declarations for a symbol or file.
 * The supplied roots may include imported files; only reachable declarations are appended for a symbol.
 */
export function extractSignatureWithTypeContext(
  sourceFiles: readonly SignatureTypeContextSource[],
  targetFilePath: string,
  symbolName?: string,
): string {
  const sourcesByKey = new Map<string, ParsedTypeContextSource>()
  for (const file of sourceFiles) {
    const key = typeContextPathKey(file.filePath)
    if (sourcesByKey.has(key)) continue
    sourcesByKey.set(key, {
      filePath: file.filePath,
      key,
      root: file.root,
      definitions: extractTsTypeDefinitions(file.root, file.filePath),
      imports: extractTsTypeImports(file.root, file.filePath),
    })
  }

  const target = sourcesByKey.get(typeContextPathKey(targetFilePath))
  if (target === undefined) return ''

  const signatures = extractTsSignatureInfos(target.root, symbolName)
  if (symbolName !== undefined && signatures.length === 0) return ''

  const references =
    symbolName === undefined
      ? [...signatures.flatMap((signature) => signature.references), ...target.definitions.map((definition) => definition.name)]
      : signatures.flatMap((signature) => signature.references)
  const parsedSources = [...sourcesByKey.values()]
  const resolved = resolveTypeDefinitions(
    references,
    target,
    parsedSources,
    sourcesByKey,
    new Set(sourcesByKey.keys()),
  )
  const signatureLines = [...new Set(
    signatures.map((signature) => signature.signature.trim()).filter(Boolean),
  )]
  const typeLines = resolved.definitions.map((definition) => definition.source.trim()).filter(Boolean)
  const aliasLines = [...resolved.aliases].map(([alias, definition]) => renderTypeAlias(alias, definition))
  return [...signatureLines, ...typeLines, ...aliasLines].join('\n\n')
}

function cobolCodeLines(body: string): string[] {
  return body.split(/\r?\n/).map((raw) => {
    let line = raw
    if (/^[ 0-9]{6}[ */Dd-]/.test(line)) {
      const indicator = line[6]
      if (indicator === '*' || indicator === '/' || indicator === 'D' || indicator === 'd') return ''
      line = line.slice(7, 72)
    }
    let quote = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (quote !== '') {
        if (ch === quote) {
          if (line[i + 1] === quote) i++
          else quote = ''
        }
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '*' && line[i + 1] === '>') return line.slice(0, i).trim()
    }
    return line.trim()
  }).filter((line) => line !== '')
}

function cobolPeriodIndex(text: string): number {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) {
        if (text[i + 1] === quote) i++
        else quote = ''
      }
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '.' && !(i > 0 && /\d/.test(text[i - 1]!) && /\d/.test(text[i + 1] ?? ''))) return i
  }
  return -1
}

function cobolSignature(body: string, kind?: string): string | undefined {
  const lines = cobolCodeLines(body)
  const first = lines[0]
  if (first === undefined) return undefined
  if (kind === 'section') return /^([A-Za-z0-9][A-Za-z0-9-]*\s+SECTION\s*\.)/i.exec(first)?.[1]?.trim()
  if (kind === 'paragraph') return /^([A-Za-z0-9][A-Za-z0-9-]*\s*\.)/.exec(first)?.[1]?.trim()
  if (kind !== 'variable' || !/^01\b/i.test(first)) return undefined
  let declaration = ''
  for (const line of lines) {
    declaration = declaration === '' ? line : `${declaration} ${line}`
    const period = cobolPeriodIndex(declaration)
    if (period >= 0) return declaration.slice(0, period + 1).trim()
  }
  return declaration
}

/**
 * Extracts a compact declaration signature from a symbol's body.
 * Skips implementation blocks { ... }, Python suites, or multiline method bodies,
 * returning the declaration header up to the opening brace, colon, or semicolon.
 */
export function extractSignature(body: string, kind?: string, filePath?: string): string {
  // Java annotations are part of the declaration signature; other languages keep the decorator-stripping behavior.
  const preserveJavaAnnotations = filePath?.toLowerCase().endsWith('.java') === true
  const cleanBody = (preserveJavaAnnotations ? body : bodyFromDeclaration(body)).trim()
  if (cleanBody === '') return ''
  const cobol = cobolSignature(cleanBody, kind)
  if (cobol !== undefined) return cobol

  // Look for implementation block open `{` or `:` that is outside of parentheses `()` or angle brackets `<>`
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let inString: string | null = null

  for (let i = 0; i < cleanBody.length; i++) {
    const ch = cleanBody[i]

    if (inString !== null) {
      if (ch === '\\') {
        i++
      } else if (ch === inString) {
        inString = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }

    if (ch === '(') {
      parenDepth++
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (ch === '[') {
      bracketDepth++
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (ch === '{') {
      if (parenDepth === 0 && bracketDepth === 0) {
        // This is the start of the function/class body!
        const sig = cleanBody.slice(0, i).trimEnd()
        if (sig.length > 0) return sig
      }
      braceDepth++
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (ch === ':') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        // Check if this is a Python suite opener: "def ...:", "async def ...:", "class ...:"
        const prefix = cleanBody.slice(0, i + 1).trim()
        if (/^(?:async\s+def|def|class)\b/.test(prefix)) {
          return prefix
        }
      }
    }
  }

  // Fallback to firstBodyLine if no opening block was found (e.g. interfaces, type aliases)
  return firstBodyLine(cleanBody)
}
