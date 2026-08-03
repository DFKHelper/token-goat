import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  lowercaseDriveLetter,
  normalizeDarwinSystemAlias,
  normalizePath,
  resolveIndexPath,
  safeJoin,
  toDisplayPath,
} from '../src/paths.js'

describe('safeJoin', () => {
  it('joins normally when no part contains a colon', () => {
    const result = safeJoin('base', 'sub', 'file.txt')
    expect(result).toBe(path.join('base', 'sub', 'file.txt'))
  })

  it('throws when any part contains a colon (drive-letter escape)', () => {
    expect(() => safeJoin('base', 'C:/evil')).toThrow(/colon/)
  })

  it('throws when a colon appears in a later part', () => {
    expect(() => safeJoin('base', 'ok', 'bad:stream')).toThrow(/colon/)
  })

  it('throws on an NTFS-stream-style colon fragment', () => {
    expect(() => safeJoin('base', 'file.txt:zone.identifier')).toThrow(/colon/)
  })

  it('works with zero extra parts', () => {
    expect(safeJoin('base')).toBe(path.join('base'))
  })
})

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('foo\\bar\\baz')).toBe('foo/bar/baz')
  })

  it('lowercases an uppercase drive-letter prefix', () => {
    expect(normalizePath('C:\\foo\\bar')).toBe('c:/foo/bar')
  })

  it('leaves an already-lowercase forward-slash path unchanged', () => {
    expect(normalizePath('c:/foo/bar')).toBe('c:/foo/bar')
  })

  it('converts a WSL /mnt path to Windows drive form', () => {
    expect(normalizePath('/mnt/c/foo/bar')).toBe('c:/foo/bar')
  })

  it('lowercases the WSL drive letter and collapses leading slashes', () => {
    expect(normalizePath('/mnt/C///bar')).toBe('c:/bar')
  })

  it('leaves a plain POSIX path unchanged', () => {
    expect(normalizePath('/home/user/project')).toBe('/home/user/project')
  })

  it('normalizes mixed-separator WSL paths fully', () => {
    expect(normalizePath('/mnt/c/foo\\bar')).toBe('c:/foo/bar')
  })

  // Mutation-testing gap: WSL_PATH_RE's `.*` after the drive segment must match a literal
  // newline byte (via the regex's `s` flag), or a path containing one -- unusual, but not
  // impossible for a filename built from arbitrary bytes -- fails to match at all and falls
  // through unrewritten, silently skipping the WSL->Windows-drive-form rewrite instead of
  // completing it.
  it('converts a WSL /mnt path whose remainder contains a literal newline byte', () => {
    expect(normalizePath('/mnt/c/foo\nbar/baz')).toBe('c:/foo\nbar/baz')
  })

  // Regression: UNC paths (\\host\share\...) have a case-insensitive host and share segment,
  // analogous to a drive letter, but were never folded -- two differently-cased references to
  // the same network share normalized to two different strings and silently missed each other
  // in every case-insensitive-path lookup this codebase does.
  it('lowercases a UNC path host and share segment', () => {
    expect(normalizePath('\\\\FileServer\\Dev\\foo.ts')).toBe('//fileserver/dev/foo.ts')
  })

  it('normalizes two differently-cased UNC references to the same share to the identical string', () => {
    expect(normalizePath('\\\\FileServer\\Dev\\foo.ts')).toBe(normalizePath('\\\\fileserver\\dev\\foo.ts'))
  })

  it("does not case-fold a UNC path's segments beyond host/share", () => {
    expect(normalizePath('\\\\FileServer\\Dev\\SomeFolder\\FooBar.ts')).toBe(
      '//fileserver/dev/SomeFolder/FooBar.ts',
    )
  })

  // Regression (bug #244): a `\\?\` extended-length-path prefix used to survive
  // the backslash->forward-slash conversion as `//?/...`, which then incorrectly
  // matched UNC_HOST_SHARE_RE (host=`?`, "share"=`c:`), producing a nonsense
  // UNC-folded key that diverged from the plain-form path's normalized output.
  it('normalizes a plain \\\\?\\ extended-length path identically to its non-extended equivalent', () => {
    expect(normalizePath('\\\\?\\C:\\Windows\\System32')).toBe(normalizePath('C:\\Windows\\System32'))
    expect(normalizePath('\\\\?\\C:\\Windows\\System32')).toBe('c:/Windows/System32')
  })

  it('normalizes a \\\\?\\UNC\\ extended-length UNC path identically to its non-extended equivalent', () => {
    expect(normalizePath('\\\\?\\UNC\\server\\share\\foo.ts')).toBe(normalizePath('\\\\server\\share\\foo.ts'))
    expect(normalizePath('\\\\?\\UNC\\server\\share\\foo.ts')).toBe('//server/share/foo.ts')
  })

  describe('Git Bash /<drive>/ mount form (win32-gated)', () => {
    const realPlatform = process.platform
    const setPlatform = (p: string): void => {
      Object.defineProperty(process, 'platform', { value: p, configurable: true })
    }
    afterEach(() => setPlatform(realPlatform))

    it('rewrites /c/Projects/x to c:/Projects/x on win32', () => {
      setPlatform('win32')
      expect(normalizePath('/c/Projects/x')).toBe('c:/Projects/x')
    })

    it('lowercases the drive and handles a bare /C root on win32', () => {
      setPlatform('win32')
      expect(normalizePath('/C/Foo')).toBe('c:/Foo')
      expect(normalizePath('/c')).toBe('c:/')
    })

    it('leaves a multi-letter /cab/ directory untouched on win32', () => {
      setPlatform('win32')
      expect(normalizePath('/cab/x')).toBe('/cab/x')
    })

    it('leaves /c/foo unchanged on non-win32 (a real POSIX path)', () => {
      setPlatform('linux')
      expect(normalizePath('/c/foo')).toBe('/c/foo')
    })
  })

  // Regression: %TEMP% (and every os.tmpdir()-based test fixture dir with it) can be pinned to the 8.3 short form (e.g. `JOHNDO~1.ACM`) on Windows, while git always emits long-form paths, so the same physical directory normalized to two different index keys depending on its source. fs.realpathSync (the POSIX-style implementation) does not resolve 8.3 short names on Windows; only fs.realpathSync.native does, hence the dedicated mock.
  describe('8.3 short-name expansion (win32-gated)', () => {
    const realPlatform = process.platform
    const setPlatform = (p: string): void => {
      Object.defineProperty(process, 'platform', { value: p, configurable: true })
    }
    afterEach(() => {
      setPlatform(realPlatform)
      vi.restoreAllMocks()
    })

    it('expands a short-name segment to its long form via fs.realpathSync.native', () => {
      setPlatform('win32')
      const spy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue('C:\\Users\\John.Doe')
      expect(normalizePath('C:\\Users\\JOHNDO~1.ACM\\AppData\\Local\\Temp')).toBe(
        'c:/Users/John.Doe/AppData/Local/Temp',
      )
      expect(spy).toHaveBeenCalledWith('C:/Users/JOHNDO~1.ACM')
    })

    it('does not touch a path with no short-name segment', () => {
      setPlatform('win32')
      const spy = vi.spyOn(fs.realpathSync, 'native')
      expect(normalizePath('C:\\Users\\John.Doe\\project')).toBe('c:/Users/John.Doe/project')
      expect(spy).not.toHaveBeenCalled()
    })

    it('is a no-op on non-win32 even with a short-name-shaped segment', () => {
      setPlatform('linux')
      const spy = vi.spyOn(fs.realpathSync, 'native')
      expect(normalizePath('/home/user/JOHNDO~1.ACM/foo')).toBe('/home/user/JOHNDO~1.ACM/foo')
      expect(spy).not.toHaveBeenCalled()
    })

    // Mutation-testing gap: with two short-name-looking segments in one path, expandShortPath
    // must resolve through the LAST one, not the first -- resolving through only the first would
    // leave the second short-name segment (and hence the rest of the path key) unexpanded, so a
    // path built from git's long-form output and one built through the short-form segment would
    // never converge to the same normalized key.
    it('resolves through the last short-name segment when a path contains two', () => {
      setPlatform('win32')
      const spy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue('C:\\AAAA-long\\BBBB-long')
      expect(normalizePath('C:\\AAAA~1\\BBBB~1\\file.txt')).toBe('c:/AAAA-long/BBBB-long/file.txt')
      expect(spy).toHaveBeenCalledWith('C:/AAAA~1/BBBB~1')
    })

    it('falls back to the original path when the native lookup throws (path does not exist)', () => {
      setPlatform('win32')
      vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
        throw new Error('ENOENT')
      })
      expect(normalizePath('c:/Users/JOHNDO~1.ACM/AppData')).toBe('c:/Users/JOHNDO~1.ACM/AppData')
    })
  })
})

