import { isCaseInsensitiveFs } from './util.js'

// Build a `<column> = ?` SQL comparison that folds case on case-insensitive filesystems (Windows/macOS), so a path stored under one casing still matches a query or delete under another. Single source for this clause across parser, embeddings, and index_reader.
export function pathEqClause(column: string): string {
  return isCaseInsensitiveFs() ? `${column} = ? COLLATE NOCASE` : `${column} = ?`
}
