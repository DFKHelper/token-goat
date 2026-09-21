/**
 * Configuration types and interfaces for token-goat.
 */

// ---------------------------------------------------------------------------
// Section interfaces
// ---------------------------------------------------------------------------

export interface CompactAssistConfig {
  enabled: boolean
  triggers: string[]
  min_events: number
  max_manifest_tokens: number
  auto_trigger_multiplier: number
  compact_skip_ttl_secs: number
  noise_floor_tokens: number
  edited_dir_group_threshold: number
  max_section_lines: number
  wide_session_threshold: number
  orchestrator_commit_threshold: number
  max_manifest_chars: number
  summary_budget_chars: number
  harness: string
}

export interface BashCompressConfig {
  enabled: boolean
  disabled_filters: string[]
  max_lines: number
  max_bytes: number
  timeout_seconds: number
  cache_min_bytes: number
  cache_max_file_count: number
  cache_max_bytes: number
  cache_max_bytes_per_output: number
  min_net_savings_bytes: number
  elide_served_shell_output: boolean
}

export interface AgentReportConfig {
  /** Reports at or above this many bytes are cached and eligible for envelope compaction. */
  min_bytes: number
  /** A fenced block must exceed this many body lines before any of it is elided. */
  fence_collapse_min_lines: number
  /** Lines kept at each end of a collapsed fenced block. */
  fence_collapse_keep_lines: number
}

export interface BashDiffConfig {
  max_hunks_per_file: number
}

export interface SeverityLogConfig {
  context_lines: number
  score_threshold: number
}

/**
 * Gates the post-read structural-navigation hint in `postReadHandler` (hooks_read.ts):
 * once a just-read source file has at least `min_lines` lines, the hook nudges toward
 * `token-goat skeleton`/`outline` for bodies-elided navigation instead of a future full
 * re-read. Historically gated an actual regex-based code compressor (removed as dead code
 * -- see code_compress.ts in git history); the config key is kept unchanged to avoid a
 * config-schema break for existing users.
 */
export interface CodeCompressConfig {
  min_lines: number
}

export interface SessionBriefConfig {
  enabled: boolean
}

export interface SkillPreservationConfig {
  enabled: boolean
  max_cache_bytes: number
  orphan_sweep_enabled: boolean
  orphan_age_secs: number
  truncation_budget_tokens: number
  compress_bodies: boolean
  compress_min_bytes: number
  inline_snippets: boolean
  pre_skill_enabled: boolean
  first_load_compact: boolean
  post_compact_full_loads: boolean
}

/** The resolution tier of the model that will be shown an image, which decides what its pixels cost. Anthropic runs two and they bill the same image very differently; see `image_shrink.ts::visionTokens`. */
export type VisionTier = 'standard' | 'high'

export interface ImageShrinkConfig {
  enabled: boolean
  jpeg_quality: number
  max_image_pixels: number
  screenshot_redirect: boolean
  ocr_enabled: boolean
  ocr_min_confidence: number
  ocr_lang: string
  vision_tier: VisionTier
}

export interface ScreenshotConfig {
  chrome_path: string
  // When true (default), takeScreenshot rejects non-http(s) schemes and literal
  // loopback/link-local/RFC1918 hosts before navigating, so injected content can't aim the
  // headless browser at cloud metadata (169.254.169.254) or a localhost-only service. Set
  // false to opt out for users who legitimately screenshot internal/private targets.
  block_private_targets: boolean
}

export interface RepomapConfig {
  compact_file_threshold: number
  exclude_tests: boolean
}

export interface OverflowGuardConfig {
  enabled: boolean
  max_tokens: number
}

export interface StatsConfig {
  record_zero_savings: boolean
}

export interface PromptTrigger {
  keywords: string[]
  hint: string
}

