/** Absolute paths of every source whose content is hashed into PARSER_FINGERPRINT, sorted. */
export function extractionSources(): string[]

/** Absolute paths of every source whose content is hashed into EMBED_FINGERPRINT, sorted. */
export function embedFingerprintSources(): string[]

/** The 16-hex-character digest of those sources, as stamped into files.parser_sha. */
export function computeFingerprint(): string

/** The 16-hex-character digest of embedFingerprintSources(), as folded into embeddingProvenance(). */
export function computeEmbedFingerprint(): string
