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
    // One stack entry per '{', classified from the line only for the first one. Classifying once per LINE while popping once per '}' desynced the stack on any line carrying more than one brace pair, which in a Caddyfile means any line using a placeholder: `redir https://{host}{uri}` pushed one entry and popped two, closing the enclosing site block on that line and dropping every block nested below it.
    const depthAtLineStart = braceDepth
    const contentBeforeLine = sawContent
    let opensSeen = 0

    for (let c = 0; c < codeLine.length; c++) {
      const char = codeLine[c]
      if (char === '{') {
        const header = opensSeen === 0 ? codeLine.slice(0, c).trim() : ''
        if (opensSeen === 0 && depthAtLineStart === 0 && !contentBeforeLine && header === '') {
          stack.push({ name: 'global', kind: 'caddy_global', lineStart: i + 1, site: false })
        } else if (opensSeen === 0 && depthAtLineStart === 0 && header) {
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
        opensSeen++
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
    if (trimmed) sawContent = true
  }

  return symbols.sort((a, b) => a.lineStart - b.lineStart)
}
