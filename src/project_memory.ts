/** Per-project persistent key-value memory for session-start context injection. Stored as TOML for reads at startup. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir } from './constants.js';
import { findProject } from './project.js';
import { fenceUntrustedFileContent } from './injection_scan.js';
import { formatAge } from './skill_cache.js';
import { atomicWriteText, ensureDirSync, LOCK_WAIT_MS_HARDENED, sleepSync, withFileLock, withRetryOnLock } from './util.js';

export const MAX_ENTRIES = 30;
const MAX_VALUE_LEN = 300;
const MAX_TOTAL_CHARS = 4000;
const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
// A note's set time is a comment on the line before its entry, because older binaries share this file and skip `#` lines, where any other new line shape would land in their unparsed list and make them refuse every later update. Only the shape `new Date().toISOString()` writes is read as a time.
const SET_AT_RE = /^#\s*set\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/;

/** A note's value and, when its file records one, the ISO 8601 UTC time setEntry last wrote it. A note written before notes carried a time, or saved since by a binary that drops the comment, has none. */
export interface NoteEntry {
  value: string;
  setAt?: string;
}

/** An empty map for notes keyed by user-supplied names. KEY_RE admits `__proto__`, `constructor`, `toString` and the rest of Object.prototype's names; on a plain object the first is dropped on assignment and the others answer `in` without ever being set. Membership is still tested with Object.hasOwn. */
function noteMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

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

/** Simple TOML parser for key=value format (no nested tables). The 1-based number of every line that is neither blank, a comment, nor an entry is pushed onto `unparsed`. A `# set <ISO time>` comment dates the next entry line only, recorded in `setAt`; an entry with none, or with a time that does not parse, is undated there. */
function parseTOML(content: string, unparsed: number[] = [], setAt = new Map<string, string>()): Record<string, string> {
  const result = noteMap<string>();
  let pendingSetAt: string | undefined;
  for (const [i, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('#')) {
      const time = SET_AT_RE.exec(trimmed)?.[1];
      if (time !== undefined && !Number.isNaN(Date.parse(time))) pendingSetAt = time;
      continue;
    }
    const entrySetAt = pendingSetAt;
    pendingSetAt = undefined;
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
        if (entrySetAt === undefined) setAt.delete(key);
        else setAt.set(key, entrySetAt);
      }
    } else {
      unparsed.push(i + 1);
    }
  }
  return result;
}

