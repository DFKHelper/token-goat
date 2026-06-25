import { createHash } from "node:crypto";

export interface SessionCache {
  get_file_access_count?(filePath: string): number;
  get_hint_content_summary?(hash: string): string | undefined;
  record_hint_content_seen?(hash: string, summary: string): void;
  has_hint_fingerprint?(key: string): boolean;
  mark_hint_seen?(key: string): void;
  files?: Record<string, unknown>;
  pinned_symbols?: string[];
}

const _LOG = {
  warn: (msg: string) => console.warn(`[hints] ${msg}`),
  debug: (msg: string) => console.debug(`[hints] ${msg}`),
};

export interface HintItem {
  text: string;
  hint_priority: number;
}

export type ReadHint = string & { _readHint: true };

export const HINT_PRIORITY_CRITICAL = 1;
export const HINT_PRIORITY_HIGH = 2;
export const HINT_PRIORITY_MEDIUM = 3;
export const HINT_PRIORITY_LOW = 4;

export const HINT_MAX_PER_TOOL_CALL = 3;
export const DIFF_HINT_MAX_BYTES = 4096;
export const STALE_READ_AGE_SECONDS = 30 * 60;
export const LARGE_FILE_LINE_THRESHOLD = 500;

const _SLIM_HINT_MAX_CHARS = 220;
const _SLIM_WARM_THRESHOLD = 600;

const _DIFF_HINT_MIN_TOKENS_SAVED = 250;
const _DIFF_CONTEXT_LINES = 2;
const _DIFF_TINY_CHANGE_THRESHOLD = 3;
const _DIFF_TINY_CONTEXT_LINES = 1;

const _HIGH_FREQ_THRESHOLD = 3;
const _BASH_DEDUP_LIGHT_MAX_BYTES = 512;
const _BASH_DEDUP_GREP_SUGGEST_BYTES = 50000;
const _GLOB_DEDUP_MIN_RESULT_COUNT = 2;
const _GLOB_AVG_BYTES_PER_RESULT = 150;
const _MAX_BASH_COMMAND_DISPLAY_LEN = 60;

const _MIN_LINES_FOR_HINT = 60;
const _INDEX_ONLY_MIN_BYTES = 5000;
const _STRUCTURED_FILE_MIN_BYTES = 50000;

const _INDEX_ONLY_LOCKFILE_NAMES = new Set([
  "uv.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
]);

const _STRUCTURED_BASENAME_ENV = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".env.test",
  ".env.production",
  ".env.staging",
  ".env.development",
  ".env.defaults",
]);

export function slimHintText(text: string, tier?: string): string {
  if (!tier || !["warm", "hot", "critical"].includes(tier)) {
    return text;
  }

  const firstPara = text.split("\n\n")[0]?.trim() ?? "";
  if (!firstPara) {
    return text;
  }

  if (tier === "warm") {
    if (text.length <= _SLIM_WARM_THRESHOLD) {
      return text;
    }
    return firstPara;
  }

  if (!firstPara.includes("\n")) {
    return firstPara;
  }

  if (firstPara.length <= _SLIM_HINT_MAX_CHARS) {
    return firstPara;
  }

  return firstPara.slice(0, _SLIM_HINT_MAX_CHARS).trimEnd() + "…";
}

export function applyHintPriorityLimit(
  hints: HintItem[],
  maxHints: number = HINT_MAX_PER_TOOL_CALL,
  options?: { tier?: string | undefined }
): string[] {
  const tier = options?.tier ?? "cool";

  if (hints.length === 0) {
    return [];
  }

  const sorted = [...hints].sort((a, b) => a.hint_priority - b.hint_priority);

  if (sorted.length <= maxHints) {
    return sorted.map((h) => slimHintText(h.text, tier));
  }

  const emitted = sorted.slice(0, maxHints);
  const suppressedCount = sorted.length - maxHints;
  const result = emitted.map((h) => slimHintText(h.text, tier));
  result[result.length - 1] = `${result[result.length - 1]}\n(+${suppressedCount} suppressed)`;
  return result;
}

export function dedupHints(
  hintItems: HintItem[],
  sessionCache?: SessionCache | undefined
): HintItem[] {
  if (!sessionCache) {
    return hintItems;
  }

  const result: HintItem[] = [];
  for (const item of hintItems) {
    const normalized = item.text.toLowerCase().trim();
    const contentHash = _sha256Hex(normalized, 8);
    const summary = item.text.replace(/\n/g, " ").slice(0, 50);

    const priorSummary = sessionCache.get_hint_content_summary?.(contentHash);
    if (priorSummary) {
      // Do not overwrite the stored summary — the original first-seen summary is canonical.
      const stubText = `[tg: dup] ${priorSummary.slice(0, 35)}`;
      result.push({
        text: stubText,
        hint_priority: item.hint_priority,
      });
    } else {
      sessionCache.record_hint_content_seen?.(contentHash, summary);
      result.push(item);
    }
  }

  return result;
}

