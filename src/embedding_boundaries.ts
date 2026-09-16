import type { ChunkBoundary } from './embeddings.js'
import { detectLanguage } from './parser_types.js'
import { querySymbols } from './index_reader.js'
import { extractMarkdownHeadings } from './hints/markdown_hints.js'

/** Structural cut points for this file's embedding chunks, derived from the same indexing pass rather than re-parsed from scratch: markdown/doc files get one 'section' boundary per heading (extractMarkdownHeadings - cheap here since the caller already holds the full content in memory); every other language gets one 'symbol' boundary per row already committed to the `symbols` table moments earlier by indexFileSync in the same cli.ts/worker.ts call sequence. Empty when the file has no symbols/headings (unparsed language, plain text, or a file with genuinely nothing extractable) - chunkFile's own `boundaries.length === 0` check falls back to its plain sliding window in that case, so this never needs to signal "no boundaries" any differently than an empty array. Kept in its own module, separate from parser.ts, so PARSER_FINGERPRINT (which invalidates files.parser_sha) and EMBED_FINGERPRINT (which invalidates files.embed_sha, see scripts/parser-fingerprint.mjs) can each hash exactly the sources that decide their own freshness key without one dragging the other's unrelated edits into a reparse or re-embed. */
export function buildEmbeddingBoundaries(filePath: string, content: string, dbPath: string): ChunkBoundary[] {
  if (detectLanguage(filePath) === 'markdown') {
    // Extract all headings (no cap) for embedding boundaries so sections remain heading-aligned
    // even for docs with >40 headings (large API references, changelogs, multi-section docs).
    const headings = extractMarkdownHeadings(content, Infinity)
    return headings.map((h, i) => ({
      start: h.lineNumber,
      // Runs to just before the next heading, or to end-of-file for the last one. chunkFile clips end values to the file's actual line count, so this sentinel is safe without re-deriving the file's line count here.
      end: headings[i + 1] !== undefined ? headings[i + 1]!.lineNumber - 1 : Number.MAX_SAFE_INTEGER,
      kind: 'section' as const,
    }))
  }

  // No cap here either, matching the markdown branch above: this query is already scoped to one file_path, so its row count is bounded by that file's own symbol count (already paid for by indexFileSync's parse moments earlier), not by anything this call adds. A fixed cap here previously silently dropped every symbol past the file's 10,000th (ordered by line_start, so a contiguous tail) from getting its own chunk boundary - chunkFile's trailing-gap fallback still folded that tail into one generic 'window' chunk rather than losing its content outright, but it lost symbol-precise chunking for large generated files (API clients, protobuf/OpenAPI output, big constants/fixtures files) with no documented reason for the number or the asymmetry with the uncapped markdown branch.
  const symbols = querySymbols({ filePath, limit: Number.MAX_SAFE_INTEGER }, dbPath)
  return symbols.map((s) => ({ start: s.lineStart, end: s.lineEnd, kind: 'symbol' as const }))
}