// lowercaseDriveLetter is the helper extracted out of normalizePath's inline drive-letter step
// (and now also used by project.ts's canonicalize, replacing that file's own drifted inline
// copy) so the rule can only be defined once. normalizePath's own drive-letter behavior is
// still covered by the 'lowercases an uppercase drive-letter prefix' / 'leaves an
// already-lowercase forward-slash path unchanged' tests above; these test the extracted unit
// directly, including the ASCII-only guard that the original paths.ts inline check had and the
// unconditional project.ts inline check did not.
describe('lowercaseDriveLetter', () => {
  it('lowercases an uppercase ASCII drive-letter prefix', () => {
    expect(lowercaseDriveLetter('C:/foo/bar')).toBe('c:/foo/bar')
  })

  it('leaves an already-lowercase drive-letter prefix unchanged', () => {
    expect(lowercaseDriveLetter('c:/foo/bar')).toBe('c:/foo/bar')
  })

  it('leaves a string with no colon at index 1 unchanged', () => {
    expect(lowercaseDriveLetter('foo/bar')).toBe('foo/bar')
  })

  it('leaves a digit immediately before a colon unchanged (no-op either way, since toLowerCase() on a digit is already a no-op)', () => {
    expect(lowercaseDriveLetter('1:foo')).toBe('1:foo')
  })

  it('does not fold a non-ASCII uppercase letter before a colon (the guard this helper preserves from paths.ts\'s original inline check): a real Windows drive letter is always ASCII A-Z, so a non-ASCII character here is never a genuine drive letter, and folding it would invoke locale-sensitive String.prototype.toLowerCase() semantics for no real benefit', () => {
    // U+03A9 GREEK CAPITAL LETTER OMEGA has a well-defined lowercase mapping (ω) that an
    // unconditional `s[0].toLowerCase()` (project.ts's old inline check) would have applied;
    // the ASCII-only /^[A-Z]$/ guard leaves it untouched instead.
    expect(lowercaseDriveLetter('Ω:/foo')).toBe('Ω:/foo')
  })

  // Regression (8th instance of this case-fold bug class): a UNC path's host and share are
  // case-insensitive on Windows, exactly like a drive letter, but lowercaseDriveLetter only
  // ever checked for a drive-letter-shaped prefix. By the time normalizePath/canonicalize call
  // this helper, backslashes are already forward slashes, so the UNC form to fold is
  // `//host/share/...`.
  it('lowercases a UNC path host and share segment', () => {
    expect(lowercaseDriveLetter('//FileServer/Dev/foo.ts')).toBe('//fileserver/dev/foo.ts')
  })

  it('normalizes two differently-cased UNC host/share references to the identical string', () => {
    expect(lowercaseDriveLetter('//FileServer/Dev/foo.ts')).toBe(
      lowercaseDriveLetter('//fileserver/dev/foo.ts'),
    )
  })

  it("leaves a UNC path's segments beyond host/share untouched, mirroring the drive-letter-only fold", () => {
    expect(lowercaseDriveLetter('//FileServer/Dev/SomeFolder/FooBar.ts')).toBe(
      '//fileserver/dev/SomeFolder/FooBar.ts',
    )
  })

  it('leaves a UNC-shaped string with no share segment unchanged (no match, falls through)', () => {
    expect(lowercaseDriveLetter('//FileServer')).toBe('//FileServer')
  })
})

