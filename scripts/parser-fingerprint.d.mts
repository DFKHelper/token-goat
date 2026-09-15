/** Absolute paths of every source whose content is hashed into PARSER_FINGERPRINT, sorted. */
export function extractionSources(): string[]

/** The 16-hex-character digest of those sources, as stamped into files.parser_sha. */
export function computeFingerprint(): string
