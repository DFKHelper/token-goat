/** Regression: `changed --symbol` listed every symbol of a changed file (or none) when git's idea of a path differed from the cwd's. `git diff --name-only` prints paths relative to the repository top level, but the hunk diff took them back as cwd-relative pathspecs, so from a subdirectory they matched nothing and the all-symbols fallback fired. The hunk parser also lost files whose path git tab-terminates (a space) or C-quotes. Provenance: CAPTURE for the git header lines below (real `git diff --unified=0` on git 2.53.0.windows.1, a temp repo holding `my file.ts` and `café.ts`); the repo-level tests drive runChanged end to end against real temp git repositories; expected symbol names are HAND-DERIVED from the source text each test writes. */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { parseDiffHunks, parseHunklessFiles, runChanged } from '../src/read_git.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-changed-paths-')))
  roots.push(root)
  git(root, 'init')
  git(root, 'config', 'user.email', 'test@test.com')
  git(root, 'config', 'user.name', 'Test')
  return root
}

function changedOutput(opts: Parameters<typeof runChanged>[0]): string {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(String(c))
    return true
  })
  runChanged(opts)
  vi.restoreAllMocks()
  return chunks.join('')
}

const BEFORE = ['export function alpha() {', '  return 1', '}', '', 'export function beta() {', '  return 2', '}', ''].join('\n')
const AFTER = BEFORE.replace('return 2', 'return 22')

function commitAndEdit(root: string, rel: string): string {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, BEFORE)
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'init')
  writeFileSync(file, AFTER)
  indexFileSync(normalizePath(file))
  return file
}

describe('changed --symbol scopes to the touched symbols whatever the cwd', () => {
  it('lists only the changed function when run from a subdirectory of the repo', () => {
    const root = makeRepo()
    commitAndEdit(root, 'pkg/mod.ts')
    const out = changedOutput({ ref: 'HEAD', projectRoot: join(root, 'pkg'), symbolMode: true })
    expect(out).toContain('beta')
    expect(out).not.toContain('alpha')
  })

  it('lists only the changed function for a file whose name has a space', () => {
    const root = makeRepo()
    commitAndEdit(root, 'my file.ts')
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('beta')
    expect(out).not.toContain('alpha')
  })

  it('lists only the changed function for a non-ASCII file name in a subdirectory', () => {
    const root = makeRepo()
    commitAndEdit(root, 'pkg/café mod.ts')
    const out = changedOutput({ ref: 'HEAD', projectRoot: join(root, 'pkg'), symbolMode: true })
    expect(out).toContain('beta')
    expect(out).not.toContain('alpha')
  })
})

describe('changed --symbol on markdown', () => {
  it('lists the section whose body changed, not only one whose heading line changed', () => {
    const root = makeRepo()
    const before = ['# Guide', '', '## One', '', 'first body', '', '## Two', '', 'second body', ''].join('\n')
    const file = join(root, 'guide.md')
    writeFileSync(file, before)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'init')
    writeFileSync(file, before.replace('second body', 'second body edited'))
    indexFileSync(normalizePath(file))
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('Two')
    expect(out).not.toContain('One')
  })
})