export interface HintsConfig {
  quiet_hours: string
  json_sidecar: boolean
  min_file_lines_for_hint: number
  bash_dedup_min_bytes: number
  web_dedup_min_bytes: number
  grep_dedup_min_matches: number
  glob_dedup_min_matches: number
  write_rewrite_min_lines: number
  write_rewrite_unchanged_pct: number
  serve_diff_on_reread: boolean
  /** Rewrite a completed Read to withhold stretches of it the session was already handed. */
  elide_served_lines: boolean
  /** Hard-deny a subagent's first, un-ranged Read of a >=30KB markdown file with >=3 headings, serving the heading tree instead. Off by default: the outcome rates for a first-read deny of this shape have never been measured, only borrowed from the re-read census. */
  subagent_markdown_first_read_deny: boolean
  // Ascending suppressed-occasion counts at which hint_stats.ts's applyHintTracking lets a
  // suppressed hint category through as a genuine "probe" emission, so fresh acted-on signal
  // can lift it back above hint_stats.suppress_threshold_pct -- see that module's "Probe
  // recovery" doc-comment section. `[]` means no probes: suppression is permanent until a
  // manual `token-goat hint-stats --reset`.
  backoff_thresholds: number[]
  git_hint_max_ms: number
  min_session_hint_savings_bytes: number
  pre_skill_advisory: boolean
  context_threshold_advisory: boolean
  diff_hint_min_tokens_saved: number
  large_read_redirect_bytes: number
  reread_deny: boolean
  reread_deny_min_bytes: number
  stable_doc_compacts: boolean
  fold_code_bodies: boolean
  fold_comment_blocks: boolean
  fold_prose_paragraphs: boolean
  outline_large_documents: boolean
  skeleton_large_sources: boolean
  truncated_read_min_lines: number
  protect_recent_reads: number
  warn_unbalanced_shell_quoting: boolean
  prompt_triggers: PromptTrigger[]
  log_large_file_hint_outcomes: boolean
  cross_session_read_dedup: boolean
  cross_session_read_dedup_ttl_secs: number
  mcp_dedup_ttl_secs: number
  // Whether the SessionStart hook (hooks_session_start.ts) injects a short command-routing
  // reminder as additionalContext at session start/resume/compact-restart. The one-time static
  // CLAUDE.md block install.ts writes only reaches the model once per install, with zero
  // reinforcement across a long session -- this re-injects a short reminder every time a
  // SessionStart fires. Defaults true; set false to silence it entirely.
  session_start_reminder: boolean
}

export interface HooksConfig {
  watchdog_ms: number
  // p95 hook duration, in milliseconds, above which `token-goat doctor`'s "Hook latency" check reports a warn instead of an ok. A ceiling meant to catch a genuine regression, not a tight bound on the normal range -- see cli_doctor.ts's checkHookLatency for the measured populations this default sits above.
  latency_budget_ms: number
}

export interface WebFetchConfig {
  allow: string[]
  deny: string[]
  max_file_count: number
  max_bytes: number
  compress_bodies: boolean
  compress_min_bytes: number
}

export interface WorkerConfig {
  blocked_roots: string[]
  max_pool_workers: number
  // How many OS threads ONNX Runtime may use for one embedding inference. Left unset, ORT sizes
  // its intra-op pool to the machine: measured on a 26-logical-core host, creating the session
  // took the process from 13 threads to 30, and every embed call then fanned out across all of
  // them. That is a background daemon taking most of a workstation for as long as an index run
  // lasts. A session created with an explicit count added no threads at all in the same
  // measurement, so this is the lever. Small on purpose: indexing is never the user's foreground
  // task, and a slower index that leaves the machine usable beats a fast one that does not.
  embed_threads: number
  // Scheduling priority the indexing processes ask the OS for. `below_normal` costs nothing on an
  // idle machine (the scheduler only demotes under contention) and is what keeps a long walk from
  // competing with the desktop. `low` is more aggressive and can starve the daemon on a
  // permanently busy host; `normal` restores the old behaviour. Nothing above normal is offered:
  // a config file must not be able to raise a background process over the user's own work.
  priority: string
}

