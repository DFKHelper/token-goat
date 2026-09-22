/**
 * Nginx configuration language extractor and symbol parser.
 */

import {
  type SymbolEntry,
} from '../parser_types.js';

interface BlockStart {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly openBraceDepth: number;
}

// The argument group is optional. `http`, `events`, `stream` and the canonical `server` take no inline argument, so requiring one left every one of them unmatched: a stock nginx.conf indexed its `upstream` and `location` blocks and nothing else, and the server_name/listen labelling below was unreachable because it needs a `server` block to label.
const NGINX_BLOCK_START_RE = /^(?:([a-zA-Z0-9_]+)[ \t]+)?(http|events|stream|server|upstream|location)(?:[ \t]+([^{;\s](?:[^{};]*[^{};\s])?))?[ \t]*\{/;
const SERVER_NAME_RE = /^\s*server_name[ \t]+([^\s;][^;]*);/;
const LISTEN_RE = /^\s*listen[ \t]+([^\s;][^;]*);/;

/**
 * Extracts symbols from Nginx configuration files.
 * Handles top-level blocks (http, events, stream), upstreams, servers (labeled
 * with server_name or port if present), and locations.
 */
export function extractNginx(content: string, filePath: string): SymbolEntry[] {
  const lines = content.split('\n');
  const symbols: SymbolEntry[] = [];

  let braceDepth = 0;
  const blockStack: BlockStart[] = [];

  // Pass 1: Parse block hierarchy and identify block lines
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    // Strip trailing or inline comments for brace tracking
    const commentIdx = rawLine.indexOf('#');
    const lineWithoutComment = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = lineWithoutComment.trim();

    if (!trimmed) {
      continue;
    }

    // Check if a block starts on this line
    const match = NGINX_BLOCK_START_RE.exec(trimmed);
    if (match) {
      const keyword = match[2] ?? '';
      const arg = match[3]?.trim() ?? '';
      let symbolName = keyword;
      const symbolKind = `nginx_${keyword}`;

      if (keyword === 'upstream' && arg) {
        symbolName = `upstream ${arg}`;
      } else if (keyword === 'location' && arg) {
        symbolName = `location ${arg}`;
      } else if (keyword === 'server') {
        // Look ahead within the server block for server_name or listen
        let label = '';
        let lookaheadBraces = 0;
        for (let j = i; j < Math.min(i + 40, lines.length); j++) {
          const lRaw = lines[j] ?? '';
          const lClean = (lRaw.indexOf('#') >= 0 ? lRaw.slice(0, lRaw.indexOf('#')) : lRaw).trim();
          for (const char of lClean) {
            if (char === '{') lookaheadBraces++;
            if (char === '}') lookaheadBraces--;
          }
          if (lookaheadBraces === 1) {
            const snMatch = SERVER_NAME_RE.exec(lRaw);
            if (snMatch && snMatch[1]) {
              const first = snMatch[1].trim().split(/\s+/)[0];
              if (first) {
                label = first;
                break;
              }
            }
            if (!label) {
              const listenMatch = LISTEN_RE.exec(lRaw);
              if (listenMatch && listenMatch[1]) {
                label = listenMatch[1].trim();
              }
            }
          }
          if (lookaheadBraces <= 0 && j > i) break;
        }
        symbolName = label ? `server (${label})` : 'server';
      }

      blockStack.push({
        name: symbolName,
        kind: symbolKind,
        line: i + 1,
        openBraceDepth: braceDepth,
      });
    }

    // Count braces on this line
    for (const char of lineWithoutComment) {
      if (char === '{') {
        braceDepth++;
      } else if (char === '}') {
        braceDepth--;
        // Check if any block ended at this brace depth
        if (blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top && braceDepth === top.openBraceDepth) {
            blockStack.pop();
            const symbol: SymbolEntry = {
              filePath,
              name: top.name,
              kind: top.kind,
              lineStart: top.line,
              lineEnd: i + 1,
              body: lines.slice(top.line - 1, i + 1).join('\n'),
              docstring: '',
              parent: '',
            };
            symbols.push(symbol);
          }
        }
      }
    }
  }

  // Sort symbols by lineStart ascending
  symbols.sort((a, b) => a.lineStart - b.lineStart);
  return symbols;
}