describe('parseDiffHunks reads the path git writes on a +++ line', () => {
  // CAPTURE: `git diff --unified=0` on git 2.53.0.windows.1 prints a TAB after an unquoted path that contains a space.
  it('drops the trailing tab git appends after a path with a space', () => {
    const diff = ['--- a/my file.ts\t', '+++ b/my file.ts\t', '@@ -2 +2 @@', '-a', '+b'].join('\n')
    expect([...parseDiffHunks(diff).keys()]).toEqual(['my file.ts'])
  })

  // CAPTURE: default core.quotePath git prints `+++ "b/caf\303\251.ts"` for café.ts (octal UTF-8 bytes, double-quoted).
  it('decodes a C-quoted path with octal UTF-8 bytes', () => {
    const diff = ['--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    expect([...parseDiffHunks(diff).keys()]).toEqual(['café.ts'])
  })

  // FORMAT-DERIVED: git's C-style quoting (quote_c_style in quote.c) writes a quote as \" a backslash as \\ and a tab as \t.
  it('decodes quote, backslash and tab escapes', () => {
    const diff = ['+++ "b/q\\"u\\\\o\\tx.ts"', '@@ -3,2 +3,4 @@'].join('\n')
    const hunks = parseDiffHunks(diff)
    expect(hunks.get('q"u\\o\tx.ts')).toEqual([{ start: 3, end: 6 }])
  })
})

describe('changed --symbol on a renamed and lightly edited file', () => {
  // HAND-DERIVED: BEFORE and AFTER differ only on beta's return line, so the edit touches beta alone; `git mv` stages the rename and `git diff HEAD -M` pairs it as one hunk on that line.
  function renameAndEdit(root: string, from: string, to: string): void {
    const src = join(root, from)
    mkdirSync(join(src, '..'), { recursive: true })
    writeFileSync(src, BEFORE)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'init')
    mkdirSync(join(root, to, '..'), { recursive: true })
    git(root, 'mv', from, to)
    writeFileSync(join(root, to), AFTER)
    indexFileSync(normalizePath(join(root, to)))
  }

  it('lists only the edited function, not every symbol of the moved file', () => {
    const root = makeRepo()
    renameAndEdit(root, 'm.ts', 'n.ts')
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('beta (function) — n.ts:5')
    expect(out).not.toContain('alpha')
  })

  it('pairs a rename across directories for a name with a space', () => {
    const root = makeRepo()
    renameAndEdit(root, 'old dir/m.ts', 'pkg/my file.ts')
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('beta')
    expect(out).not.toContain('alpha')
  })
})

describe('changed --symbol on a file git reports with no hunks', () => {
  // CAPTURE: `git diff HEAD -M --unified=0 --src-prefix=a/ --dst-prefix=b/` (git 2.53.0.windows.1) after `git mv a.ts b.ts`, `git update-index --chmod=+x run.sh` and `git add` of a new c.ts printed exactly this.
  const CAPTURED = [
    'diff --git a/a.ts b/b.ts',
    'similarity index 100%',
    'rename from a.ts',
    'rename to b.ts',
    'diff --git a/c.ts b/c.ts',
    'new file mode 100644',
    'index 0000000..19f2811',
    '--- /dev/null',
    '+++ b/c.ts',
    '@@ -0,0 +1,3 @@',
    '+export function z() {',
    '+  return 9',
    '+}',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n')

  it('names the pure rename and the mode-only change, not the added file', () => {
    expect([...parseHunklessFiles(CAPTURED)].sort()).toEqual(['b.ts', 'run.sh'])
  })

  it('does not name a rename that also carries an edit', () => {
    // HAND-DERIVED: a rename with edits has `+++` and a hunk after the rename lines.
    const diff = ['diff --git a/m.ts b/n.ts', 'similarity index 90%', 'rename from m.ts', 'rename to n.ts', '--- a/m.ts', '+++ b/n.ts', '@@ -5 +5 @@', '-x', '+y', ''].join('\n')
    expect(parseHunklessFiles(diff).size).toBe(0)
  })

  it('lists no symbols for a file that was only renamed with git mv', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'a.ts'), BEFORE)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'init')
    git(root, 'mv', 'a.ts', 'b.ts')
    indexFileSync(normalizePath(join(root, 'b.ts')))
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('No symbols changed.')
    expect(out).not.toContain('alpha')
  })

  it('lists no symbols for a file whose only change is its mode', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'a.ts'), BEFORE)
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'init')
    // `git diff HEAD` compares against the working tree: with core.fileMode on (POSIX) it reads the mode from disk, with it off (Windows) from the index, so the change is made in both places.
    chmodSync(join(root, 'a.ts'), 0o755)
    git(root, 'update-index', '--chmod=+x', 'a.ts')
    indexFileSync(normalizePath(join(root, 'a.ts')))
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('No symbols changed.')
  })

  it('still lists every symbol of a newly added file', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'keep.ts'), 'export const k = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'init')
    writeFileSync(join(root, 'c.ts'), BEFORE)
    git(root, 'add', 'c.ts')
    indexFileSync(normalizePath(join(root, 'c.ts')))
    const out = changedOutput({ ref: 'HEAD', projectRoot: root, symbolMode: true })
    expect(out).toContain('alpha')
    expect(out).toContain('beta')
  })
})
