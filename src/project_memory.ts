/**
 * Per-project persistent key-value memory for session-start context injection.
 * Stored as TOML for reads at startup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir } from './constants.js';
import { atomicWriteText, ensureDirSync, withFileLock } from './util.js';

const MAX_ENTRIES = 30;
const MAX_VALUE_LEN = 300;
const MAX_TOTAL_CHARS = 4000;
const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Return the TOML file path for this project's memory entries.
 */
export function memoryPath(projectHash: string): string {
  // Uses the shared platform-aware data-dir resolver (constants.ts::dataDir), which branches Windows (%LOCALAPPDATA%\dfk-helper\token-goat) vs macOS (~/Library/Application Support/token-goat) vs Linux XDG, and validates any env-var override via safeEnvDir before using it. constants.ts is a dependency-free leaf module (only imports version.js), so there is no circular-dependency risk here.
  return path.join(dataDir(), 'projects', `${projectHash}_memory.toml`);
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `Invalid memory key ${JSON.stringify(key)}: use only letters, digits, hyphens, underscores (max 80 chars)`
    );
  }
}

/**
 * Simple TOML parser for key=value format (no nested tables).
 */
function parseTOML(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"(.*)"\s*$/);
    if (match) {
      const [, key, value] = match;
      if (key && value !== undefined) {
        // Unescape TOML string escapes in a single pass to avoid sequential-replace interference (e.g. "a\\nb" → "a\nb" not "a\<NL>b").
        const unescaped = value.replace(/\\([\\nrt"])/g, (_, c: string) => {
          switch (c) {
            case '\\': return '\\'
            case 'n': return '\n'
            case 'r': return '\r'
            case '"': return '"'
            default: return _
          }
        });
        result[key] = unescaped;
      }
    }
  }
  return result;
}

/**
 * Read and parse the TOML file; return empty dict on failure.
 */
function loadRaw(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseTOML(content);
  } catch {
    return {};
  }
}

/**
 * Serialize entries to TOML and write atomically.
 */
function save(filePath: string, entries: Record<string, string>): void {
  const lines: string[] = [];
  const sorted = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of sorted) {
    const escaped = v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    lines.push(`${k} = "${escaped}"`);
  }

  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
  const dir = path.dirname(filePath);
  ensureDirSync(dir);

  // Atomic write via the shared helper (unique pid+hrtime temp filename, retries on transient Windows file-lock errors) instead of a hand-rolled fixed `.tmp` name that two concurrent processes writing the same project's memory file could collide on.
  atomicWriteText(filePath, content);
}

/**
 * Return all memory entries for project_hash, or empty dict.
 */
export function loadEntries(projectHash: string): Record<string, string> {
  return loadRaw(memoryPath(projectHash));
}

/**
 * Set key to value in this project's memory.
 * Enforces MAX_ENTRIES by evicting alphabetically-last entries to make room for new entries.
 */
export function setEntry(projectHash: string, key: string, value: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const dir = path.dirname(p);
  ensureDirSync(dir);

  // load-modify-save is a read-modify-write race: two concurrent `token-goat note` calls for the same project could each read the same pre-write state and the second save() would silently clobber the first's entry. Lock the critical section, same as session_store.ts's saveSessionState and config_commands.ts's `config set`; fall back to unprotected on a failed acquire (e.g. missing dir) rather than blocking this low-frequency CLI path forever. withFileLock returns `undefined` both when fn() could not be run (lock unobtainable) and, indistinguishably, when fn() itself legitimately returns undefined -- so fn must return a non-undefined sentinel or a successful run is misread as a failed acquire and re-run a second time (doubling every write). Mirrors session_store.ts's writeMerged: (): true.
  const doSet = (): true => {
    const entries = loadRaw(p);

    // If this is a new key and we're at capacity, evict alphabetically-last entries to make room. This ensures that newly-added entries are never silently dropped by buildInjection's alphabetical truncation.
    const isNewKey = !(key in entries);
    if (isNewKey && Object.keys(entries).length >= MAX_ENTRIES) {
      const keysToKeep = MAX_ENTRIES - 1;
      const allKeys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
      for (const k of allKeys.slice(keysToKeep)) {
        delete entries[k];
      }
    }

    entries[key] = value;
    save(p, entries);
    return true;
  };
  if (withFileLock(`${p}.lock`, doSet) === undefined) doSet();
}

/**
 * Remove key from this project's memory (no-op if absent).
 */
export function unsetEntry(projectHash: string, key: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const doUnset = (): true => {
    const entries = loadRaw(p);
    if (key in entries) {
      delete entries[key];
      save(p, entries);
    }
    return true;
  };
  if (withFileLock(`${p}.lock`, doUnset) === undefined) doUnset();
}

/**
 * Remove all memory entries for project_hash.
 */
export function clearAll(projectHash: string): void {
  const p = memoryPath(projectHash);
  const doClear = (): true => {
    if (fs.existsSync(p)) {
      save(p, {});
    }
    return true;
  };
  if (withFileLock(`${p}.lock`, doClear) === undefined) doClear();
}

/**
 * Build a compact Markdown block of memory entries for session-start injection.
 * Returns null when no entries stored.
 */
export function buildInjection(projectHash: string): string | null {
  try {
    const entries = loadEntries(projectHash);
    if (Object.keys(entries).length === 0) {
      return null;
    }

    const header = '## Project Memory';
    const lines: string[] = [header];
    let total = header.length;
    let skipped = 0;

    // Explicit localeCompare sort, not raw Object.entries() order: JS engines enumerate canonical-integer-string keys (e.g. "9", "10") in ascending numeric order regardless of insertion order, which would silently diverge from the alphabetical order setEntry's eviction logic above assumes this function iterates in.
    const entries_list = Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES);
    for (const [key, val] of entries_list) {
      const display = val.length <= MAX_VALUE_LEN ? val : val.slice(0, MAX_VALUE_LEN) + '…';
      const line = `- **${key}**: ${display}`;
      if (total + line.length + 1 > MAX_TOTAL_CHARS) {
        skipped++;
        continue;
      }
      lines.push(line);
      total += line.length + 1;
    }

    // The trailer itself counts against MAX_TOTAL_CHARS too -- pop entries back off until it
    // fits, so the returned string never exceeds the bound the whole function exists to enforce.
    if (skipped > 0) {
      while (
        lines.length > 1 &&
        total + `- (+${skipped} more memory entries omitted — total size limit reached)`.length + 1 > MAX_TOTAL_CHARS
      ) {
        const popped = lines.pop() as string;
        total -= popped.length + 1;
        skipped++;
      }
      lines.push(`- (+${skipped} more memory entries omitted — total size limit reached)`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
