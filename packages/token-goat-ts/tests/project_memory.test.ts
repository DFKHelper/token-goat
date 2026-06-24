import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  memoryPath,
  loadEntries,
  setEntry,
  unsetEntry,
  clearAll,
  buildInjection,
} from '../src/project_memory.js';

describe('project_memory', () => {
  let tmpDir: string;
  let oldDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-test-'));
    oldDataHome = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (oldDataHome !== undefined) {
      process.env['XDG_DATA_HOME'] = oldDataHome;
    } else {
      delete process.env['XDG_DATA_HOME'];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('memoryPath', () => {
    it('should return a path in XDG_DATA_HOME', () => {
      const p = memoryPath('abc123');
      expect(p).toContain('abc123_memory.toml');
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

    it('should report skipped entries', () => {
      for (let i = 0; i < 50; i++) {
        setEntry('test', `key${i}`, 'value'.repeat(50));
      }
      const result = buildInjection('test');
      expect(result).toContain('omitted');
    });
  });
});
