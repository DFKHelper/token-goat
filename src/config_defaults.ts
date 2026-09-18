/**
 * Default configuration values and factory functions for token-goat.
 */

import { DEFAULT_OCR_LANG } from './ocr_languages.js'
import type {
  Config,
  CompactAssistConfig,
  BashCompressConfig,
  AgentReportConfig,
  BashDiffConfig,
  SeverityLogConfig,
  CodeCompressConfig,
  SessionBriefConfig,
  SkillPreservationConfig,
  ImageShrinkConfig,
  ScreenshotConfig,
  RepomapConfig,
  OverflowGuardConfig,
  StatsConfig,
  HintsConfig,
  HooksConfig,
  WebFetchConfig,
  WorkerConfig,
  IndexingConfig,
  CompressionConfig,
  ContextConfig,
  InjectionConfig,
  GdriveConfig,
  RedactionConfig,
  NetworkConfig,
  McpConfig,
  HintStatsConfig,
  SemanticConfig,
} from './config_types.js'

export const CONFIG_DEFAULTS: Record<string, object> = {
  compact_assist: {
    enabled: true,
    triggers: ['manual', 'auto'],
    min_events: 3,
    max_manifest_tokens: 400,
    auto_trigger_multiplier: 2.0,
    compact_skip_ttl_secs: 300.0,
    noise_floor_tokens: 0,
    edited_dir_group_threshold: 3,
    max_section_lines: 0,
    wide_session_threshold: 15,
    orchestrator_commit_threshold: 5,
    max_manifest_chars: 1600,
    summary_budget_chars: 24000,
    harness: 'auto',
  },
  bash_compress: {
    enabled: true,
    disabled_filters: [],
    max_lines: 1000,
    max_bytes: 64 * 1024,
    timeout_seconds: 600,
    // Matches the hardcoded MIN_CACHE_BYTES floor hooks_bash.ts used before this
    // knob was wired to a real consumer, so untouched-config installs see no
    // behavior change now that hooks_bash.ts reads this value instead.
    cache_min_bytes: 512,
    cache_max_file_count: 4096,
    cache_max_bytes: 16 * 1024 * 1024,
    cache_max_bytes_per_output: 50 * 1024 * 1024,
    // Measured against the filter test-fixture corpus (424 apply() calls, 298 with
    // bytesSaved > 0): net-of-marker savings (bytesSaved - ~70-79B marker cost) is
    // <= 0 for 130/298 (44%) of "compressed" results and <= 100 for 170/298 (57%),
    // while the real-win half sits at p75=393B / p90=952B net. 100 kills the
    // marker-doesn't-even-pay-for-itself tier without touching genuine wins.
    min_net_savings_bytes: 100,
    // Extends the per-file already-served elision (which only reaches cat/head/tail/sed/awk-shaped reads) to every other Bash command's output -- npm test, git, rg, build runs -- matched against a session-wide served-output list instead of a per-file one. On by default: it goes through the same isRewriteWorthwhile net-benefit gate as every other rewrite here, so it never ships a notice that costs more than the lines it withholds.
    elide_served_shell_output: true,
  },
  agent_report: {
    // Well above the ~2,220 char/call average measured from real claude-skills session transcripts, so only genuine outlier reports are touched. Preserves the hardcoded AGENT_RESULT_CACHE_MIN_BYTES this replaced, so untouched-config installs see no behavior change.
    min_bytes: 8000,
    fence_collapse_min_lines: 20,
    fence_collapse_keep_lines: 6,
  },
  bash_diff: {
    max_hunks_per_file: 10,
  },
  bash_severity_log: {
    context_lines: 3,
    score_threshold: 0.5,
  },
  post_read_code_compress: {
    min_lines: 200,
  },
  session_brief: {
    enabled: true,
  },
  skill_preservation: {
    enabled: true,
    max_cache_bytes: 5 * 1024 * 1024,
    orphan_sweep_enabled: true,
    orphan_age_secs: 604800,
    truncation_budget_tokens: 800,
    compress_bodies: true,
    compress_min_bytes: 16 * 1024,
    inline_snippets: true,
    pre_skill_enabled: true,
    first_load_compact: false,
    post_compact_full_loads: false,
  },
  image_shrink: {
    enabled: true,
    jpeg_quality: 75,
    // 16,000,000 used to reject a routine 24MP DSLR/phone photo outright -- the exact input this feature exists to shrink -- while the engine's own decode ceiling (MAX_DECODED_BYTES in image_engine.ts, 256MB at 4 bytes/pixel for a single frame) sits at 67,108,864px. 64,000,000 covers cameras well past 24MP (including 48MP phone sensors) with ~4.9% margin below that hard ceiling, which assertDecodableSize enforces independently of this value on every decode regardless of what this header check allows through. Measured on this engine (2026-09-17): a 24MP PNG decodes+shrinks in ~370ms, 60,000,516px in ~920ms, and 67,108,864px (the ceiling itself) in ~760ms -- all comfortably fast, so the new value is chosen for coverage headroom under the ceiling, not for decode-time cost. Decode time is not the cost that binds, though: memory is. This value is read off a header before anything is decoded, so what it really sets is how large a buffer a file's own declared dimensions may talk this hook into allocating -- at 4 bytes per pixel, raising it from 16,000,000 raised that peak from ~64MB to ~256MB, which is why it now sits flush against MAX_DECODED_BYTES rather than comfortably below it. And on the JPEG path there is no assertDecodableSize call at all: decodeJpeg hands the buffer to jpeg-js, so a JPEG decode is bounded by whatever maxResolutionInMP/maxMemoryUsageInMB that call passes -- a bound this codebase states only because decodeJpeg passes both explicitly rather than inheriting jpeg-js's own 100MP default, which is looser than the 67.1MP MAX_DECODED_BYTES allows.
    max_image_pixels: 64_000_000,
    screenshot_redirect: true,
    ocr_enabled: true,
    // Confidence is Tesseract's own 0-100 mean-word-confidence score. 65 is a deliberately
    // conservative floor: a real screenshot of terminal/code/prose text routinely scores
    // 85+, while a photo with an incidental sign or logo in frame scores much lower and
    // noisier -- padding the threshold below the terminal/code norm still comfortably
    // excludes photographic false positives without needing a second heuristic.
    ocr_min_confidence: 65,
    ocr_lang: DEFAULT_OCR_LANG,
    // Which resolution tier the model being shown the image is on, which decides what its pixels
    // cost. 'standard' (1568px long edge, 1568 visual tokens) is every model before Claude 4.7;
    // 'high' (2576px, 4784 tokens) is 4.7 and later, and bills the same large image up to roughly
    // three times higher. Only the saving *reported* by `token-goat stats` depends on this -- no
    // image is encoded differently -- and 'standard' is the default because it is the floor: it
    // caps the counterfactual at the smaller of the two bills and so can never credit a saving
    // that was not there. Set it to 'high' on a Claude 4.7+ model to see the larger real figure.
    vision_tier: 'standard',
  },
  screenshot: {
    chrome_path: '',
    block_private_targets: true,
  },
  repomap: {
    compact_file_threshold: 50,
    exclude_tests: true,
  },
  overflow_guard: {
    enabled: true,
    max_tokens: 25000,
  },
  stats: {
    record_zero_savings: false,
  },
  hints: {
    quiet_hours: '',
    json_sidecar: false,
    min_file_lines_for_hint: 0,
    bash_dedup_min_bytes: 200,
    web_dedup_min_bytes: 200,
    grep_dedup_min_matches: 5,
    glob_dedup_min_matches: 5,
    // Existing on-disk file must have at least this many lines before a Write rewrite is even
    // considered -- rewriting a small file whole is fine, so hooks_write.ts's detector skips
    // comparison entirely below this floor rather than firing on trivial files.
    write_rewrite_min_lines: 40,
    // Minimum percentage of the existing file's lines that must survive unchanged (by LCS) in
    // the incoming Write content for hooks_write.ts to advise Edit instead. High by design: this
    // is only meant to catch the "mostly untouched, a few lines changed" case, not a genuine
    // rewrite that happens to share some boilerplate.
    write_rewrite_unchanged_pct: 75,
    serve_diff_on_reread: true,
    elide_served_lines: true,
    subagent_markdown_first_read_deny: false,
    backoff_thresholds: [1, 3, 10, 30],
    git_hint_max_ms: 50,
    min_session_hint_savings_bytes: 512,
    pre_skill_advisory: true,
    context_threshold_advisory: true,
    diff_hint_min_tokens_saved: 1000,
    // Base for the pressure-scaled first-read deny gate in hooks_read.ts (large file, never read
    // before). Matches that gate's long-tuned 500KB threshold at 'cool' context pressure; warm/hot/
    // critical scale it down from there so the same read gets redirected to a surgical read sooner
    // once the context window is nearly full.
    large_read_redirect_bytes: 512_000,
    reread_deny: true,
    // Matches hooks_read.ts's previously-hardcoded REREAD_DENY_BYTES (50 * 1024) so wiring this
    // key up as the real gate for that logic does not silently change default behavior for
    // existing users -- see the reread_deny/reread_deny_min_bytes fix's commit message.
    reread_deny_min_bytes: 51_200,
    stable_doc_compacts: true,
    // On. It has now run. The gate that finds the spans answered only from the index, and the index carried the shipping parser stamp on 46 of 17,952 files, so the lever was very nearly dead in practice: a disk parse of the delivered file is now the fallback, worth +3.0 points of withheld bytes on shell reads with no index at all. The cost side is the one this comment used to call unobservable, and it is observable: joining folds to later reads of the folded symbol scores 62.3% recovery, but the same window measured backwards scores 55.8% and a shuffled pairing scores 24.3%, so the excess attributable to the fold is 6.6 points rather than 62. Unlike every re-read mechanism beside it this rewrites a FIRST look, where the reader has no prior copy to notice an omission against, which is why the notice names the symbol and the command that returns it verbatim.
    fold_code_bodies: true,
    // On, and separate from the body fold above because the two do not carry the same risk. A body fold needs symbol spans from the index, so it can cut at the wrong line when the index is stale, and it hides the implementation an agent came to read. A comment fold reads the block boundaries off the delivered text itself, so it cannot be stale and works on the first read of a file the indexer has never seen, which is exactly the surface nothing else here reaches. It keeps the opening two lines of a block of 12 or more, so the summary sentence a reader navigates by survives and only the elaboration is replaced, and it alters the text of no line it keeps, its notice naming the absolute range removed so the recall is exact. Measured across this project's own 259 source files it removes 8.07% of the delivered bytes over 420 folds in 170 files. The nearest published measurement is stronger and cruder: removing docstrings outright cost 3 points of resolution rate on SWE-bench Verified for 22% of the tokens (arXiv:2606.01326), and keeping the opening summary is the gentler trade on that curve.
    fold_comment_blocks: true,
    // On. It has now run: measured over 2,032 real document reads it removes 43.4% of the pool and 57.4% of the reads it touches, keeping every heading, table, block quote and fenced line, and replacing only the tail of a paragraph whose opening sentence is already a complete one. The recall it needs is a ranged Read of the single line named in the notice, which costs one call and is printed at the point of the cut rather than left for the reader to work out. The project-config lock below stays regardless of this default: a repository still cannot set this key, so the choice to fold is the reader's environment and never the code being read.
    fold_prose_paragraphs: true,
    // On. Fires on an untargeted (no offset/limit) Read of a markdown document at least 8,000 bytes with at least 6 headings, replacing the delivered body with a heading tree plus the document preamble when that replacement is meaningfully smaller. Built from the delivered text itself, never the index, so it works on a document the indexer has never seen. Measured over 5,104 real session transcripts (13,870 Read deliveries, 130,249,204 bytes): untargeted markdown reads with >=6 headings at this 8,000-byte floor withhold 41.03% of all Read bytes, within 1.8 points of the best floor tried (2,000 B) while firing far less often on small documents where the interruption is least worth it.
    outline_large_documents: true,
    // On. The source-code sibling of outline_large_documents directly above, and gated the same way: an untargeted (no offset/limit) Read of a tree-sitter language at least 12,000 bytes with at least 8 symbols is replaced by its structural skeleton, the preamble plus one declaration line per symbol, with each withheld run named and pointed at the command that returns it. Symbols come from tree-sitter over the delivered text, never the index and never the regex extractors, so a partial symbol list turns the fold off rather than shipping a skeleton missing declarations nothing signals. Measured over 5,104 real session transcripts (130,325,670 delivered Read bytes): 558 reads clear this floor, and the fold withholds 11,241,796 B, 8.63% of all Read bytes.
    skeleton_large_sources: true,
    truncated_read_min_lines: 200,
    protect_recent_reads: 4,
    warn_unbalanced_shell_quoting: true,
    prompt_triggers: [],
    log_large_file_hint_outcomes: false,
    cross_session_read_dedup: false,
    cross_session_read_dedup_ttl_secs: 2700,
    mcp_dedup_ttl_secs: 45,
    session_start_reminder: true,
  },
  hooks: {
    watchdog_ms: 700,
  },
  webfetch: {
    allow: [],
    deny: [],
    max_file_count: 4096,
    max_bytes: 32 * 1024 * 1024,
    compress_bodies: true,
    compress_min_bytes: 16 * 1024,
  },
  worker: {
    blocked_roots: [],
    max_pool_workers: 4,
    // 4, not 2. Measured on a 26-core Windows host with a foreground CPU probe: at `priority`
    // below_normal, 2, 4 and 6 threads are all indistinguishable from an idle machine, including
    // when the indexer and the probe are pinned to the same 4 cores, and including 4 threads pinned
    // to 2 cores, which is genuine oversubscription. The same probe reads -10% at 16 threads and
    // -69% with a 292 ms stall at 4 threads on 2 cores once the priority is normal instead. So the
    // priority below is what keeps the foreground responsive, not this number, and 4 buys a
    // measured 1.77x on indexing for no foreground cost. It stays a cap rather than tracking the
    // core count, because where the platform refuses the priority change (some hardened Linux
    // setups, sandboxes) this is the only thing left holding indexing back.
    embed_threads: 4,
    priority: 'below_normal',
  },
  indexing: {
    large_file_symbol_only_kb: 500,
    large_file_skip_kb: 2048,
    skip_dirs: [],
    skip_files: ['coverage.json', 'coverage-final.json'],
    embeddings_enabled: true,
    cross_project_symbols: true,
  },
  compression: {
    profile: 'auto',
  },
  context: {
    model_window_tokens: 200_000,
  },
  injection: {
    enabled: true,
  },
  gdrive: {
    enabled: true,
  },
  redaction: {
    custom_patterns: [],
    strict: false,
  },
  network: {
    offline: false,
  },
  mcp: {
    confine_reads_to_project_root: true,
    allowed_roots: [],
  },
  hint_stats: {
    suppress_threshold_pct: 15,
    min_sample_size: 5,
  },
  semantic: {
    archive_weight: 0.7,
    docs_weight: 0.92,
  },
}

