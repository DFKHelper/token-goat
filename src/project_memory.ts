/** Per-project persistent key-value memory for session-start context injection. Stored as TOML for reads at startup. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir } from './constants.js';
import { findProject } from './project.js';
import { atomicWriteText, ensureDirSync, LOCK_WAIT_MS_HARDENED, sleepSync, withFileLock, withRetryOnLock } from './util.js';

const MAX_ENTRIES = 30;
const MAX_VALUE_LEN = 300;
const MAX_TOTAL_CHARS = 4000;
const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

// Ordinal (not locale-aware) sort -- an unlocaled localeCompare() orders differently across Node's small-icu vs full-icu builds and different system default locales, which would make key ordering (and thus setEntry's eviction and buildInjection's display order) nondeterministic across machines/CI runners.
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Return the TOML file path for this project's memory entries. */
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

/** Simple TOML parser for key=value format (no nested tables). The 1-based number of every line that is neither blank, a comment, nor an entry is pushed onto `unparsed`. */
function parseTOML(content: string, unparsed: number[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [i, line] of content.split('\n').entries()) {
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
    } else {
      unparsed.push(i + 1);
    }
  }
  return result;
}

/** Read and parse the TOML file. An absent file is no entries; a read that fails any other way throws, because setEntry and unsetEntry save what this returns, and answering "no entries" to a scanner briefly holding a just-written file made them replace every note with the one they were changing. That brief lock is retried first. For the same reason `forUpdate` refuses a file with a line the parser cannot read, such as a value a hand edit continued onto a second line: a read skips it, and a save of what was read would delete it. */
function loadRaw(filePath: string, forUpdate = false): Record<string, string> {
  let content = '';
  try {
    withRetryOnLock(() => {
      content = fs.readFileSync(filePath, 'utf-8');
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return {};
    throw err;
  }
  const unparsed: number[] = [];
  const entries = parseTOML(content, unparsed);
  if (forUpdate && unparsed.length > 0) {
    const one = unparsed.length === 1;
    throw new Error(`Not updating ${filePath}: ${one ? 'line' : 'lines'} ${unparsed.join(', ')} ${one ? 'is' : 'are'} not in the key = "value" form, and saving would drop ${one ? 'it' : 'them'}. Fix or remove ${one ? 'it' : 'them'}, then try again.`);
  }
  return entries;
}

/** Serialize entries to TOML and write atomically. */
function save(filePath: string, entries: Record<string, string>): void {
  const lines: string[] = [];
  const sorted = Object.entries(entries).sort(([a], [b]) => ordinal(a, b));
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

/** Return all memory entries for project_hash: an empty dict when it has none, an error when its file cannot be read, so `note list` never reports "(no notes set)" for notes it could not open. */
export function loadEntries(projectHash: string): Record<string, string> {
  return loadRaw(memoryPath(projectHash));
}

/** Set key to value in this project's memory. Enforces MAX_ENTRIES by evicting alphabetically-last entries to make room for new entries. */
export function setEntry(projectHash: string, key: string, value: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const dir = path.dirname(p);
  ensureDirSync(dir);

  // load-modify-save is a read-modify-write race: two concurrent `token-goat note` calls for the same project could each read the same pre-write state and the second save() would silently clobber the first's entry. Lock the critical section, same as session_store.ts's saveSessionState and config_commands.ts's `config set`, through {@link underNotesLock}, which refuses rather than run the update unlocked. withFileLock returns `undefined` both when fn() could not be run (lock unobtainable) and, indistinguishably, when fn() itself legitimately returns undefined -- so fn must return a non-undefined sentinel or a successful run is misread as a failed acquire and re-run a second time (doubling every write). Mirrors session_store.ts's writeMerged: (): true.
  const doSet = (): true => {
    const entries = loadRaw(p, true);

    // If this is a new key and we're at capacity, evict alphabetically-last entries to make room. This ensures that newly-added entries are never silently dropped by buildInjection's alphabetical truncation.
    const isNewKey = !(key in entries);
    if (isNewKey && Object.keys(entries).length >= MAX_ENTRIES) {
      const keysToKeep = MAX_ENTRIES - 1;
      const allKeys = Object.keys(entries).sort((a, b) => ordinal(a, b));
      for (const k of allKeys.slice(keysToKeep)) {
        delete entries[k];
      }
    }

    entries[key] = value;
    save(p, entries);
    return true;
  };
  underNotesLock(p, doSet);
}

/** Run a load-modify-save of the notes file at `p` holding its lock, or throw having changed nothing. withFileLock answers `undefined` both for a lock it waited on and never got and for one it could not create at all, and these updates used to run anyway on that answer: the unlocked read-modify-write the lock exists to prevent, where a concurrent writer's note is lost to whichever save lands last. A lock that could not be created is retried briefly, since a scanner holding the directory entry fails the create for a moment; a lock still held by a live process after the long wait is not, because waiting again would not change the answer. */
function underNotesLock(p: string, update: () => true): void {
  const lockPath = `${p}.lock`;
  // The lock lives beside the file, so a project with no notes yet needs the directory before it can be locked at all.
  ensureDirSync(path.dirname(p));
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (withFileLock(lockPath, update, { waitMs: LOCK_WAIT_MS_HARDENED }) !== undefined) return;
    if (fs.existsSync(lockPath)) break;
    if (attempt < 3) sleepSync(50 * attempt);
  }
  throw new Error(`Could not lock ${p} for writing; no note was changed. Another token-goat process may be writing notes: try again.`);
}

/** Remove key from this project's memory (no-op if absent). */
export function unsetEntry(projectHash: string, key: string): void {
  validateKey(key);
  const p = memoryPath(projectHash);
  const doUnset = (): true => {
    const entries = loadRaw(p, true);
    if (key in entries) {
      delete entries[key];
      save(p, entries);
    }
    return true;
  };
  underNotesLock(p, doUnset);
}

/** Remove all memory entries for project_hash. */
export function clearAll(projectHash: string): void {
  const p = memoryPath(projectHash);
  const doClear = (): true => {
    if (fs.existsSync(p)) {
      save(p, {});
    }
    return true;
  };
  underNotesLock(p, doClear);
}

/** Build a compact Markdown block of memory entries for session-start injection. Returns null when no entries stored. */
export function buildInjection(projectHash: string): string | null {
  try {
    const entries = loadEntries(projectHash);
    if (Object.keys(entries).length === 0) {
      return null;
    }

    const header = '### Project notes (`token-goat note set <key> "<finding>"`)';
    const lines: string[] = [header];
    let total = header.length;
    let skipped = 0;

    // Explicit localeCompare sort, not raw Object.entries() order: JS engines enumerate canonical-integer-string keys (e.g. "9", "10") in ascending numeric order regardless of insertion order, which would silently diverge from the alphabetical order setEntry's eviction logic above assumes this function iterates in.
    const entries_list = Object.entries(entries)
      .sort(([a], [b]) => ordinal(a, b))
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

    // The trailer itself counts against MAX_TOTAL_CHARS too -- pop entries back off until it fits, so the returned string never exceeds the bound the whole function exists to enforce.
    if (skipped > 0) {
      while (
        lines.length > 1 &&
        total + `- (+${skipped} more memory entries omitted -- total size limit reached)`.length + 1 > MAX_TOTAL_CHARS
      ) {
        const popped = lines.pop() as string;
        total -= popped.length + 1;
        skipped++;
      }
      lines.push(`- (+${skipped} more memory entries omitted -- total size limit reached)`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

/** The notes block for the project containing `cwd`, or null when `cwd` is in no project, the project has no notes, or the lookup fails. Session start and the compaction manifest both carry it, since a finding recorded with `note set` exists precisely to outlive the context it was found in, and both run on hook paths that must never throw. */
export function projectNotesFor(cwd: string | undefined): string | null {
  if (cwd === undefined) return null;
  try {
    const project = findProject(cwd);
    return project === null ? null : buildInjection(project.hash);
  } catch {
    return null;
  }
}
