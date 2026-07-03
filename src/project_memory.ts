/**
 * Per-project persistent key-value memory for session-start context injection.
 * Stored as TOML for reads at startup.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteText, ensureDirSync } from './util.js';

const MAX_ENTRIES = 30;
const MAX_VALUE_LEN = 300;
const MAX_TOTAL_CHARS = 4000;
const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Return the TOML file path for this project's memory entries.
 */
export function memoryPath(projectHash: string): string {
  // Import paths dynamically to avoid circular dependency at startup
  // os.homedir() (not a manual HOME/USERPROFILE-only check) matches the convention used by
  // tokenGoatHome() in disk_cache.ts: it never silently degrades to a relative '.' path when
  // both env vars are unset.
  const dataDir = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
  return path.join(dataDir, 'token-goat', 'projects', `${projectHash}_memory.toml`);
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

  // Atomic write via the shared helper (unique pid+hrtime temp filename, retries on transient
  // Windows file-lock errors) instead of a hand-rolled fixed `.tmp` name that two concurrent
  // processes writing the same project's memory file could collide on.
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
 */
export function setEntry(projectHash: string, key: string, value: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const dir = path.dirname(p);
  ensureDirSync(dir);
  const entries = loadRaw(p);
  entries[key] = value;
  save(p, entries);
}

/**
 * Remove key from this project's memory (no-op if absent).
 */
export function unsetEntry(projectHash: string, key: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const entries = loadRaw(p);
  if (!(key in entries)) {
    return;
  }
  delete entries[key];
  save(p, entries);
}

/**
 * Remove all memory entries for project_hash.
 */
export function clearAll(projectHash: string): void {
  const p = memoryPath(projectHash);
  if (fs.existsSync(p)) {
    save(p, {});
  }
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

    const entries_list = Object.entries(entries).slice(0, MAX_ENTRIES);
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

    if (skipped > 0) {
      lines.push(`- (+${skipped} more memory entries omitted — total size limit reached)`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
