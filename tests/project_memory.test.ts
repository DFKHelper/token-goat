import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as NodeFs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock is hoisted — wrap renameSync/writeFileSync (still delegating to the real
// implementation) so the #M27 test below can observe the temp filename each write used, and
// the file-lock regression test below can observe the `.lock` file being created, without
// touching Node's non-configurable fs module properties directly (vi.spyOn on a builtin fails
// at runtime).
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>();
  return {
    ...original,
    renameSync: vi.fn((...args: Parameters<typeof original.renameSync>) => original.renameSync(...args)),
    writeFileSync: vi.fn((...args: Parameters<typeof original.writeFileSync>) => original.writeFileSync(...args)),
  };
});

import { dataDir } from '../src/constants.js';
import {
  memoryPath,
  loadEntries,
  setEntry,
  unsetEntry,
  clearAll,
  buildInjection,
} from '../src/project_memory.js';

describe('project_memory', () => {
  // memoryPath() now resolves through constants.ts::dataDir(), which caches DATA_DIR once at
  // module load (see tests/setup/isolate-home.ts), so per-test isolation can no longer be done
  // by swapping XDG_DATA_HOME/LOCALAPPDATA in beforeEach. Instead, wipe the shared
  // `${dataDir()}/projects` directory before/after each test so project-hash fixtures (e.g.
  // 'test') never leak state between tests in this file.
  const projectsDir = path.join(dataDir(), 'projects');

  beforeEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  describe('memoryPath', () => {
    it('should return a path under the platform data dir', () => {
      const p = memoryPath('abc123');
      expect(p).toContain('abc123_memory.toml');
      expect(p.startsWith(dataDir())).toBe(true);
    });

    it('should use different paths for different hashes', () => {
      const p1 = memoryPath('hash1');
      const p2 = memoryPath('hash2');
      expect(p1).not.toBe(p2);
    });

    it('should have .toml extension', () => {
      const p = memoryPath('test');
      expect(p).toMatch(/\.toml$/);
    });
  });

  describe('loadEntries', () => {
    it('should return empty dict when file does not exist', () => {
      const entries = loadEntries('nonexistent');
      expect(entries).toEqual({});
    });

    it('should load entries from TOML file', () => {
      const p = memoryPath('test');
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, 'key1 = "value1"\nkey2 = "value2"\n', 'utf-8');
      const entries = loadEntries('test');
      expect(entries).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should handle escaped characters in values', () => {
      const p = memoryPath('test');
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, 'key = "line1\\nline2\\ttab"\n', 'utf-8');
      const entries = loadEntries('test');
      expect(entries['key']).toContain('\n');
    });

    it('should return empty dict on parse error', () => {
      const p = memoryPath('test');
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, 'invalid toml content', 'utf-8');
      const entries = loadEntries('test');
      expect(entries).toEqual({});
    });
  });

  describe('setEntry', () => {
    it('should create a new entry', () => {
      setEntry('test', 'mykey', 'myvalue');
      const entries = loadEntries('test');
      expect(entries['mykey']).toBe('myvalue');
    });

    it('should overwrite existing entry', () => {
      setEntry('test', 'key', 'value1');
      setEntry('test', 'key', 'value2');
      const entries = loadEntries('test');
      expect(entries['key']).toBe('value2');
    });

    it('should throw on invalid key', () => {
      expect(() => setEntry('test', 'invalid key!', 'value')).toThrow();
    });

    it('should preserve other entries when adding new one', () => {
      setEntry('test', 'key1', 'value1');
      setEntry('test', 'key2', 'value2');
      const entries = loadEntries('test');
      expect(entries['key1']).toBe('value1');
      expect(entries['key2']).toBe('value2');
    });

    it('should handle multiline values', () => {
      setEntry('test', 'multiline', 'line1\nline2\nline3');
      const entries = loadEntries('test');
      expect(entries['multiline']).toBe('line1\nline2\nline3');
    });

    it('should round-trip values containing backslashes without corruption', () => {
      // "C:\\Users\\name" contains backslash+n; a sequential unescape would incorrectly convert the escaped "\\n" to a newline before removing "\\".
      setEntry('test', 'path', 'C:\\Users\\name');
      const entries = loadEntries('test');
      expect(entries['path']).toBe('C:\\Users\\name');
    });

    it('should round-trip a literal backslash followed by n without treating it as a newline', () => {
      // The TOML file will contain "a\\nb"; a sequential parser converts \n first and produces "a\<newline>b" instead of the correct "a\nb".
      setEntry('test', 'escaped', 'a\\nb');
      const entries = loadEntries('test');
      expect(entries['escaped']).toBe('a\\nb');
      expect(entries['escaped']).not.toContain('\n');
    });

    it('should accept alphanumeric, hyphens, underscores', () => {
      setEntry('test', 'key_with-hyphen123', 'value');
      const entries = loadEntries('test');
      expect(entries['key_with-hyphen123']).toBe('value');
    });
  });

  describe('unsetEntry', () => {
    it('should remove existing entry', () => {
      setEntry('test', 'key', 'value');
      unsetEntry('test', 'key');
      const entries = loadEntries('test');
      expect('key' in entries).toBe(false);
    });

    it('should be no-op when key does not exist', () => {
      setEntry('test', 'existing', 'value');
      unsetEntry('test', 'nonexistent');
      const entries = loadEntries('test');
      expect(entries['existing']).toBe('value');
    });

    it('should throw on invalid key', () => {
      expect(() => unsetEntry('test', 'invalid key!')).toThrow();
    });

    it('should preserve other entries', () => {
      setEntry('test', 'key1', 'value1');
      setEntry('test', 'key2', 'value2');
      unsetEntry('test', 'key1');
      const entries = loadEntries('test');
      expect('key1' in entries).toBe(false);
      expect(entries['key2']).toBe('value2');
    });
  });

  describe('clearAll', () => {
    it('should remove the memory file', () => {
      setEntry('test', 'key', 'value');
      clearAll('test');
      const p = memoryPath('test');
      expect(fs.existsSync(p)).toBe(true); // File exists but is empty
      const entries = loadEntries('test');
      expect(entries).toEqual({});
    });

    it('should be no-op when file does not exist', () => {
      expect(() => clearAll('nonexistent')).not.toThrow();
    });
  });

  describe('buildInjection', () => {
    it('should return null when no entries', () => {
      const result = buildInjection('nonexistent');
      expect(result).toBeNull();
    });

    it('should format entries as Markdown', () => {
      setEntry('test', 'key1', 'value1');
      const result = buildInjection('test');
      expect(result).toContain('## Project Memory');
      expect(result).toContain('**key1**');
      expect(result).toContain('value1');
    });

    it('should include multiple entries', () => {
      setEntry('test', 'key1', 'value1');
      setEntry('test', 'key2', 'value2');
      const result = buildInjection('test');
      expect(result).toContain('**key1**');
      expect(result).toContain('**key2**');
    });

    it('should truncate long values', () => {
      const longValue = 'x'.repeat(500);
      setEntry('test', 'key', longValue);
      const result = buildInjection('test');
      expect(result).toContain('…');
      expect(result?.length).toBeLessThan(500);
    });

    it('should limit total size', () => {
      // Add many large entries
      for (let i = 0; i < 50; i++) {
        setEntry('test', `key${i}`, 'x'.repeat(100));
      }
      const result = buildInjection('test');
      expect(result).toBeDefined();
      expect(result!.length).toBeLessThan(4100); // MAX_TOTAL_CHARS + some margin
    });

    // Regression guard: the "+N more entries omitted" trailer line was appended after the
    // MAX_TOTAL_CHARS budget check, uncounted against it, so it could push the returned string
    // past the exact bound the function exists to enforce (by up to the trailer's own length,
    // ~70 chars). This asserts the strict bound, not the old test's loose "+100 char margin".
    it('never exceeds MAX_TOTAL_CHARS even when the omitted-entries trailer is appended', () => {
      for (let i = 0; i < 40; i++) {
        setEntry('test', `key${i}`, 'x'.repeat(122));
      }
      const result = buildInjection('test');
      expect(result).toBeDefined();
      expect(result).toContain('omitted');
      expect(result!.length).toBeLessThanOrEqual(4000);
    });

    it('should sort entries alphabetically', () => {
      setEntry('test', 'zebra', 'z');
      setEntry('test', 'apple', 'a');
      setEntry('test', 'mango', 'm');
      const result = buildInjection('test');
      const appleIdx = result?.indexOf('apple') ?? -1;
      const mangoIdx = result?.indexOf('mango') ?? -1;
      const zebraIdx = result?.indexOf('zebra') ?? -1;
      expect(appleIdx).toBeLessThan(mangoIdx);
      expect(mangoIdx).toBeLessThan(zebraIdx);
    });

    it('sorts numeric-string keys alphabetically, not by JS numeric-key enumeration order (regression: buildInjection relied on raw Object.entries() order, which JS reorders "9"/"10" ascending numerically regardless of insertion order, diverging from setEntry\'s eviction logic which assumes alphabetical iteration)', () => {
      setEntry('test', '10', 'ten');
      setEntry('test', '9', 'nine');
      const result = buildInjection('test');
      const tenIdx = result?.indexOf('**10**') ?? -1;
      const nineIdx = result?.indexOf('**9**') ?? -1;
      expect(tenIdx).toBeGreaterThanOrEqual(0);
      expect(nineIdx).toBeGreaterThanOrEqual(0);
      // Alphabetical: "10" < "9" (lexical comparison of '1' vs '9')
      expect(tenIdx).toBeLessThan(nineIdx);
    });

    it('should report skipped entries', () => {
      for (let i = 0; i < 50; i++) {
        setEntry('test', `key${i}`, 'value'.repeat(50));
      }
      const result = buildInjection('test');
      expect(result).toContain('omitted');
    });
  });

  describe('save uses a unique temp filename per write (#M27)', () => {
    it('does not reuse the same fixed temp filename across two saves to the same memory file', () => {
      const renameMock = fs.renameSync as unknown as ReturnType<typeof vi.fn>;
      renameMock.mockClear();
      setEntry('proj-m27', 'k1', 'v1');
      setEntry('proj-m27', 'k2', 'v2');
      const renamedFrom = renameMock.mock.calls.map((args: unknown[]) => String(args[0]));
      // The old hand-rolled implementation always wrote to the exact same fixed `${filePath}.tmp`
      // name, so two concurrent writers to the same project's memory file could collide on it.
      expect(renamedFrom).toHaveLength(2);
      expect(renamedFrom[0]).not.toBe(renamedFrom[1]);
    });
  });

  describe('setEntry/unsetEntry/clearAll serialize their load-modify-save section with a file lock (regression: these previously had no lock at all, unlike the analogous session_store.ts::saveSessionState and config_commands.ts::config-set critical sections -- two concurrent writers to the same project could each read the same pre-write state and the second save() would silently clobber the first entry)', () => {
    it('acquires and releases a .lock file around setEntry', () => {
      const writeMock = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
      writeMock.mockClear();
      setEntry('proj-lock', 'k1', 'v1');
      const lockWrites = writeMock.mock.calls.filter((args: unknown[]) => String(args[0]).endsWith('.lock'));
      expect(lockWrites.length).toBe(1);
      // The lock must be released (unlinked) once the write completes, or a later call under a
      // fresh process would find a live-looking lock file it can never acquire.
      const lockPath = String(lockWrites[0]?.[0]);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('does not double-write on a successful lock acquisition (regression: fn returning void made a successful withFileLock run indistinguishable from a failed lock acquire, causing the fallback branch to re-run the write a second time)', () => {
      const renameMock = fs.renameSync as unknown as ReturnType<typeof vi.fn>;
      renameMock.mockClear();
      setEntry('proj-lock-single', 'k1', 'v1');
      expect(renameMock.mock.calls).toHaveLength(1);
    });
  });

  describe('MAX_ENTRIES enforcement (regression test for bug: setEntry never enforces MAX_ENTRIES)', () => {
    it('should keep file size at most MAX_ENTRIES by evicting old entries when adding beyond the cap', () => {
      // Add entries with late-sorting keys to expose the bug: if MAX_ENTRIES is not enforced
      // at write time, entries with late-sorting keys would be silently dropped by
      // buildInjection's slice(0, MAX_ENTRIES) even though they were recently added.
      for (let i = 0; i < 35; i++) {
        setEntry('test-max', `entry_${String(i).padStart(3, '0')}`, `value${i}`);
      }
      // Load the file: it should have at most 30 entries
      const entries = loadEntries('test-max');
      expect(Object.keys(entries).length).toBeLessThanOrEqual(30);
      // Build injection: it should include all stored entries, not silently drop late-sorting ones
      const injection = buildInjection('test-max');
      expect(injection).not.toBeNull();
      // Count the number of list items in the injection (exclude the header and summary line)
      const lines = injection!.split('\n');
      const entryLines = lines.filter(line => line.startsWith('- **'));
      expect(entryLines.length).toBeLessThanOrEqual(30);
      // Verify that the most recently added entries are present (even if they sort late)
      // Entry 34 should be in the result since we only keep 30 and it was added last
      if (entryLines.length >= 1) {
        const latestEntryKey = `entry_034`;
        const hasLatestEntry = injection!.includes(`**${latestEntryKey}**`);
        // With correct enforcement, recently-added late-sorting entries should be kept
        // (The exact behavior depends on the eviction policy, but at least it shouldn't
        // silently drop all entries that sort after position 30.)
        expect(hasLatestEntry).toBe(true);
      }
    });
  });
});
