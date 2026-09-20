/**
 * Resolves which extraction kind a file's embedding stamp belongs to, and which digest from `embed_fingerprint.ts` that kind carries.
 *
 * A module of its own rather than a function in `embeddings.ts` or `doc_embed_extract.ts` for the same reason `parser_stamp.ts` is not in `parser_types.ts`: both of those files are hashed into EMBED_FINGERPRINT, so a change to a stamp lookup there would move the digest and re-embed every already-embedded file on the machine -- the expensive half of indexing, for a map lookup that decides nothing about chunk text. Nothing here is hashed into either digest.
 */

import * as path from 'node:path'

import { EMBED_FINGERPRINT, EMBED_KIND_FINGERPRINTS } from './embed_fingerprint.js'
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { detectLanguage } from './parser_types.js'

/**
 * The extraction kind whose sources alone decide this file's chunk text, or null for a file only the global sources reach.
 *
 * Resolved from the path exactly the way the two dispatchers it mirrors resolve it, rather than from the `files.language` column: `extractEmbeddableDocumentText` switches on the extension, and `buildEmbeddingBoundaries` takes its markdown branch on `detectLanguage(filePath) === 'markdown'`, which is path-only and can disagree with the stored language (content refinement moves that verdict, and every binary document is stored as `unknown` -- measured on one real index, all 29 PDF and all 16 xlsx rows carry language `unknown`, so scoping by that column would have matched every plain-text file nothing could classify).
 *
 * A kind with no entry in EMBED_KIND_FINGERPRINTS falls back to the global digest, which is safe in the direction that matters: a newly embeddable document format is a new source in embedFingerprintSources(), so it lands in the global set until it is given a bucket, and over-invalidating is the harmless mistake.
 */
export function embedKindForPath(filePath: string): string | null {
  if (isEmbeddableDocument(filePath)) return path.extname(filePath).toLowerCase().slice(1)
  if (detectLanguage(filePath) === 'markdown') return 'markdown'
  return null
}

/** The embedding fingerprint a file at this path is expected to have been chunked by: its kind's digest, or the global one. Each kind's digest already folds in every global source, so a chunker change moves all of them at once and a document-extractor change moves exactly one. */
export function embedFingerprintForPath(filePath: string): string {
  const kind = embedKindForPath(filePath)
  const digest = kind === null ? undefined : EMBED_KIND_FINGERPRINTS.get(kind)
  return digest ?? EMBED_FINGERPRINT
}