export interface IndexingConfig {
  large_file_symbol_only_kb: number
  large_file_skip_kb: number
  // Most chunks one file may contribute to the semantic index before it is indexed for symbols
  // only, the same outcome large_file_symbol_only_kb produces but measured on the axis that
  // actually distinguishes generated data from source. Byte size does not: chunk cuts snap to
  // structure, so a generated JSON snapshot with thousands of one-line keys turns a few hundred
  // kilobytes into thousands of near-identical chunks while a source file of the same size makes a
  // few hundred meaningful ones. See maxChunksEmbedSha in parser.ts.
  max_chunks_per_file: number
  skip_dirs: string[]
  // Basenames (not paths) excluded from the syntactic parse regardless of directory depth --
  // e.g. generated coverage reports. Defaults to the previously-hardcoded coverage.json /
  // coverage-final.json so existing behavior is unchanged; users can add their own generated
  // artifacts (lcov.json, stats.json, ...) or override this list to re-include a legitimately
  // named file. See isParseSkipEligible in parser.ts.
  skip_files: string[]
  // Whether a bare-name `symbol` lookup searches the machine-wide index (every project ever
  // indexed on this machine) or only the project it is run from. True keeps the documented
  // cross-project default. Set false to confine it: `symbol` then scopes to the current
  // project root and refuses a --project or --file that points outside it, so an agent working
  // in one repository cannot read source out of another through the shared index.
  cross_project_symbols: boolean
  // Whether indexing (token-goat index and the worker's incremental drain) also chunks and
  // embeds file content for `token-goat semantic`, in addition to the always-on syntactic
  // symbols/refs parse. Defaults to true to match the feature's advertised behavior; set
  // false to skip the (meaningfully slower, model-inference-backed) embeddings step and keep
  // indexing purely syntactic. Independently gated at the point of use on whether
  // onnxruntime-node and sqlite-vec are actually installed - this flag only controls
  // whether embeddings are attempted at all.
  embeddings_enabled: boolean
}

export interface CompressionConfig {
  profile: string
}

export interface ContextConfig {
  model_window_tokens: number
}

/** Config for the Google Drive integration (gdrive.ts, `gdrive-sections`). */
export interface GdriveConfig {
  /** When false the `gdrive-sections` command refuses, and the installed agent guidance stops naming it. For an organisation that does not use Google Drive and does not want the integration reachable or visible. */
  enabled: boolean
}

/**
 * Config for redaction: what counts as a secret before anything is written to disk or handed back
 * to the model. The built-in patterns (see `src/secret_redact.ts`) cover the credential shapes with
 * a recognisable prefix. These two settings exist for the credentials that do not have one.
 */
export interface RedactionConfig {
  /** Extra regular expressions redacted alongside the built-in patterns, as `[REDACTED:custom]`. For an in-house credential or identifier format no public tool knows the shape of -- an employee number, an internal account id, a bespoke token prefix. JavaScript regular-expression syntax, matched case-sensitively and globally. An entry that does not compile is reported by `token-goat doctor` and skipped, rather than silently ignored or fatal. */
  custom_patterns: string[]
  /** When true, also redact long unbroken high-entropy strings that match no known pattern -- the shape of a credential nobody wrote a rule for. Off by default because it is a heuristic and will sometimes redact a hash, a git SHA, or a base64 blob that was not a secret. On, it trades some readability for the assumption that an unrecognised random-looking string is a credential until proven otherwise. */
  strict: boolean
}

/** Config for offline mode: the single switch that guarantees token-goat opens no outbound connection of its own. */
export interface NetworkConfig {
  /** When true every network path token-goat can initiate refuses instead of connecting: its own HTTP fetches (`fetch-image`, `gdrive-sections`, image URLs a read hook shrinks), the embedding-model download, the OCR language-data download, and `screenshot`. Nothing is silently degraded -- each path says it is offline. For an air-gapped install, or an evaluation that needs one lever rather than an audit of five. */
  offline: boolean
}

export interface InjectionConfig {
  enabled: boolean
}

/** Config for the MCP server's filesystem admission gate (mcp_server.ts). */
export interface McpConfig {
  confine_reads_to_project_root: boolean
  /** Absolute roots a caller-supplied `projectRoot` must resolve inside. Empty (the default) keeps today's behaviour exactly: any root the caller names is accepted. `confine_reads_to_project_root` stops traversal OUT of whichever root it is given; it does not constrain WHICH root the caller supplies, and since MCP tool arguments are model-generated that choice is untrusted input. This is the setting that pins it, for deployments where MCP is the only channel to the filesystem. */
  allowed_roots: string[]
}

/**
 * Config for `token-goat hint-stats` (hint_stats.ts): the suppression gate that stops emitting
 * a hint category for the rest of a session once its measured efficacy (acted-on / emitted)
 * falls below `suppress_threshold_pct`, but only once at least `min_sample_size` emissions have
 * been observed -- guards against suppressing a category on a single unlucky (or un-actable,
 * e.g. no correlator extracted) data point.
 */
