/** Absolute paths of every source whose content is hashed into PARSER_FINGERPRINT, sorted. */
export function extractionSources(): string[]

/** Absolute paths of every source whose content is hashed into EMBED_FINGERPRINT, sorted. */
export function embedFingerprintSources(): string[]

/** Absolute paths of the extraction sources no single language owns, sorted. */
export function sharedExtractionSources(): string[]

/** Language id -> the absolute paths of the src/languages/ modules only that language's extractor reaches. */
export function languageExtractionSources(): Map<string, string[]>

/** Every `language: extractor` property of ADAPTER_EXTRACTORS, as `[language, valueText]`. */
export function adapterDispatchEntries(): [string, string][]

/** The 16-hex-character digest of sharedExtractionSources(), stamped into files.parser_sha for a language with no adapter of its own. */
export function computeFingerprint(): string

/** Language id -> the 16-hex-character digest of the shared sources plus that language's own adapter modules. */
export function computeLanguageFingerprints(): Map<string, string>

/** The 16-hex-character digest of embedFingerprintSources(), as folded into embeddingProvenance(). */
export function computeEmbedFingerprint(): string