/** Read and parse the TOML file. An absent file is no entries; a read that fails any other way throws, because setEntry and unsetEntry save what this returns, and answering "no entries" to a scanner briefly holding a just-written file made them replace every note with the one they were changing. That brief lock is retried first. For the same reason `forUpdate` refuses a file with a line the parser cannot read, such as a value a hand edit continued onto a second line: a read skips it, and a save of what was read would delete it. */
function loadRaw(filePath: string, forUpdate = false, setAt?: Map<string, string>): Record<string, string> {
  let content = '';
  try {
    withRetryOnLock(() => {
      content = fs.readFileSync(filePath, 'utf-8');
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return noteMap<string>();
    throw err;
  }
  const unparsed: number[] = [];
  const entries = parseTOML(content, unparsed, setAt);
  if (forUpdate && unparsed.length > 0) {
    const one = unparsed.length === 1;
    throw new Error(`Not updating ${filePath}: ${one ? 'line' : 'lines'} ${unparsed.join(', ')} ${one ? 'is' : 'are'} not in the key = "value" form, and saving would drop ${one ? 'it' : 'them'}. Fix or remove ${one ? 'it' : 'them'}, then try again.`);
  }
  return entries;
}

/** Serialize entries to TOML and write atomically, each dated entry preceded by its `# set <ISO time>` comment. */
function save(filePath: string, entries: Record<string, string>, setAt = new Map<string, string>()): void {
  const lines: string[] = [];
  const sorted = Object.entries(entries).sort(([a], [b]) => ordinal(a, b));
  for (const [k, v] of sorted) {
    const escaped = v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    const time = setAt.get(k);
    if (time !== undefined) lines.push(`# set ${time}`);
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

/** Like {@link loadEntries}, in the same key order, with each note's set time when its file records one. */
export function loadDatedEntries(projectHash: string): Record<string, NoteEntry> {
  const setAt = new Map<string, string>();
  const entries = loadRaw(memoryPath(projectHash), false, setAt);
  const result = noteMap<NoteEntry>();
  for (const [key, value] of Object.entries(entries)) {
    const time = setAt.get(key);
    result[key] = time === undefined ? { value } : { value, setAt: time };
  }
  return result;
}

/** ` (set 3h ago)` for a dated note, measured against `now`; empty for an undated one. A time ahead of `now`, from a clock that moved back, reads as 0s. */
export function noteAgeLabel(note: NoteEntry, now = Date.now()): string {
  if (note.setAt === undefined) return '';
  return ` (set ${formatAge(Math.max(0, now - Date.parse(note.setAt)))} ago)`;
}

/** Order notes newest-set first, then undated ones in ordinal key order; dated notes set in the same millisecond also fall back to ordinal order. setEntry evicts from the tail of this order and buildInjection prints from its head, so the note dropped at capacity and the note omitted at the size cap are both the oldest. */
function byRecency(a: string, aSetAt: string | undefined, b: string, bSetAt: string | undefined): number {
  const ta = aSetAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(aSetAt);
  const tb = bSetAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(bSetAt);
  return ta !== tb ? (ta > tb ? -1 : 1) : ordinal(a, b);
}

/** What a `note set` displaced: the key's old value when it already existed, and the keys evicted to stay within MAX_ENTRIES. */
export interface SetResult {
  previous?: string;
  evicted: string[];
}

/** Set key to value in this project's memory, stamped with the current time. Enforces MAX_ENTRIES by evicting the oldest-set entries to make room for new entries; undated entries count as older than any dated one, and among them the alphabetically last goes first. */
export function setEntry(projectHash: string, key: string, value: string): SetResult {
  validateKey(key);
  const p = memoryPath(projectHash);
  const dir = path.dirname(p);
  ensureDirSync(dir);

  // load-modify-save is a read-modify-write race: two concurrent `token-goat note` calls for the same project could each read the same pre-write state and the second save() would silently clobber the first's entry. Lock the critical section, same as session_store.ts's saveSessionState and config_commands.ts's `config set`, through {@link underNotesLock}, which refuses rather than run the update unlocked. withFileLock returns `undefined` both when fn() could not be run (lock unobtainable) and, indistinguishably, when fn() itself legitimately returns undefined -- so fn must return a non-undefined sentinel or a successful run is misread as a failed acquire and re-run a second time (doubling every write). Mirrors session_store.ts's writeMerged: (): true.
  const result: SetResult = { evicted: [] };
  const doSet = (): true => {
    const setAt = new Map<string, string>();
    const entries = loadRaw(p, true, setAt);
    // Read under the lock, so the value reported as replaced is the one this write actually overwrote, even when another process set the key a moment earlier.
    const old = Object.hasOwn(entries, key) ? entries[key] : undefined;
    if (old !== undefined) result.previous = old;

    // If this is a new key and we're at capacity, evict the oldest-set entries to make room: the same notes buildInjection's newest-first order would omit first at its size cap.
    const isNewKey = !Object.hasOwn(entries, key);
    if (isNewKey && Object.keys(entries).length >= MAX_ENTRIES) {
      const keysToKeep = MAX_ENTRIES - 1;
      const allKeys = Object.keys(entries).sort((a, b) => byRecency(a, setAt.get(a), b, setAt.get(b)));
      for (const k of allKeys.slice(keysToKeep)) {
        result.evicted.push(k);
        delete entries[k];
        setAt.delete(k);
      }
    }

    entries[key] = value;
    setAt.set(key, new Date().toISOString());
    save(p, entries, setAt);
    return true;
  };
  underNotesLock(p, doSet);
  return result;
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
    const setAt = new Map<string, string>();
    const entries = loadRaw(p, true, setAt);
    if (Object.hasOwn(entries, key)) {
      delete entries[key];
      save(p, entries, setAt);
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
    const entries = loadDatedEntries(projectHash);
    if (Object.keys(entries).length === 0) {
      return null;
    }
    const now = Date.now();

    const header = '### Project notes (`token-goat note set <key> "<finding>"`)';
    // The notes are fenced as data: anything that can write the notes file (a repo script, a tool the agent ran, a hand edit) otherwise speaks in the session's own voice at every start. The header and the trailer are token-goat's words and stay outside the fence.
    const render = (shown: string[], skipped: number): string => {
      const parts = [header];
      if (shown.length > 0) parts.push(fenceUntrustedFileContent(shown.join('\n')));
      if (skipped > 0) parts.push(`- (+${skipped} more memory entries omitted)`);
      return parts.join('\n');
    };

    // Newest-set first, undated after in ordinal order, so the size cap below omits the oldest notes, the ones setEntry evicts first. An explicit sort, not raw Object.entries() order: JS engines enumerate canonical-integer-string keys (e.g. "9", "10") in ascending numeric order regardless of insertion order. The age marker is part of each line, so the cap counts it.
    const entries_list = Object.entries(entries).sort(([a, na], [b, nb]) => byRecency(a, na.setAt, b, nb.setAt));
    // Stop at the first note that does not fit rather than skipping it for a shorter one further down, which would show an older note in place of a newer one. Everything not shown, including notes past the first MAX_ENTRIES of a hand-edited file, is counted in the trailer. Each candidate is measured as the block that would be returned if it were the last note shown -- fence, whatever neutralizing the fence does to a note, and the trailer counting the rest -- so the block returned below is always one already measured against the cap.
    const shown: string[] = [];
    for (const [key, note] of entries_list.slice(0, MAX_ENTRIES)) {
      const val = note.value;
      const display = val.length <= MAX_VALUE_LEN ? val : val.slice(0, MAX_VALUE_LEN) + '…';
      const line = `- **${key}**${noteAgeLabel(note, now)}: ${display}`;
      if (render([...shown, line], entries_list.length - shown.length - 1).length > MAX_TOTAL_CHARS) break;
      shown.push(line);
    }

    return render(shown, entries_list.length - shown.length);
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