export interface HintStatsConfig {
  suppress_threshold_pct: number
  // The ceiling a SUPPRESSION category is judged against instead of `suppress_threshold_pct` (see hint_stats.ts's SUPPRESSION_HINT_CATEGORIES). Those categories ask for an absence, so their emissions are booked compliance-first -- `acted_on = 0` is written only when a re-read of the named path is actually observed -- which makes `100 - efficacy` their measured defiance rate. Suppress once that rate exceeds this. Defaults to 85, the exact complement of `suppress_threshold_pct`'s 15, so every verdict is unchanged until the two are deliberately set apart; they are separate knobs because a defiance rate and an uptake rate have different natural base rates and there is no reason one number should serve both.
  defiance_threshold_pct: number
  min_sample_size: number
}

/**
 * Config for semantic search's path-priority reranking (rerankHits in embeddings.ts): a
 * multiplier applied to a hit's distance so live source wins ties/near-ties against stale or
 * archival prose (a design doc in docs/, an old plan under plans/, an archive/ folder, a
 * CHANGELOG entry, a *.bak file), which otherwise frequently outranks the actual implementing
 * code purely on vector similarity. Multiplier only, never a hard filter -- a genuinely much
 * better archival match can still surface. Set a weight to 1.0 to disable its penalty entirely,
 * e.g. for a project with a genuinely live `plans/` directory.
 */
export interface SemanticConfig {
  archive_weight: number
  docs_weight: number
  // Relevance floor: a dense hit whose raw distance exceeds this is dropped before fusion, so a corpus whose own distances have been measured can stop the vector half answering a question it has nothing for. Applied to the hits searchSemantic returns rather than inside its scan, because the scan's backfill loop retries while `hits.length < topK` -- tightening the bound in there would make the weakest queries escalate k to the ANN ceiling and fall through to the exact pass, which is the most expensive thing this command can do and exactly backwards. DEFAULT_DISTANCE_THRESHOLD stays as the scan's own sanity bound; this is the relevance decision and it is separate. Compared against raw distance, not the rerank's adjustedDistance, which is a ranking device with no calibrated scale. See the default's comment for why it ships filtering nothing.
  max_distance: number
}

export interface Config {
  compact_assist: CompactAssistConfig
  bash_compress: BashCompressConfig
  agent_report: AgentReportConfig
  bash_diff: BashDiffConfig
  bash_severity_log: SeverityLogConfig
  post_read_code_compress: CodeCompressConfig
  session_brief: SessionBriefConfig
  skill_preservation: SkillPreservationConfig
  image_shrink: ImageShrinkConfig
  screenshot: ScreenshotConfig
  repomap: RepomapConfig
  overflow_guard: OverflowGuardConfig
  stats: StatsConfig
  hints: HintsConfig
  hooks: HooksConfig
  webfetch: WebFetchConfig
  worker: WorkerConfig
  indexing: IndexingConfig
  compression: CompressionConfig
  context: ContextConfig
  injection: InjectionConfig
  gdrive: GdriveConfig
  redaction: RedactionConfig
  network: NetworkConfig
  mcp: McpConfig
  hint_stats: HintStatsConfig
  semantic: SemanticConfig
}

export interface ProjectConfigInfo {
  path: string
  keys: string[]
  /** Raw (pre-validation) value per dotted key in {@link ProjectConfigInfo.keys}. Empty when `parseError` is set. */
  values: Record<string, unknown>
  parseError: string | null
}

/**
 * Which configuration layer produced the effective value of one key. A closed union: adding a
 * member makes every `switch` over it fail to compile until each consumer handles it, which is
 * the point — `config get`, `config list`, and `config set`'s shadow warning all render from
 * this one result rather than each re-deciding attribution (see resolveConfigKeyLayer).
 */
export type ConfigKeyLayer =
  | { layer: 'global' }
  | { layer: 'env'; envVar: string }
  | { layer: 'env-invalid'; envVar: string; rawValue: unknown; effectiveValue: unknown; reason: string | null }
  | { layer: 'project'; path: string }
  | { layer: 'project-invalid'; path: string; rawValue: unknown; effectiveValue: unknown; reason: string | null }
  | { layer: 'project-unparsed'; path: string; parseError: string }
