/**
 * Extracts symbols from Caddyfile configurations (global options, snippets, site blocks, directives).
 */

import type { SymbolEntry } from '../parser_types.js'

interface CaddyBlock {
  readonly name: string
  readonly kind: string
  readonly lineStart: number
}

function symbol(filePath: string, lines: readonly string[], block: CaddyBlock, lineEnd: number): SymbolEntry {
  return {
    filePath,
    name: block.name,
    kind: block.kind,
    lineStart: block.lineStart,
    lineEnd,
    body: lines.slice(block.lineStart - 1, lineEnd).join('\n'),
    docstring: '',
    parent: '',
  }
}

export function extractCaddy(content: string, filePath: string): SymbolEntry[] {
  const lines = content.split('\n')
  const symbols: SymbolEntry[] = []
  const stack: Array<CaddyBlock & { readonly site: boolean }> = []
  let braceDepth = 0
  let sawContent = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const commentIndex = rawLine.indexOf('#')
    const codeLine = commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine
    const trimmed = codeLine.trim()
    const firstOpen = codeLine.indexOf('{')
    if (firstOpen >= 0) {
      const header = codeLine.slice(0, firstOpen).trim()
      if (braceDepth === 0 && !sawContent && header === '') {
        stack.push({ name: 'global', kind: 'caddy_global', lineStart: i + 1, site: false })
      } else if (braceDepth === 0 && header) {
        const snippet = /^\(([^)]+)\)$/.exec(header)
        stack.push({
          name: snippet ? `(${snippet[1]})` : header,
          kind: snippet ? 'caddy_snippet' : 'caddy_site',
          lineStart: i + 1,
          site: !snippet,
        })
      } else if (header && /^(?:route|handle|handle_path)\b/.test(header) && stack.some((block) => block.site)) {
        stack.push({ name: header, kind: 'caddy_block', lineStart: i + 1, site: false })
      } else {
        stack.push({ name: '', kind: '', lineStart: i + 1, site: false })
      }
    }
    if (trimmed) sawContent = true

    for (const char of codeLine) {
      if (char === '{') {
        braceDepth++
      } else if (char === '}') {
        braceDepth--
        const block = stack[stack.length - 1]
        if (block && block.kind && braceDepth >= 0) {
          stack.pop()
          symbols.push(symbol(filePath, lines, block, i + 1))
        } else if (block) {
          stack.pop()
        }
      }
    }
  }

  return symbols.sort((a, b) => a.lineStart - b.lineStart)
}
