/** Absolute paths of every source whose content is hashed into PARSER_FINGERPRINT, sorted. */
export function extractionSources(): string[]

/** Absolute paths of every source whose content is hashed into EMBED_FINGERPRINT or into one of the per-kind digests, sorted -- the union the partition below splits. */
export function embedFingerprintSources(): string[]

/** Extraction kind -> the absolute paths of the embedding sources only that kind's extraction reaches. */
export function embedKindSources(): Map<string, string[]>

/** Absolute paths of the embedding sources no single extraction kind owns, sorted. */
export function embedGlobalSources(): string[]

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

/** The 16-hex-character digest of embedGlobalSources(), as folded into embeddingProvenance(). */
export function computeEmbedFingerprint(): string

/** Extraction kind -> the 16-hex-character digest of the global embedding sources plus that kind's own. */
export function computeEmbedKindFingerprints(): Map<string, string>
