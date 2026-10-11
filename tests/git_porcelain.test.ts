/** parsePorcelainZ reads `git status --porcelain -z`. Inputs are FORMAT-DERIVED from git-status(1) "Porcelain Format Version 1" (https://git-scm.com/docs/git-status#_porcelain_format_version_1): with -z each entry ends in NUL, paths are never quoted, and a rename or copy entry is followed by the original path as its own NUL-ended field. Expected values are HAND-DERIVED from those inputs. */
import { describe, expect, it } from 'vitest'
import { parsePorcelainZ } from '../src/git_porcelain.js'

describe('parsePorcelainZ', () => {
  it.each([
    ['a modified and an untracked file', ' M a.txt\x00?? new/b.txt\x00', [{ path: 'a.txt' }, { path: 'new/b.txt' }]],
    ['a staged rename, original path second', 'R  new.txt\x00old.txt\x00 M c.txt\x00', [{ path: 'new.txt', origPath: 'old.txt' }, { path: 'c.txt' }]],
    ['a worktree rename (R in the second column)', ' R moved.txt\x00orig.txt\x00?? d.txt\x00', [{ path: 'moved.txt', origPath: 'orig.txt' }, { path: 'd.txt' }]],
    ['a copy', 'C  copy.txt\x00src.txt\x00', [{ path: 'copy.txt', origPath: 'src.txt' }]],
    ['a name holding the -> arrow', '?? a -> b.txt\x00', [{ path: 'a -> b.txt' }]],
    ['a non-ASCII name, unquoted', '?? dir/café.txt\x00', [{ path: 'dir/café.txt' }]],
    ['an empty listing', '', []],
  ])('%s', (_name, stdout, expected) => {
    expect(parsePorcelainZ(stdout)).toEqual(expected)
  })
})