export function computeStaleThreshold(sessionAgeSecs: number): number {
  return Math.max(900, Math.min(STALE_READ_AGE_SECONDS, sessionAgeSecs * 0.25));
}

export function buildReadHint(_options: {
  session_id?: string;
  file_path: string;
  offset?: number;
  limit?: number;
  cwd?: string;
  cache?: SessionCache | undefined;
  large_file_line_threshold?: number;
}): ReadHint | null {
  try {
    return _buildReadHintInner(_options);
  } catch (exc) {
    _LOG.warn(`build_read_hint: unexpected error for ${_options.file_path}: ${exc}`);
    return null;
  }
}

function _buildReadHintInner(_options: {
  session_id?: string;
  file_path: string;
  offset?: number;
  limit?: number;
  cwd?: string;
  cache?: SessionCache | undefined;
  large_file_line_threshold?: number;
}): ReadHint | null {
  if (!_options.session_id || !_options.file_path) {
    return null;
  }

  return null;
}

export function buildHighFrequencyHint(
  sessionCache: SessionCache | undefined,
  filePath: string,
  options?: {
    threshold?: number;
    resolved_symbol?: string;
  }
): HintItem | null {
  try {
    if (!sessionCache || !filePath) {
      return null;
    }

    const threshold = options?.threshold ?? _HIGH_FREQ_THRESHOLD;
    const count = sessionCache.get_file_access_count?.(filePath) ?? 0;
    if (count < threshold) {
      return null;
    }

    const fname = _sanitizeHintPath(filePath.split(/[/\\]/).pop() ?? "");
    const safePath = _sanitizeHintPath(filePath);
    const sym = options?.resolved_symbol ?? "<symbol>";

    const text = `\`${fname}\` read ${count}x — \`token-goat skeleton ${safePath}\` or \`token-goat read "${safePath}::${sym}"\``;

    return {
      text,
      hint_priority: HINT_PRIORITY_MEDIUM,
    };
  } catch {
    return null;
  }
}

export function buildDiffHint(options: {
  session_id: string;
  file_path: string;
  current_text: string;
}): ReadHint | null {
  try {
    return _buildDiffHintInner(options);
  } catch {
    return null;
  }
}

function _buildDiffHintInner(_options: {
  session_id: string;
  file_path: string;
  current_text: string;
}): ReadHint | null {
  return null;
}

export function buildSymbolStaleHint(options: {
  session_id: string;
  file_path: string;
  symbol_name: string;
  current_start_line: number;
  current_end_line: number;
  current_text: string;
}): string | null {
  if (!options.session_id || !options.file_path || !options.symbol_name) {
    return null;
  }

  try {
    const safeFile = _sanitizeHintPath(options.file_path);
    const safeSym = _sanitizeHintPath(options.symbol_name);

    return `⚠ ${safeFile}::${safeSym} was modified since your last read. The function body may have changed.`;
  } catch {
    _LOG.debug(`build_symbol_stale_hint: unexpected error for ${options.file_path}::${options.symbol_name}`);
    return null;
  }
}

export function buildBashDedupHint(options: {
  session_id: string;
  command: string;
  cache?: SessionCache | undefined;
  cwd?: string;
}): ReadHint | null {
  try {
    const { session_id, command, cache } = options;

    if (!session_id || !command || !cache) {
      return null;
    }

    const cmdShort = _formatBashCommandForHint(command);
    const hint = `\`${cmdShort}\` cached. Use \`token-goat bash-output\` to retrieve.`;

    return (hint + "") as ReadHint;
  } catch {
    return null;
  }
}

