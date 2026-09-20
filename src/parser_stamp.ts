/**
 * Resolves the `files.parser_sha` stamp a row of a given language is expected to carry, from the generated digests in `parser_fingerprint.ts`.
 *
 * A module of its own rather than a function in `parser_types.ts` because that file is hashed into both PARSER_FINGERPRINT and EMBED_FINGERPRINT: adding this lookup there moved the embed digest and would have re-embedded every already-indexed file on upgrade, for a change that decides nothing about what a parse extracts or how a file's bytes become chunk text. Nothing here is hashed into either digest, so editing this resolver invalidates no one's index.
 */

import { LANGUAGE_PARSER_FINGERPRINTS, PARSER_FINGERPRINT } from './parser_fingerprint.js'

/**
 * The parser fingerprint a file of `language` must carry in `files.parser_sha` to count as parsed by the extraction logic this build runs. The three freshness gates (cli.ts's cmdIndex, worker.ts's makeIndexer, reconcile.ts's sweep) and the read hook's fold gate all resolve a row's expected stamp through here, and parser.ts writes it.
 *
 * Keyed on the id stored in `files.language` rather than on a second resolution of the path. `parser_types.ts`'s `detectLanguage` is path-only and its `refineLanguageByContent` can move that verdict, so a VB6 `.cls` -- stored, correctly, as `vb` -- would be checked against Apex's digest, and a fix to the VB adapter would leave its rows stale with nothing to say so. The stored column is the language the extractor actually ran as, written by the same INSERT as the stamp itself, so the two cannot disagree.
 *
 * A language with no adapter module of its own (the tree-sitter languages, the structured-document formats parser.ts extracts inline), and an unrecognized or missing one, falls back to the shared digest. That is safe in the direction that matters: every decision that maps a path or its content to a language -- `parser_types.ts`'s `detectLanguage` tables and its `CONTENT_SNIFFS`, plus `languages/sniff.ts` -- is hashed into the shared digest, so a file can only become some adapter's business through a change that moves every stamp anyway.
 */
export function parserFingerprintForLanguage(language: string): string {
  return LANGUAGE_PARSER_FINGERPRINTS.get(language) ?? PARSER_FINGERPRINT
}