export function getDefaultConfig(section: string): object {
  return structuredClone(CONFIG_DEFAULTS[section] ?? {})
}

export function defaultConfig(): Config {
  return {
    compact_assist: getDefaultConfig('compact_assist') as CompactAssistConfig,
    bash_compress: getDefaultConfig('bash_compress') as BashCompressConfig,
    agent_report: getDefaultConfig('agent_report') as AgentReportConfig,
    bash_diff: getDefaultConfig('bash_diff') as BashDiffConfig,
    bash_severity_log: getDefaultConfig('bash_severity_log') as SeverityLogConfig,
    post_read_code_compress: getDefaultConfig('post_read_code_compress') as CodeCompressConfig,
    session_brief: getDefaultConfig('session_brief') as SessionBriefConfig,
    skill_preservation: getDefaultConfig('skill_preservation') as SkillPreservationConfig,
    image_shrink: getDefaultConfig('image_shrink') as ImageShrinkConfig,
    screenshot: getDefaultConfig('screenshot') as ScreenshotConfig,
    repomap: getDefaultConfig('repomap') as RepomapConfig,
    overflow_guard: getDefaultConfig('overflow_guard') as OverflowGuardConfig,
    stats: getDefaultConfig('stats') as StatsConfig,
    hints: getDefaultConfig('hints') as HintsConfig,
    hooks: getDefaultConfig('hooks') as HooksConfig,
    webfetch: getDefaultConfig('webfetch') as WebFetchConfig,
    worker: getDefaultConfig('worker') as WorkerConfig,
    indexing: getDefaultConfig('indexing') as IndexingConfig,
    compression: getDefaultConfig('compression') as CompressionConfig,
    context: getDefaultConfig('context') as ContextConfig,
    injection: getDefaultConfig('injection') as InjectionConfig,
    gdrive: getDefaultConfig('gdrive') as GdriveConfig,
    redaction: getDefaultConfig('redaction') as RedactionConfig,
    network: getDefaultConfig('network') as NetworkConfig,
    mcp: getDefaultConfig('mcp') as McpConfig,
    hint_stats: getDefaultConfig('hint_stats') as HintStatsConfig,
    semantic: getDefaultConfig('semantic') as SemanticConfig,
  }
}