describe('normalizeDarwinSystemAlias', () => {
  it('normalizes only the /var path boundary on macOS', () => {
    const expectedRoot = process.platform === 'darwin' ? '/private/var' : '/var'
    const expectedChild = process.platform === 'darwin' ? '/private/var/folders/example' : '/var/folders/example'
    expect(normalizeDarwinSystemAlias('/var')).toBe(expectedRoot)
    expect(normalizeDarwinSystemAlias('/var/folders/example')).toBe(expectedChild)
    expect(normalizeDarwinSystemAlias('/VAR/FOLDERS/example')).toBe(
      process.platform === 'darwin' ? '/private/VAR/FOLDERS/example' : '/VAR/FOLDERS/example',
    )
    expect(normalizeDarwinSystemAlias('/private/var/folders/example')).toBe('/private/var/folders/example')
    expect(normalizeDarwinSystemAlias('/variant/example')).toBe('/variant/example')
  })

  // Mutation-testing gap: the existing exact-match assertion above only exercises lowercase
  // '/var'; the second branch's uppercase coverage ('/VAR/FOLDERS/example') only exercises the
  // slice(0,5)-with-trailing-slash branch, never the bare exact-match branch with uppercase input
  // -- so a case-sensitive regression on just the first branch (p === '/var' instead of
  // p.toLowerCase() === '/var') would go unnoticed. Forces platform to 'darwin' (rather than
  // branching the expectation on the host's real platform like the test above) because this
  // suite runs on ubuntu-latest and windows-latest in CI, never on a real macOS host, so a
  // platform-conditional expectation here would never actually exercise the mutated line at all.
  it('normalizes a bare uppercase /VAR (no trailing content) case-insensitively on macOS', () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      expect(normalizeDarwinSystemAlias('/VAR')).toBe('/private/VAR')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })
})