export function buildBashCacheHitHint(_options: {
  session_id: string;
  command: string;
  cache?: SessionCache | undefined;
  cwd?: string;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildGrepDedupHint(_options: {
  session_id: string;
  pattern: string;
  path?: string;
  cache?: SessionCache | undefined;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildGlobDedupHint(_options: {
  session_id: string;
  pattern: string;
  path?: string;
  cache?: SessionCache | undefined;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildWebDedupHint(_options: {
  session_id: string;
  url: string;
  cache?: SessionCache | undefined;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildWebCacheHitHint(_options: {
  session_id: string;
  url: string;
  cache?: SessionCache | undefined;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildUnchangedFileHint(_options: {
  session_id: string;
  file_path: string;
  cache?: SessionCache | undefined;
}): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildIndexOnlyFileHint(options: {
  file_path: string;
  offset?: object | null;
  limit?: object | null;
}): ReadHint | null {
  try {
    const hasOffset = options.offset !== null && options.offset !== undefined && typeof options.offset === "number" && options.offset >= 0;
    const hasLimit = options.limit !== null && options.limit !== undefined && typeof options.limit === "number" && options.limit > 0;

    if (hasOffset && hasLimit) {
      return null;
    }

    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const basenameLower = fname.toLowerCase();

    if (!_INDEX_ONLY_LOCKFILE_NAMES.has(basenameLower)) {
      return null;
    }

    const hint = `\`${fname}\` is a lockfile. Use grep or package manager commands instead.`;
    return (hint + "") as ReadHint;
  } catch {
    return null;
  }
}

export function buildStructuredFileHint(options: {
  file_path: string;
  offset?: object | null;
  limit?: object | null;
}): ReadHint | null {
  try {
    const hasOffset = options.offset !== null && options.offset !== undefined && typeof options.offset === "number" && options.offset >= 0;
    const hasLimit = options.limit !== null && options.limit !== undefined && typeof options.limit === "number" && options.limit > 0;

    if (hasOffset && hasLimit) {
      return null;
    }

    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const ext = fname.substring(fname.lastIndexOf(".")).toLowerCase();

    if (![".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".toml"].includes(ext)) {
      return null;
    }

    const hint = `\`${fname}\` is a structured file. Use \`token-goat section\` or surgical reads.`;
    return (hint + "") as ReadHint;
  } catch {
    return null;
  }
}

export function buildTestFileHint(
  testFilePath: string,
  sessionCache: SessionCache | undefined,
  _projectRoot: string
): HintItem | null {
  try {
    if (!sessionCache) {
      return null;
    }

    const fname = testFilePath.split(/[/\\]/).pop() ?? "";
    const isTestFile = fname.toLowerCase().startsWith("test_") || testFilePath.toLowerCase().includes("tests");

    if (!isTestFile) {
      return null;
    }

    const text = `Test file \`${fname}\` — consider reading the implementation first.`;
    return {
      text,
      hint_priority: HINT_PRIORITY_LOW,
    };
  } catch {
    return null;
  }
}

export function buildPinnedHint(
  sessionCache: SessionCache | undefined,
  filePath: string,
  symbolName: string
): HintItem | null {
  try {
    if (!sessionCache || !symbolName) {
      return null;
    }

    const pinned = sessionCache.pinned_symbols ?? [];
    if (pinned.length === 0) {
      return null;
    }

    const spec = `${filePath}::${symbolName}`;
    if (pinned.includes(spec)) {
      const text = `Pinned: \`${spec}\` — always prioritized.`;
      return {
        text,
        hint_priority: HINT_PRIORITY_CRITICAL,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function buildDocCompactHint(
  _filePath: string,
  _cwd: string | undefined,
  _opts?: { cache?: SessionCache | undefined }
): ReadHint | null {
  try {
    return null;
  } catch {
    return null;
  }
}

export function buildScopedDiffHint(outputBytes: number, editedFiles: string[]): string {
  const kb = outputBytes / 1024;
  const shown = editedFiles.slice(0, 5);
  const overflow = editedFiles.length - shown.length;
  const fileArgs = shown.join(" ");
  const n = editedFiles.length;
  const cmdLine = `  git diff -- ${fileArgs}`;
  const overflowNote = overflow > 0 ? `\n  (+${overflow} more)` : "";
  return (
    `[tg] Large diff (${kb.toFixed(1)} KB, ${n} file(s)) — scope:\n` +
    `${cmdLine}${overflowNote}`
  );
}

export function maybeGrepAdvisory(
  path: string,
  _sessionCache: SessionCache | undefined,
  _cwd?: string | undefined
): string | null {
  try {
    if (!path || path === "-") {
      return null;
    }

    const fname = _sanitizeHintPath(path.split(/[/\\]/).pop() ?? "");
    return `[tg] Grepped '${fname}' multiple times — consider reading the file instead.`;
  } catch {
    return null;
  }
}

function _sanitizeHintPath(path: string): string {
  if (typeof path !== "string") {
    return "???";
  }
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\x00]/g, "").slice(0, 200);
}

function _sha256Hex(text: string, chars: number = 8): string {
  const hash = createHash("sha256").update(text).digest("hex");
  return hash.slice(0, chars);
}

function _formatBashCommandForHint(command: string): string {
  const safe = _sanitizeHintPath(command);

  if (safe.length <= _MAX_BASH_COMMAND_DISPLAY_LEN) {
    return safe;
  }

  const parts = safe.split(/\s+/);
  if (parts.length === 0) {
    return safe;
  }

  const resultParts: string[] = [];
  let currentLen = 0;

  for (const part of parts) {
    const sep = resultParts.length > 0 ? " " : "";
    const candidateLen = currentLen + sep.length + part.length;

    if (candidateLen > _MAX_BASH_COMMAND_DISPLAY_LEN) {
      break;
    }

    resultParts.push(part);
    currentLen = candidateLen;
  }

  let result = resultParts.join(" ");

  if (result !== safe) {
    result = result + "…";
  }

  return result;
}

function _estTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}
