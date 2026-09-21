// GENERATED FILE -- do not edit by hand. Run `npm run parser:fingerprint` to regenerate.
//
// A digest of the global embedding-decision sources returned by embedGlobalSources() in scripts/parser-fingerprint.mjs -- the chunker and every module that decides embedding for all kinds at once -- folded into embeddingProvenance() (src/embeddings.ts) alongside the model name, its pinned revision, and the inference backend. A mismatch in this half alone keeps the stored vectors serving, since the model and runtime still share their space, and marks every embedded file stale so reconcile and `token-goat index` re-embed it. Before this existed, a chunker or document-extractor change left every already-embedded file's vectors built by the old code indefinitely, because content and model identity were the only keys.
export const EMBED_FINGERPRINT = '702c126bffd8439e'

// Per-kind digests, each over the global sources above plus that extraction kind's own. Keyed by the kind embedKindForPath() in src/embed_stamp.ts resolves a file to, which is what ensureEmbeddingProvenance scopes a re-embed by. A change to one document extractor moves one entry here, so only that format's already-embedded files are re-embedded; before this was per-kind, an edit to pdf_extract.ts re-embedded every file on the machine -- 243,238 chunks across 17,876 files on one real index.
export const EMBED_KIND_FINGERPRINTS: ReadonlyMap<string, string> = new Map([
  ['docx', 'a39e82e795d46ed1'],
  ['markdown', 'c65dd62705244608'],
  ['pdf', '9a0ea76d66dfd358'],
  ['pptx', 'b60b30cb38a801e2'],
  ['xlsx', 'e5b358c460b6507f'],
])

// The single whole-set digest EMBED_FINGERPRINT carried before the split above, shipped by v2.9.18 and every release before it. Frozen as a literal in scripts/parser-fingerprint.mjs rather than computed, because the split edited embeddings.ts, one of the sources that digest hashed. ensureEmbeddingProvenance treats a database stamped with exactly this value, in the same vector space, as already agreeing with every stamp above, so the upgrade re-embeds nothing; any other stored digest is re-embedded as before.
export const PRE_KIND_EMBED_FINGERPRINT = 'b7b2ff71de288d13'

// The value EMBED_FINGERPRINT held when the split above landed, frozen as a literal in scripts/parser-fingerprint.mjs so that it does not follow it. resetStaleChunking grandfathers a PRE_KIND_EMBED_FINGERPRINT database only while this build's global digest is still this one, because that is what makes the grandfathering true: nothing that produces chunk text changed between the two. The first edit to a global embedding source moves EMBED_FINGERPRINT off this value, the clause lapses on its own, and a database that skipped the intervening releases is re-embedded by the ordinary moved-global-digest path instead of keeping vectors the new chunker invalidated. This constant and PRE_KIND_EMBED_FINGERPRINT can both be deleted once no database stamped by v2.9.18 or earlier is plausible.
export const SPLIT_EMBED_FINGERPRINT = '2310db32d9bc8a2b'