describe('resolveIndexPath', () => {
  // These assert on WHICH resolver is invoked (path.win32.resolve vs the ambient, host-native
  // path.resolve), not just the output value: on a real Windows host, the ambient path.resolve
  // is already win32-native, so a value-only assertion would pass even against the pre-fix bug
  // that only broke on non-Windows hosts (CI's ubuntu-latest). Spying on the call is what makes
  // this regression catchable from a Windows dev machine's local pre-push run too, not just CI.
  it('uses path.win32.resolve, not the ambient path.resolve, when file is Windows-drive-absolute (fail-on-buggy: passes trivially on a real Windows host even without the fix, since the ambient resolve is win32-native there)', () => {
    const win32Spy = vi.spyOn(path.win32, 'resolve')
    try {
      resolveIndexPath('C:/Projects/repo-a/src/foo.ts', '/some/other/base')
      expect(win32Spy).toHaveBeenCalled()
    } finally {
      win32Spy.mockRestore()
    }
  })

  it('uses path.win32.resolve, not the ambient path.resolve, when only base (cwd) is Windows-drive-absolute and file is relative', () => {
    const win32Spy = vi.spyOn(path.win32, 'resolve')
    try {
      resolveIndexPath('src/foo.ts', 'C:/Projects/repo-a')
      expect(win32Spy).toHaveBeenCalled()
    } finally {
      win32Spy.mockRestore()
    }
  })

  it('does not use path.win32.resolve for a relative file against a POSIX-style base', () => {
    const win32Spy = vi.spyOn(path.win32, 'resolve')
    try {
      resolveIndexPath('src/foo.ts', '/home/user/repo')
      expect(win32Spy).not.toHaveBeenCalled()
    } finally {
      win32Spy.mockRestore()
    }
  })

  it('dedups a relative-vs-Windows-absolute reference to the same file under a Windows-style cwd (fail-on-buggy: breaks if the ambient path.resolve is used instead of path.win32.resolve)', () => {
    const cwd = 'C:/Projects/repo-a'
    expect(resolveIndexPath('src/foo.ts', cwd)).toBe(resolveIndexPath('C:/Projects/repo-a/src/foo.ts', cwd))
  })

  it('dedups a drive-letter-case-only difference under a Windows-style cwd', () => {
    const cwd = 'C:/Projects/repo-a'
    expect(resolveIndexPath('C:/Projects/repo-a/src/foo.ts', cwd)).toBe(resolveIndexPath('c:/Projects/repo-a/src/foo.ts', cwd))
  })

  // Mutation-testing gap: a colon at index 1 with no following slash/backslash (e.g. "C:foo.ts")
  // is a Windows drive-RELATIVE path, not absolute -- it means "foo.ts relative to whatever the
  // current directory on drive C: happens to be", which this codebase can never determine, not
  // "foo.ts at the root of drive C:". isWindowsAbsolute's regex requires a separator right after
  // the colon specifically to exclude this case and fall through to the ambient (non-win32)
  // resolver instead of silently mis-resolving it as if it were absolute.
  it('does not treat a drive-relative path (colon with no following separator) as Windows-absolute', () => {
    const win32Spy = vi.spyOn(path.win32, 'resolve')
    try {
      resolveIndexPath('C:foo.ts', '/home/user/repo')
      expect(win32Spy).not.toHaveBeenCalled()
    } finally {
      win32Spy.mockRestore()
    }
  })
})

