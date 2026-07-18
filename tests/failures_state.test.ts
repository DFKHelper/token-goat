import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { dataDir } from '../src/constants.js';
import {
  failuresStatePath,
  loadFailureSnapshot,
  saveFailureSnapshot,
  DEFAULT_FAILURES_STATE_KEY,
} from '../src/failures_state.js';

describe('failures_state', () => {
  // Mirrors project_memory.test.ts: failuresStatePath() resolves through
  // constants.ts::dataDir(), cached once at module load (tests/setup/isolate-home.ts), so
  // isolation is done by wiping the shared `${dataDir()}/projects` dir before/after each test.
  const projectsDir = path.join(dataDir(), 'projects');

  beforeEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  describe('failuresStatePath', () => {
    it('returns a path under the platform data dir', () => {
      const p = failuresStatePath('abc123', DEFAULT_FAILURES_STATE_KEY);
      expect(p).toContain('abc123_failures_default.json');
      expect(p.startsWith(dataDir())).toBe(true);
    });

    it('uses different paths for different keys within the same project', () => {
      const p1 = failuresStatePath('abc123', 'pytest');
      const p2 = failuresStatePath('abc123', 'jest');
      expect(p1).not.toBe(p2);
    });

    it('uses different paths for different project hashes', () => {
      const p1 = failuresStatePath('hash1', 'default');
      const p2 = failuresStatePath('hash2', 'default');
      expect(p1).not.toBe(p2);
    });

    it('rejects a key with path-traversal characters', () => {
      expect(() => failuresStatePath('abc123', '../../etc')).toThrow();
      expect(() => failuresStatePath('abc123', 'a/b')).toThrow();
    });
  });

  describe('loadFailureSnapshot', () => {
    it('returns null when no snapshot has been saved', () => {
      expect(loadFailureSnapshot('nonexistent', DEFAULT_FAILURES_STATE_KEY)).toBeNull();
    });

    it('round-trips a saved snapshot', () => {
      saveFailureSnapshot('proj-a', DEFAULT_FAILURES_STATE_KEY, {
        signatures: ['TestA', 'TestB'],
        runner: 'pytest',
        storedAt: 12345,
      });
      const snap = loadFailureSnapshot('proj-a', DEFAULT_FAILURES_STATE_KEY);
      expect(snap).not.toBeNull();
      expect(snap?.signatures).toEqual(['TestA', 'TestB']);
      expect(snap?.runner).toBe('pytest');
      expect(snap?.storedAt).toBe(12345);
    });

    it('keeps separate baselines per key for the same project', () => {
      saveFailureSnapshot('proj-b', 'pytest', { signatures: ['PyTest1'], runner: 'pytest', storedAt: 1 });
      saveFailureSnapshot('proj-b', 'jest', { signatures: ['JestTest1'], runner: 'jest', storedAt: 2 });
      expect(loadFailureSnapshot('proj-b', 'pytest')?.signatures).toEqual(['PyTest1']);
      expect(loadFailureSnapshot('proj-b', 'jest')?.signatures).toEqual(['JestTest1']);
    });

    it('overwrites the previous snapshot on a second save for the same key', () => {
      saveFailureSnapshot('proj-c', DEFAULT_FAILURES_STATE_KEY, { signatures: ['Old'], runner: 'go', storedAt: 1 });
      saveFailureSnapshot('proj-c', DEFAULT_FAILURES_STATE_KEY, { signatures: ['New'], runner: 'go', storedAt: 2 });
      expect(loadFailureSnapshot('proj-c', DEFAULT_FAILURES_STATE_KEY)?.signatures).toEqual(['New']);
    });

    it('degrades to null (not a throw) on a corrupted state file', () => {
      const p = failuresStatePath('proj-corrupt', DEFAULT_FAILURES_STATE_KEY);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'not valid json {{{', 'utf-8');
      expect(() => loadFailureSnapshot('proj-corrupt', DEFAULT_FAILURES_STATE_KEY)).not.toThrow();
      expect(loadFailureSnapshot('proj-corrupt', DEFAULT_FAILURES_STATE_KEY)).toBeNull();
    });

    it('degrades to null on valid JSON with the wrong shape', () => {
      const p = failuresStatePath('proj-wrongshape', DEFAULT_FAILURES_STATE_KEY);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ notSignatures: true }), 'utf-8');
      expect(loadFailureSnapshot('proj-wrongshape', DEFAULT_FAILURES_STATE_KEY)).toBeNull();
    });

    it('degrades gracefully when the file holds a bare JSON array instead of an object', () => {
      const p = failuresStatePath('proj-array', DEFAULT_FAILURES_STATE_KEY);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(['TestA']), 'utf-8');
      expect(loadFailureSnapshot('proj-array', DEFAULT_FAILURES_STATE_KEY)).toBeNull();
    });
  });

  describe('saveFailureSnapshot', () => {
    it('creates the projects directory if missing', () => {
      expect(fs.existsSync(projectsDir)).toBe(false);
      saveFailureSnapshot('proj-newdir', DEFAULT_FAILURES_STATE_KEY, { signatures: [], runner: 'go', storedAt: 1 });
      expect(fs.existsSync(projectsDir)).toBe(true);
    });

    it('does not leave a stale .lock file behind', () => {
      saveFailureSnapshot('proj-lock', DEFAULT_FAILURES_STATE_KEY, { signatures: ['TestA'], runner: 'go', storedAt: 1 });
      const lockPath = `${failuresStatePath('proj-lock', DEFAULT_FAILURES_STATE_KEY)}.lock`;
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});
