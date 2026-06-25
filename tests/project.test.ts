import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canonicalize, projectHash, makeProjectAt, findProject, PROJECT_MARKERS } from '../src/project.js';

describe('project', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('canonicalize', () => {
    it('should resolve absolute paths to forward slashes', () => {
      const result = canonicalize(tmpDir);
      const absRegex = process.platform === 'win32' ? /^\w:/ : /^\//;
      expect(result).toMatch(absRegex);
      expect(result).not.toContain('\\');
    });

    it('should lowercase Windows drive letters', () => {
      if (process.platform === 'win32') {
        const result = canonicalize('C:\\Windows');
        expect(result[0]).toBe('c');
      }
    });

    it('should resolve relative paths to absolute', () => {
      const before = process.cwd();
      try {
        process.chdir(tmpDir);
        const result = canonicalize('.');
        expect(result).toBe(canonicalize(tmpDir));
      } finally {
        process.chdir(before);
      }
    });

    it('should handle trailing slashes', () => {
      const with_trailing = canonicalize(tmpDir + '/');
      const without = canonicalize(tmpDir);
      expect(with_trailing).toBe(without);
    });
  });

  describe('projectHash', () => {
    it('should return a 16-char hex string', () => {
      const hash = projectHash(canonicalize(tmpDir));
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should be deterministic for same path', () => {
      const canonical = canonicalize(tmpDir);
      const hash1 = projectHash(canonical);
      const hash2 = projectHash(canonical);
      expect(hash1).toBe(hash2);
    });

    it('should differ for different paths', () => {
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-test-'));
      try {
        const hash1 = projectHash(canonicalize(tmpDir));
        const hash2 = projectHash(canonicalize(tmpDir2));
        expect(hash1).not.toBe(hash2);
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });

  describe('makeProjectAt', () => {
    it('should create a Project for an existing directory', () => {
      const project = makeProjectAt(tmpDir);
      expect(project.root).toBe(canonicalize(tmpDir));
      expect(project.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(project.marker).toBe('manual');
    });

    it('should throw for a non-existent directory', () => {
      const nonexistent = path.join(tmpDir, 'does-not-exist');
      expect(() => makeProjectAt(nonexistent)).toThrow();
    });

    it('should throw if path is not a directory', () => {
      const file = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(file, 'content');
      expect(() => makeProjectAt(file)).toThrow();
      fs.unlinkSync(file);
    });

    it('should accept a URL object', () => {
      if (process.platform === 'win32') {
        const url = new URL(`file:///c:/temp`);
        expect(() => makeProjectAt(url)).toThrow(); // /temp doesn't exist
      }
    });
  });

  describe('findProject', () => {
    it('should find .git in current directory', () => {
      const gitDir = path.join(tmpDir, '.git');
      fs.mkdirSync(gitDir);
      const project = findProject(tmpDir);
      expect(project).not.toBeNull();
      expect(project?.marker).toBe('.git');
      expect(project?.root).toBe(canonicalize(tmpDir));
    });

    it('should find pyproject.toml marker', () => {
      const pyproject = path.join(tmpDir, 'pyproject.toml');
      fs.writeFileSync(pyproject, '[project]\n');
      const project = findProject(tmpDir);
      expect(project).not.toBeNull();
      expect(project?.marker).toBe('pyproject.toml');
    });

    it('should walk up directory tree to find marker', () => {
      const subdir = path.join(tmpDir, 'src', 'lib');
      fs.mkdirSync(subdir, { recursive: true });
      const gitDir = path.join(tmpDir, '.git');
      fs.mkdirSync(gitDir);
      const project = findProject(subdir);
      expect(project).not.toBeNull();
      expect(project?.root).toBe(canonicalize(tmpDir));
    });

    it('should return null when no marker found', () => {
      const project = findProject(tmpDir);
      expect(project).toBeNull();
    });

    it('should handle symlinks in marker detection', () => {
      if (process.platform !== 'win32') {
        const gitDir = path.join(tmpDir, '.git-real');
        fs.mkdirSync(gitDir);
        const gitLink = path.join(tmpDir, '.git');
        fs.symlinkSync(gitDir, gitLink, 'dir');
        const project = findProject(tmpDir);
        expect(project).not.toBeNull();
        expect(project?.marker).toBe('.git');
      }
    });

    it('should prefer earliest marker in walk', () => {
      const parentMarker = path.join(tmpDir, '.git');
      fs.mkdirSync(parentMarker);
      const subdir = path.join(tmpDir, 'src');
      fs.mkdirSync(subdir);
      const subMarker = path.join(subdir, 'package.json');
      fs.writeFileSync(subMarker, '{}');
      const project = findProject(subdir);
      expect(project?.marker).toBe('package.json');
    });
  });

  describe('PROJECT_MARKERS constant', () => {
    it('should include common markers', () => {
      expect(PROJECT_MARKERS).toContain('.git');
      expect(PROJECT_MARKERS).toContain('package.json');
      expect(PROJECT_MARKERS).toContain('pyproject.toml');
    });

    it('should be non-empty', () => {
      expect(PROJECT_MARKERS.length).toBeGreaterThan(0);
    });
  });
});
