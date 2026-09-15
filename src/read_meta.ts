import * as fs from 'node:fs'
import * as path from 'node:path'

import { isTreeSitterAvailable } from './parser.js'
import {
  detectLanguageOfFile,
  TREE_SITTER_LANGUAGES,
  unsupportedLanguageName,
} from './parser_types.js'
import { countNoun } from './util.js'
import { supportRequestLine } from './version.js'

const PARENT_IDENTIFIER_RE = /^[\w$]+$/

export function symbolExtractorGap(displayPath: string, resolvedPath: string): string | undefined {
  const ext = path.extname(resolvedPath).toLowerCase()
  const named = unsupportedLanguageName(resolvedPath)
  const language = detectLanguageOfFile(resolvedPath)
  if (named !== undefined || language === 'unknown') {
    const what = named !== undefined ? `${named}, ${ext}` : ext !== '' ? ext : 'no extension'
    return (
      `'${displayPath}': token-goat has no symbol extractor for this file type (${what}), so there are no symbols to list; grep, plain reads and \`token-goat tokens\` still work on it.\n` +
      supportRequestLine(named ?? (ext !== '' ? `${ext} file` : 'this file type'))
    )
  }
  if (TREE_SITTER_LANGUAGES.includes(language) && !isTreeSitterAvailable(language)) {
    return `No symbols found in '${displayPath}', but tree-sitter parsing for this file type (${ext}) is unavailable, so only a coarse regex fallback ran. Run \`token-goat doctor\` for the cause and the fix.`
  }
  return undefined
}

export function noSymbolsMessage(displayPath: string, resolvedPath: string): string {
  if (!fs.existsSync(resolvedPath)) {
    return `Could not read: ${displayPath}`
  }
  return symbolExtractorGap(displayPath, resolvedPath) ?? `No indexed symbols found in '${displayPath}'`
}

export function hasRealDocstring(docstring: string): boolean {
  const doc = docstring.trim()
  return doc !== '' && !PARENT_IDENTIFIER_RE.test(doc)
}

export function formatStatsSuffix(refCounts: Map<string, number> | undefined, sym: { name: string; docstring: string }): string {
  return refCounts !== undefined
    ? `  [${countNoun(refCounts.get(sym.name) ?? 0, 'ref')}, ${hasRealDocstring(sym.docstring) ? 'documented' : 'undocumented'}]`
    : ''
}

export function previewLines(body: string, n: number): string {
  return body.split(/\r?\n/).slice(0, n).join('\n')
}
