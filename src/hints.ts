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

export interface HintItem {
  text: string;
  hint_priority: number;
}

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

  if (maxHints <= 0) return [];
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

export function buildPackageManifestHint(options: {
  file_path: string;
  offset?: number | null;
  limit?: number | null;
}): HintItem | null {
  try {
    const hasOffset =
      options.offset !== null && options.offset !== undefined && options.offset >= 0
    const hasLimit =
      options.limit !== null && options.limit !== undefined && options.limit > 0

    if (hasOffset || hasLimit) {
      return null;
    }

    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const basenameLower = fname.toLowerCase();

    if (basenameLower === "package.json") {
      const text = `\`${fname}\` is a package manifest. Consider \`token-goat section package.json::dependencies\` or \`token-goat section package.json::devDependencies\` for focused reads.`;
      return {
        text,
        hint_priority: HINT_PRIORITY_MEDIUM,
      };
    }

    if (basenameLower === "package-lock.json") {
      const text = `\`${fname}\` is a large lockfile. Consider \`npm ls\`, \`npm outdated\`, or \`npm audit\` instead for targeted info.`;
      return {
        text,
        hint_priority: HINT_PRIORITY_MEDIUM,
      };
    }

    return null;
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
