/**
 * Extension-based classification of files whose bytes are not text, kept in one leaf module with
 * no imports of its own so every consumer shares a single list.
 *
 * Two consumers, for two different reasons. The read hooks (src/hooks_read.ts, src/image_shrink.ts,
 * src/read_commands.ts) ask {@link isImagePath} whether a path is something the image pipeline
 * handles. The indexer (src/parser.ts's indexFileEmbeddings) asks {@link isNonTextAsset} whether a
 * file has any text worth embedding at all. Before this module existed the image list lived inside
 * image_shrink.ts, which the indexer cannot import: image_shrink.ts pulls in the hook registry, the
 * harness bridges and the stats ledger, and src/parser.ts's transitive import closure is audited
 * file by file by tests/guards/parser_fingerprint_covers_extraction_sources.ts.
 */
import * as path from 'node:path'

/** Recognised image extensions (lowercase, leading dot). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.heif',
])

/** True when `p` has a recognised image extension (case-insensitive). */
export function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())
}

/**
 * Every extension whose file holds encoded bytes rather than text: images, fonts, archives, audio,
 * video, and compiled artefacts. Deliberately NOT a superset of every binary format -- the document
 * formats (.pdf/.docx/.pptx/.xlsx) are binary too and are excluded here on purpose, because
 * src/doc_embed_extract.ts pulls real text out of them and that text is worth embedding.
 *
 * What lands here is the opposite case: a format with no text to pull. Decoding one as UTF-8 and
 * chunking the result does not fail, which is why this went unnoticed -- it produces chunk rows full
 * of control characters, each with a 384-dimensional vector, which then compete for neighbours
 * against real source. Measured on one real machine-wide index: 333 JPEGs produced 39,477 chunks
 * (about 118 per image, averaging 132 bytes of text each, the largest sampled chunk 83 characters of
 * carriage returns), and .webp/.png/.avif/.ttf added another 22,450 between them -- 25% of a 243,603
 * chunk index, none of it retrievable by anything a person would search for.
 */
export const NON_TEXT_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...IMAGE_EXTENSIONS,
  '.ico',
  '.icns',
  '.psd',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.class',
  '.pyc',
  '.pdb',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.sqlite3',
])

/** True when `p` has an extension from {@link NON_TEXT_ASSET_EXTENSIONS} (case-insensitive). */
export function isNonTextAsset(p: string): boolean {
  return NON_TEXT_ASSET_EXTENSIONS.has(path.extname(p).toLowerCase())
}

/**
 * An identity for the current contents of {@link NON_TEXT_ASSET_EXTENSIONS}, folded into the
 * embed_sha marker src/parser.ts stamps for a skipped asset. Same reasoning as the document work
 * clock in isEmbedFresh: the bound is compiled in rather than configured, and stamping it rather
 * than ignoring it means a release that edits the set re-examines every file stamped under the old
 * one instead of leaving a format buried forever after it is removed from the list. Re-examination
 * costs one extension lookup, so a set change is nearly free even though it invalidates every asset
 * stamp on the machine.
 *
 * A length-and-content fold rather than a cryptographic hash: this is a change detector for a list
 * this file owns, not a security boundary, and keeping it dependency-free keeps this module a leaf.
 */
export const NON_TEXT_ASSET_SET_ID: string = (() => {
  const joined = [...NON_TEXT_ASSET_EXTENSIONS].sort().join(',')
  let h = 2166136261
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
})()
