import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as NodeFs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { runGit as runGitType } from '../src/util.js';

// vi.mock is hoisted — wrap readdirSync (still delegating to the real implementation by default)
// so the #M26 test below can simulate a Node < 20.1 Dirent (no `.path` property) without touching
// Node's non-configurable fs module properties directly (vi.spyOn on a builtin fails at runtime).
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>();
  return {
    ...original,
    readdirSync: vi.fn((...args: Parameters<typeof original.readdirSync>) => original.readdirSync(...args)),
  };
});

// vi.mock is hoisted — wrap runGit (still delegating to the real implementation by default) so
// the resolveProjectRoot empty-stdout test below can simulate `git rev-parse --show-toplevel`
// exiting 0 with empty stdout (an edge case real git essentially never produces from a normal
// work tree, but resolveProjectRoot defends against it) without spawning a real git process.
vi.mock('../src/util.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runGit: vi.fn((...args: Parameters<runGitType>) => (original['runGit'] as runGitType)(...args)),
  };
});

import { execFileSync } from 'node:child_process';
import { canonicalize, projectHash, makeProjectAt, findProject, resolveProjectRoot, PROJECT_MARKERS, isUnderSystemTemp } from '../src/project.js';
import { lowercaseDriveLetter } from '../src/paths.js';
import { runGit } from '../src/util.js';

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

    // Deterministic (not host-OS-gated, unlike the test above) coverage of canonicalize's
    // drive-letter lowercasing, now delegated to paths.ts's shared lowercaseDriveLetter instead
    // of project.ts's own drifted, unconditional inline copy. setPlatform mirrors the
    // 'WSL mount-path rewrite (win32-gated, #M25)' block below: forcing process.platform to
    // 'win32' makes canonicalize take its path.win32.resolve branch regardless of the host OS
    // running the test, so this runs for real on Linux CI instead of no-op'ing like the test
    // above does there.
    describe('drive-letter lowercasing (shared lowercaseDriveLetter, host-independent)', () => {
      const realPlatform = process.platform;
      const setPlatform = (p: string): void => {
        Object.defineProperty(process, 'platform', { value: p, configurable: true });
      };
      afterEach(() => setPlatform(realPlatform));

      it('lowercases an uppercase Windows drive-letter prefix', () => {
        setPlatform('win32');
        expect(canonicalize('C:\\Windows')).toBe('c:/Windows');
      });

      it('leaves an already-lowercase Windows drive-letter prefix unchanged', () => {
        setPlatform('win32');
        expect(canonicalize('c:\\Windows')).toBe('c:/Windows');
      });
    });

    // The one input where paths.ts's original inline guard (ASCII-only /^[A-Z]$/) and
    // project.ts's original inline check (unconditional toLowerCase()) could have disagreed —
    // a non-ASCII uppercase letter immediately before a colon — never actually reaches
    // canonicalize in practice: path.win32.resolve() doesn't recognize anything but ASCII A-Z
    // as a drive letter, so a string like that is treated as relative and gets a real cwd
    // prefixed onto it before the lowercase step ever sees index 0/1 in that shape. Asserting
    // the shared helper's own guard behavior (paths.test.ts's 'lowercaseDriveLetter' describe
    // block) is what actually pins this down; canonicalize now shares that exact function, so
    // it inherits the same guarantee by construction rather than by a second, harder-to-write
    // integration test here.
    it('shares its drive-letter lowercasing with normalizePath via the same exported helper', () => {
      expect(lowercaseDriveLetter('C:/foo')).toBe('c:/foo');
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

    describe('WSL mount-path rewrite (win32-gated, #M25)', () => {
      const realPlatform = process.platform;
      const setPlatform = (p: string): void => {
        Object.defineProperty(process, 'platform', { value: p, configurable: true });
      };
      afterEach(() => setPlatform(realPlatform));

      it('rewrites /mnt/c/... to c:/... on win32', () => {
        setPlatform('win32');
        expect(canonicalize('/mnt/c/foo/bar')).toBe('c:/foo/bar');
      });

      it('uses path.win32.resolve, not the ambient path.resolve, when the mocked platform is win32 (fail-on-buggy: passes trivially on a real Windows host even without the fix, since the ambient resolve is win32-native there and the mock is redundant)', () => {
        setPlatform('win32');
        const win32Spy = vi.spyOn(path.win32, 'resolve');
        try {
          canonicalize('/mnt/c/foo/bar');
          expect(win32Spy).toHaveBeenCalled();
        } finally {
          win32Spy.mockRestore();
        }
      });

      it('does not rewrite /mnt/c/... on real POSIX platforms (path.resolve() is POSIX resolve there and does not understand drive-letter syntax, so rewriting first would corrupt an otherwise-valid POSIX path)', () => {
        setPlatform('linux');
        const result = canonicalize('/mnt/c/foo/bar');
        expect(result).not.toBe('c:/foo/bar');
        expect(result).toContain('mnt');
      });

      // Regression: project.ts used to maintain its own copy of paths.ts's WSL_PATH_RE without
      // the `s` (dotAll) flag paths.ts's own comment says is required for a WSL path containing
      // an embedded newline byte to normalize fully. Without the flag, `(.*)$` can't cross the
      // newline, so the whole match fails and the path is left un-rewritten -- producing two
      // different canonical strings (`c:/foo\nbar` via paths.ts::normalizePath vs. an unrewritten
      // `/mnt/c/foo\nbar` via project.ts::canonicalize) for what should be the same location.
      // project.ts now imports and reuses paths.ts's WSL_PATH_RE directly instead of a second copy.
      it('rewrites a WSL path containing an embedded newline byte, matching paths.ts::normalizePath', () => {
        setPlatform('win32');
        const result = canonicalize('/mnt/c/foo\nbar');
        expect(result).toBe('c:/foo\nbar');
      });

      // Regression: project.ts's local MSYS_PREFIX_RE required a mandatory trailing /rest group,
      // unlike paths.ts's step-2b regex (comment there: "bare /c becomes c:/"), so a bare drive
      // root like /c matched paths.ts::normalizePath but fell through unrewritten here -- the
      // same divergence class as the WSL_PATH_RE bug above, this time on the MSYS branch.
      // project.ts now imports paths.ts's exported MSYS_PATH_RE directly instead of a second,
      // stricter copy.
      it('rewrites a bare MSYS drive root (/c) to c:/, matching paths.ts::normalizePath', () => {
        setPlatform('win32');
        expect(canonicalize('/c')).toBe('c:/');
      });

      // Regression: paths.ts's exported MSYS_PATH_RE itself was missing the `s` (dotAll) flag
      // its own sibling WSL_PATH_RE has -- so an MSYS path (/c/rest) containing an embedded
      // newline byte failed to match (`(\/.*)?$` can't cross the newline without `s`) and fell
      // through unrewritten, same failure class as the WSL_PATH_RE bug above but on the shared
      // MSYS_PATH_RE constant itself, not a divergent copy.
      it('rewrites an MSYS path containing an embedded newline byte, matching paths.ts::normalizePath', () => {
        setPlatform('win32');
        const result = canonicalize('/c/foo\nbar');
        expect(result).toBe('c:/foo\nbar');
      });

      // Regression: project.ts's local CYGWIN_PREFIX_RE (no paths.ts counterpart exists) was also
      // missing the `s` flag, so a Cygwin path (/cygdrive/c/rest) containing an embedded newline
      // byte failed to match and fell through unrewritten -- the same bug class, third occurrence.
      it('rewrites a Cygwin path containing an embedded newline byte', () => {
        setPlatform('win32');
        const result = canonicalize('/cygdrive/c/foo\nbar');
        expect(result).toBe('c:/foo\nbar');
      });
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

    describe('case folding (case-insensitive FS)', () => {
      const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS;
      afterEach(() => {
        if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS;
        else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv;
      });

      // Regression: projectHash hashed the raw canonicalize() string. canonicalize() only
      // lowercases the drive letter (lowercaseDriveLetter), so opening the same physical
      // directory via two differently-cased path strings (e.g. C:\Projects\Foo vs
      // c:\projects\foo) produced two different hashes -- and therefore two different
      // per-project state directories (compact.ts's writeSessionManifest keys sessions by
      // this hash) for what is really one project on a case-insensitive filesystem.
      it('produces the same hash for two case variants of the same canonical root', () => {
        process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1';
        const canonical = canonicalize(tmpDir);
        const hash1 = projectHash(canonical);
        const hash2 = projectHash(canonical.toUpperCase());
        expect(hash1).toBe(hash2);
      });

      it('control: case-sensitive FS mode still hashes case variants differently', () => {
        process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0';
        const canonical = canonicalize(tmpDir);
        const hash1 = projectHash(canonical);
        const hash2 = projectHash(canonical.toUpperCase());
        expect(hash1).not.toBe(hash2);
      });
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

    // Mutation-testing gap: the only existing symlink test above points a `.git` symlink AT a
    // target INSIDE tmpDir and asserts it's accepted -- nothing ever creates a marker symlink
    // that escapes the root and asserts it's rejected, so markerExists's `!rel.startsWith('..')`
    // escape guard (the entire reason the function's doc-comment mentions "not a symlink escaping
    // the root") had no coverage of its actual security property. Uses fs spies rather than a
    // real symlink (unlike the "should handle symlinks" test above, which is gated off win32
    // because Windows symlink creation needs elevated privileges) so this test runs unconditionally
    // on every platform, including this project's own win32 CI job.
    it('does not treat a marker symlink pointing outside the root as a valid project marker', () => {
      const outsideTarget = path.join(path.dirname(tmpDir), 'outside-marker-target');
      // Matches on basename rather than an exact path.join(tmpDir, '.git') string: findProject
      // canonicalizes tmpDir before calling markerExists (lowercasing the drive letter, expanding
      // any 8.3 short-name segment, etc.), so `current` inside markerExists is not guaranteed to
      // be byte-identical to the raw tmpDir this test constructed.
      const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => path.basename(p.toString()) === '.git')
      const lstatSpy = vi
        .spyOn(fs, 'lstatSync')
        .mockReturnValue({ isSymbolicLink: () => true } as unknown as NodeFs.Stats);
      const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(outsideTarget);
      try {
        const project = findProject(tmpDir);
        expect(project).toBeNull();
      } finally {
        existsSpy.mockRestore();
        lstatSpy.mockRestore();
        realpathSpy.mockRestore();
      }
    });

    // Regression: on Windows, path.relative() across drive letters (e.g. C:\project ->
    // D:\evil\file) returns the absolute target path unchanged instead of a '..'-prefixed
    // relative path, so a startsWith('..')-only check lets a cross-drive escaping symlink
    // through. Uses a drive letter that differs from tmpDir's own drive (derived, not hardcoded,
    // so the test is correct regardless of which drive the CI/dev box's temp dir lives on).
    it.runIf(process.platform === 'win32')('does not treat a marker symlink escaping to a different drive letter as valid', () => {
      const tmpDrive = path.parse(tmpDir).root.slice(0, 1).toUpperCase();
      const otherDrive = tmpDrive === 'D' ? 'E' : 'D';
      const outsideTarget = `${otherDrive}:\\evil\\marker-target`;
      const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => path.basename(p.toString()) === '.git')
      const lstatSpy = vi
        .spyOn(fs, 'lstatSync')
        .mockReturnValue({ isSymbolicLink: () => true } as unknown as NodeFs.Stats);
      const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(outsideTarget);
      try {
        const project = findProject(tmpDir);
        expect(project).toBeNull();
      } finally {
        existsSpy.mockRestore();
        lstatSpy.mockRestore();
        realpathSpy.mockRestore();
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

    it('does not mistake a repo-container for a project root when Dirent lacks a .path property (#M26, Node < 20.1 compat)', () => {
      // tmpDir has its own .git marker AND >= 3 nested repos, so it's a "repo container" (a
      // monorepo/workspace root) — findProject must skip it and keep walking up, not treat it
      // as the project root. Node < 20.1 Dirent objects never had a `.path` property, so
      // isRepoContainer must not rely on it.
      fs.mkdirSync(path.join(tmpDir, '.git'));
      for (const name of ['repo1', 'repo2', 'repo3']) {
        fs.mkdirSync(path.join(tmpDir, name, '.git'), { recursive: true });
      }
      const subdir = path.join(tmpDir, 'src');
      fs.mkdirSync(subdir);

      const readdirMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
      readdirMock.mockImplementationOnce(() => [
        { name: 'repo1', isDirectory: () => true },
        { name: 'repo2', isDirectory: () => true },
        { name: 'repo3', isDirectory: () => true },
      ]);

      const project = findProject(subdir);
      expect(project).toBeNull();
    });

    // Mutation-testing gap: every existing repo-container test uses exactly 3 nested repos (the
    // threshold), so a mutation that lowers REPO_CONTAINER_THRESHOLD itself (e.g. 3 -> 2) survived
    // them all -- none exercises a count BELOW the threshold that must still resolve as a normal
    // project root, not a container.
    it('does not classify a root with only 2 nested repos (below threshold) as a repo container', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      for (const name of ['repo1', 'repo2']) {
        fs.mkdirSync(path.join(tmpDir, name, '.git'), { recursive: true });
      }
      const subdir = path.join(tmpDir, 'src');
      fs.mkdirSync(subdir);

      const project = findProject(subdir);
      expect(project).not.toBeNull();
      expect(project?.root).toBe(canonicalize(tmpDir));
      expect(project?.marker).toBe('.git');
    });

    it('does not misclassify a submodule-based monorepo as a repo container (3+ .git FILES, not directories)', () => {
      // A git submodule root has a `.git` FILE (a one-line `gitdir: ...` pointer into the
      // superproject's .git/modules), not a `.git` directory. Before the fix, isRepoContainer
      // counted ANY `.git` entry -- file or directory -- toward REPO_CONTAINER_THRESHOLD, so a
      // monorepo with 3+ submodules at its root was misclassified as a container of unrelated
      // repos and findProject walked past the real project root. Contrast with the adjacent
      // "does not mistake a repo-container..." test above, which uses 3 real .git DIRECTORIES
      // and correctly still triggers container classification.
      fs.mkdirSync(path.join(tmpDir, '.git'));
      for (const name of ['sub1', 'sub2', 'sub3']) {
        const subRepoDir = path.join(tmpDir, name);
        fs.mkdirSync(subRepoDir, { recursive: true });
        fs.writeFileSync(path.join(subRepoDir, '.git'), `gitdir: ../../.git/modules/${name}\n`);
      }
      const subdir = path.join(tmpDir, 'src');
      fs.mkdirSync(subdir);

      const project = findProject(subdir);
      expect(project).not.toBeNull();
      expect(project?.root).toBe(canonicalize(tmpDir));
      expect(project?.marker).toBe('.git');
    });

    describe('temp-boundary guard casing (case-insensitive FS)', () => {
      const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS;
      const prevTMPDIR = process.env.TMPDIR;
      const prevTMP = process.env.TMP;
      const prevTEMP = process.env.TEMP;

      afterEach(() => {
        if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS;
        else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv;
        if (prevTMPDIR === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTMPDIR;
        if (prevTMP === undefined) delete process.env.TMP;
        else process.env.TMP = prevTMP;
        if (prevTEMP === undefined) delete process.env.TEMP;
        else process.env.TEMP = prevTEMP;
      });

      // Regression: findProject broke the upward walk on `current === sysTemp`, a raw string
      // compare. canonicalize() only lowercases the drive letter (lowercaseDriveLetter), so
      // when `current` (derived from cwd) and `sysTemp` (derived from os.tmpdir(), which reads
      // TEMP/TMP/TMPDIR from process.env at call time) differ in case beyond the drive letter
      // -- a realistic drift between a process's cwd string and its TEMP/TMP env var on
      // Windows -- the guard never matched. The walk then kept going past the temp boundary
      // and could attribute a temp-resident file to an unrelated ancestor's PROJECT_MARKER.
      it('stops at the temp boundary even when os.tmpdir() casing differs from cwd beyond the drive letter, instead of misattributing an unrelated ancestor marker', () => {
        process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1';

        // Simulate the OS temp root as a directory nested inside our own scratch tmpDir, so
        // this test never touches or plants markers in the real OS temp tree.
        const fakeTempRoot = path.join(tmpDir, 'faketemp');
        fs.mkdirSync(fakeTempRoot);
        // A marker ABOVE the simulated temp root: if the guard fails to stop the walk at
        // fakeTempRoot, findProject wrongly keeps walking up and picks this up as the root.
        fs.mkdirSync(path.join(tmpDir, '.git'));
        const workDir = path.join(fakeTempRoot, 'work');
        fs.mkdirSync(workDir);

        // os.tmpdir() reads TMPDIR (POSIX) / TEMP or TMP (Windows) from process.env at call
        // time. Point it at an uppercase variant of fakeTempRoot: the identical physical
        // directory, differing only in case beyond the drive letter.
        const upperFakeTempRoot = fakeTempRoot.toUpperCase();
        process.env.TMPDIR = upperFakeTempRoot;
        process.env.TMP = upperFakeTempRoot;
        process.env.TEMP = upperFakeTempRoot;

        const project = findProject(workDir);
        expect(project).toBeNull();
      });
    });
  });

  // Regression: resolveProjectRoot consolidates three previously-divergent conventions for
  // resolving "the current project root" (read_commands.ts's runChanged, resume.ts, and
  // cli_context_stats.ts each rolled their own). Exercises the shared precedence directly:
  // explicit `project` param (as the resolution base) -> git-toplevel/findProject resolution
  // from that base -> the base directory itself when neither applies.
  describe('resolveProjectRoot', () => {
    const before = process.cwd();
    afterEach(() => {
      process.chdir(before);
    });

    it('resolves to the git top-level when the base directory is inside a git repo (git-toplevel step)', () => {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      const subdir = path.join(tmpDir, 'src', 'lib');
      fs.mkdirSync(subdir, { recursive: true });

      const root = resolveProjectRoot({ project: subdir });

      expect(root).toBe(canonicalize(tmpDir));
    });

    it('falls back to findProject when the base directory is not inside a git repo but has a marker file', () => {
      const pyproject = path.join(tmpDir, 'pyproject.toml');
      fs.writeFileSync(pyproject, '[project]\n');
      const subdir = path.join(tmpDir, 'nested');
      fs.mkdirSync(subdir);

      const root = resolveProjectRoot({ project: subdir });

      expect(root).toBe(canonicalize(tmpDir));
    });

    it('falls back to the base directory itself when neither a git repo nor a marker file is found', () => {
      const root = resolveProjectRoot({ project: tmpDir });

      expect(root).toBe(canonicalize(tmpDir));
    });

    // Mutation-testing gap: real `git rev-parse --show-toplevel` essentially never exits 0 with
    // empty stdout from a normal work tree, so no existing test exercises this branch --
    // resolveProjectRoot's `trimmed.length > 0` guard exists defensively for exactly this
    // shape of result. Mocks runGit directly (via the top-level vi.mock) rather than spawning a
    // real git process to hit this state.
    it('falls through to findProject when git exits 0 but stdout is empty', () => {
      // pyproject.toml lives in tmpDir while `project` points at a nested subdir, so
      // base (subdir) !== the expected root (tmpDir) -- a regression that skips
      // findProject and just returns canonicalize(base) would produce canonicalize(subdir)
      // here, not canonicalize(tmpDir), so this actually exercises the fall-through.
      const pyproject = path.join(tmpDir, 'pyproject.toml');
      fs.writeFileSync(pyproject, '[project]\n');
      const subdir = path.join(tmpDir, 'nested');
      fs.mkdirSync(subdir);
      const runGitMock = runGit as unknown as ReturnType<typeof vi.fn>;
      runGitMock.mockReturnValueOnce({ exitCode: 0, stdout: '   \n', stderr: '' });

      const root = resolveProjectRoot({ project: subdir });

      expect(root).toBe(canonicalize(tmpDir));
    });

    it('uses process.cwd() as the base directory when no explicit project param is given (precedence: explicit param wins when present)', () => {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      process.chdir(tmpDir);

      const root = resolveProjectRoot();

      expect(root).toBe(canonicalize(tmpDir));
    });

    it('an explicit project param overrides process.cwd() as the resolution base', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-test-other-'));
      try {
        execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
        process.chdir(otherDir);

        const root = resolveProjectRoot({ project: tmpDir });

        expect(root).toBe(canonicalize(tmpDir));
        expect(root).not.toBe(canonicalize(otherDir));
      } finally {
        // Windows can't remove a directory that is the current working directory; chdir away
        // first (afterEach also restores cwd, but that runs after this finally block).
        process.chdir(before);
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
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

  describe('isUnderSystemTemp', () => {
    it('returns true for a path directly inside os.tmpdir()', () => {
      expect(isUnderSystemTemp(path.join(os.tmpdir(), 'some-file.ts'))).toBe(true);
    });

    it('returns true for a path nested arbitrarily deep under os.tmpdir()', () => {
      const nested = path.join(tmpDir, 'scratch-checkout', 'src', 'index.ts');
      expect(isUnderSystemTemp(nested)).toBe(true);
    });

    it('returns false for a path outside os.tmpdir(), e.g. this repo', () => {
      expect(isUnderSystemTemp(__filename)).toBe(false);
    });

    // Mutation-testing gap: the exact-match branch (foldedTarget === foldedTemp) is what makes
    // os.tmpdir() itself count as "under system temp", not just paths strictly beneath it -- the
    // existing "directly inside" test above only exercises a child of os.tmpdir(), never the temp
    // root itself, so a mutation that drops the exact-match branch and keeps only the
    // startsWith(`${foldedTemp}/`) check went unnoticed.
    it('returns true for os.tmpdir() itself, not only paths beneath it', () => {
      expect(isUnderSystemTemp(os.tmpdir())).toBe(true);
    });

    it('returns false for a sibling directory that merely shares os.tmpdir() as a string prefix', () => {
      // Guards against a naive startsWith(sysTemp) check (no separator) matching e.g.
      // "/tmp-other/file.ts" against a system temp dir of "/tmp".
      const sysTemp = os.tmpdir().replace(/[/\\]+$/, '');
      const sibling = `${sysTemp}-other-dir/file.ts`;
      expect(isUnderSystemTemp(sibling)).toBe(false);
    });
  });
});