describe('toDisplayPath', () => {
  // Regression: an earlier pass defaulted the display root to process.cwd() when the caller
  // had none. That made the same query print differently depending on the directory it ran
  // from -- ambiguous once printed and unresolvable elsewhere. An absent root must yield the
  // absolute path, never a cwd-relative one.
  it('returns the absolute path unchanged when no root is available', () => {
    expect(toDisplayPath(undefined, '/home/user/repo/src/foo.ts')).toBe('/home/user/repo/src/foo.ts')
  })

  it('does not fall back to cwd-relative output when root is undefined', () => {
    const inCwd = path.join(process.cwd(), 'src', 'foo.ts')
    expect(toDisplayPath(undefined, inCwd)).toBe(inCwd)
  })

  it('returns a forward-slashed relative path for a target inside root', () => {
    expect(toDisplayPath('/home/user/repo', '/home/user/repo/src/foo.ts')).toBe('src/foo.ts')
  })

  it('returns the absolute path unchanged for a target outside root', () => {
    expect(toDisplayPath('/home/user/repo', '/home/user/other/foo.ts')).toBe('/home/user/other/foo.ts')
  })

  it('returns the root itself as "."', () => {
    expect(toDisplayPath('/home/user/repo', '/home/user/repo')).toBe('.')
  })

  it('handles a trailing separator on root', () => {
    expect(toDisplayPath('/home/user/repo/', '/home/user/repo/src/foo.ts')).toBe('src/foo.ts')
  })

  describe('cross-drive (win32-gated)', () => {
    const realPlatform = process.platform
    const setPlatform = (p: string): void => {
      Object.defineProperty(process, 'platform', { value: p, configurable: true })
    }
    afterEach(() => setPlatform(realPlatform))

    // fail-on-buggy: on win32, path.relative() between different drive letters returns the
    // target's own absolute path rather than a '..'-prefixed chain. A naive
    // `!rel.startsWith('..')` check would treat that returned absolute path as "inside root"
    // and (with the forward-slash rewrite) print it as a bogus relative path. This asserts the
    // real absolute path comes back unchanged, not a mangled false-relative one.
    it('returns the absolute path unchanged for a target on a different drive letter than root', () => {
      setPlatform('win32')
      const result = toDisplayPath('C:/proj', 'D:/other/x.ts')
      expect(result).toBe('D:/other/x.ts')
      expect(path.isAbsolute(result) || /^[a-zA-Z]:/.test(result)).toBe(true)
    })
  })
})
