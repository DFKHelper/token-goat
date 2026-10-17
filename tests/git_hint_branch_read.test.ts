// Provenance: CAPTURE for every layout built by git itself below (`git init`, `git worktree add`, `git checkout --detach`, and `git init --ref-format=reftable` where this git has it), each checked against what `git rev-parse --abbrev-ref HEAD` prints for the same directory in the same run. CAPTURE too for the CRLF HEAD, the submodule, the symlinked repository, the tag with the branch's name, and the linked worktree whose commondir file is edited to name nothing, each held to the same git run in the same directory. HAND-DERIVED for the layouts only a hand-built tree can reach: a garbled HEAD, a `.git` file with a relative gitdir (the `gitdir: <path>` file format is gitrepository-layout(5)), and the reftable stub `ref: refs/heads/.invalid` (FORMAT-DERIVED from Documentation/technical/reftable.adoc in git's source: a reftable repository keeps that placeholder in HEAD and the real branch in the table).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readBranchWithoutSpawn } from '../src/git_hint.js'
import { runGit } from '../src/util.js'

const IDENTITY = ['-c', 'user.name=tg', '-c', 'user.email=tg@example.invalid']
let root = ''
let savedGitDir: string | undefined

function git(cwd: string, ...args: string[]): string {
  const result = runGit([...IDENTITY, ...args], { cwd, timeoutMs: 60_000 })
  expect(result.exitCode, `git ${args.join(' ')}: ${result.stderr}`).toBe(0)
  return result.stdout.trim()
}

/** What git itself says for `cwd`, the oracle every spawn-free answer is held to. */
function gitsAnswer(cwd: string): string {
  return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
}

function newRepo(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-branch-read-'))
  savedGitDir = process.env['GIT_DIR']
  delete process.env['GIT_DIR']
})

afterEach(() => {
  if (savedGitDir === undefined) delete process.env['GIT_DIR']
  else process.env['GIT_DIR'] = savedGitDir
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readBranchWithoutSpawn agrees with git', () => {
  it('reads a branch from the repository root and from a subdirectory', () => {
    const repo = newRepo('repo')
    const sub = path.join(repo, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    expect(readBranchWithoutSpawn(repo)).toBe(gitsAnswer(repo))
    expect(readBranchWithoutSpawn(sub)).toBe('main')
  })

  it('reads a branch with a slash in its name', () => {
    const repo = newRepo('slash')
    git(repo, 'checkout', '-q', '-b', 'feature/x-1')
    expect(readBranchWithoutSpawn(repo)).toBe(gitsAnswer(repo))
    expect(readBranchWithoutSpawn(repo)).toBe('feature/x-1')
  })

  it('reads each side of a linked worktree from its own HEAD', () => {
    const repo = newRepo('main-tree')
    const linked = path.join(root, 'linked-tree')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')
    fs.mkdirSync(path.join(linked, 'sub'))
    expect(fs.statSync(path.join(linked, '.git')).isFile(), 'precondition: a linked worktree has a .git file').toBe(true)
    expect(readBranchWithoutSpawn(linked)).toBe(gitsAnswer(linked))
    expect(readBranchWithoutSpawn(path.join(linked, 'sub'))).toBe('other')
    expect(readBranchWithoutSpawn(repo)).toBe('main')
  })

  it('reads a detached HEAD as HEAD, as git does', () => {
    const repo = newRepo('detached')
    git(repo, 'checkout', '-q', '--detach')
    expect(gitsAnswer(repo)).toBe('HEAD')
    expect(readBranchWithoutSpawn(repo)).toBe('HEAD')
  })

  it('reads the branch of a repository with no commit yet, where git itself exits 128', () => {
    const repo = path.join(root, 'unborn')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'trunk')
    expect(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, timeoutMs: 60_000 }).exitCode).not.toBe(0)
    expect(readBranchWithoutSpawn(repo)).toBe('trunk')
  })

  it('follows a .git file whose gitdir is relative to the folder holding it', () => {
    const bare = path.join(root, 'store.git')
    fs.mkdirSync(bare)
    git(bare, 'init', '-q', '--bare', '-b', 'relative-branch')
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    fs.writeFileSync(path.join(work, '.git'), 'gitdir: ../store.git\n')
    expect(readBranchWithoutSpawn(work)).toBe('relative-branch')
  })

  it('reads a HEAD written with CRLF line endings, as git does', () => {
    const repo = newRepo('crlf')
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\r\n')
    expect(gitsAnswer(repo)).toBe('main')
    expect(readBranchWithoutSpawn(repo)).toBe('main')
  })

  it('reads a submodule, whose .git file points into the superproject modules directory', () => {
    const lib = newRepo('lib')
    const superproject = newRepo('super')
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor')
    const sub = path.join(superproject, 'vendor')
    expect(fs.statSync(path.join(sub, '.git')).isFile(), 'precondition: a submodule has a .git file').toBe(true)
    git(sub, 'checkout', '-q', '-b', 'inside')
    expect(readBranchWithoutSpawn(sub)).toBe(gitsAnswer(sub))
    expect(readBranchWithoutSpawn(sub)).toBe('inside')
    expect(readBranchWithoutSpawn(superproject)).toBe('main')
  })

  it('reads a repository reached through a symlink or junction', () => {
    const repo = newRepo('real')
    const link = path.join(root, 'link')
    fs.symlinkSync(repo, link, 'junction')
    try {
      fs.mkdirSync(path.join(repo, 'deep'))
      expect(readBranchWithoutSpawn(link)).toBe(gitsAnswer(link))
      expect(readBranchWithoutSpawn(path.join(link, 'deep'))).toBe('main')
    } finally {
      try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) }
    }
  })
})

describe('readBranchWithoutSpawn says unknown rather than guess', () => {
  function repoWithHead(head: string): string {
    const dir = path.join(root, 'hand')
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head)
    return dir
  }

  it.each([
    ['a garbled HEAD', 'not a head\n'],
    ['an empty HEAD', ''],
    ['the reftable placeholder', 'ref: refs/heads/.invalid\n'],
    ['a ref outside refs/heads', 'ref: refs/remotes/origin/main\n'],
    ['a name with a space', 'ref: refs/heads/two words\n'],
    ['a name with a control character', 'ref: refs/heads/a\u0001b\n'],
    ['a name with a dot-dot', 'ref: refs/heads/a..b\n'],
    ['a name ending in .lock', 'ref: refs/heads/main.lock\n'],
    ['a short object id', 'abc123\n'],
  ])('%s', (_label, head) => {
    expect(readBranchWithoutSpawn(repoWithHead(head))).toBeNull()
  })

  it('a repository directory with no HEAD file', () => {
    const dir = path.join(root, 'no-head')
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    expect(readBranchWithoutSpawn(dir)).toBeNull()
  })

  it('a .git file that names nothing', () => {
    const dir = path.join(root, 'bad-file')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '.git'), 'nonsense\n')
    expect(readBranchWithoutSpawn(dir)).toBeNull()
  })

  it('a .git file pointing at a missing directory', () => {
    const dir = path.join(root, 'dangling')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ./gone\n')
    expect(readBranchWithoutSpawn(dir)).toBeNull()
  })

  it('an exported GIT_DIR, which names a repository the directory walk cannot see', () => {
    const repo = newRepo('with-git-dir')
    process.env['GIT_DIR'] = path.join(repo, '.git')
    expect(readBranchWithoutSpawn(repo)).toBeNull()
  })

  it('a reftable repository, whose HEAD file is only a placeholder', (ctx) => {
    const dir = path.join(root, 'reftable')
    fs.mkdirSync(dir)
    const init = runGit(['init', '-q', '--ref-format=reftable', '-b', 'tabled'], { cwd: dir, timeoutMs: 60_000 })
    if (init.exitCode !== 0) ctx.skip()
    expect(readBranchWithoutSpawn(dir)).toBeNull()
  })

  describe('where git prints something other than the plain name or refuses', () => {
    it('a tag with the branch name, where git prints heads/<name>, loose or packed', () => {
      const repo = newRepo('tagged')
      git(repo, 'tag', 'v1')
      expect(readBranchWithoutSpawn(repo)).toBe('main')
      git(repo, 'tag', 'main')
      expect(gitsAnswer(repo)).toBe('heads/main')
      expect(readBranchWithoutSpawn(repo)).toBeNull()
      git(repo, 'pack-refs', '--all')
      expect(fs.existsSync(path.join(repo, '.git', 'refs', 'tags', 'main')), 'precondition: the tag is packed now').toBe(false)
      expect(gitsAnswer(repo)).toBe('heads/main')
      expect(readBranchWithoutSpawn(repo)).toBeNull()
    })

    it('a tag with the branch name held by the main repository, seen from a linked worktree', () => {
      const repo = newRepo('tag-main-tree')
      const linked = path.join(root, 'tag-linked')
      git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')
      expect(readBranchWithoutSpawn(linked)).toBe('other')
      git(repo, 'tag', 'other')
      expect(gitsAnswer(linked)).toBe('heads/other')
      expect(readBranchWithoutSpawn(linked)).toBeNull()
    })

    // CAPTURE: each ref is made by git itself in a repository whose HEAD is the branch, and git's own answer is asserted before the hint is, so the expectation is git's output and not this module's rule (git 2.53 prints heads/<name> for every row).
    it.each([
      ['a remote HEAD symref of the same name (refs/remotes/<name>/HEAD)', 'origin', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']],
      ['a remote HEAD ref that pack-refs can hold', 'upstream', ['update-ref', 'refs/remotes/upstream/HEAD', 'HEAD']],
      ['a remote-tracking ref of the same name (refs/remotes/<name>)', 'mirror', ['update-ref', 'refs/remotes/mirror', 'HEAD']],
      ['a ref directly under refs/ of the same name, as a stash is', 'stash', ['update-ref', 'refs/stash', 'HEAD']],
    ])('%s, where git prints heads/<name>, loose or packed', (_label, name, makeRef) => {
      const repo = newRepo(`ambiguous-${name}`)
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      git(repo, 'checkout', '-q', '-b', name)
      expect(readBranchWithoutSpawn(repo)).toBe(name)
      git(repo, ...makeRef)
      expect(gitsAnswer(repo)).toBe(`heads/${name}`)
      expect(readBranchWithoutSpawn(repo)).toBeNull()
      git(repo, 'pack-refs', '--all')
      expect(gitsAnswer(repo)).toBe(`heads/${name}`)
      expect(readBranchWithoutSpawn(repo)).toBeNull()
    })

    it('an exported GIT_CEILING_DIRECTORIES, which can stop the walk short of the repository', () => {
      const repo = newRepo('ceiling')
      const saved = process.env['GIT_CEILING_DIRECTORIES']
      process.env['GIT_CEILING_DIRECTORIES'] = path.join(root, 'elsewhere')
      try {
        expect(readBranchWithoutSpawn(repo)).toBeNull()
      } finally {
        if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES']
        else process.env['GIT_CEILING_DIRECTORIES'] = saved
      }
      expect(readBranchWithoutSpawn(repo)).toBe('main')
    })

    it('a linked worktree whose common directory is gone, which git refuses', () => {
      const repo = newRepo('stale-main-tree')
      const linked = path.join(root, 'stale-linked')
      git(repo, 'worktree', 'add', '-q', linked, '-b', 'orphaned')
      const pointer = path.join(repo, '.git', 'worktrees', 'stale-linked', 'commondir')
      expect(fs.existsSync(pointer), 'precondition: a linked worktree keeps a commondir file').toBe(true)
      fs.writeFileSync(pointer, '../../gone\n')
      expect(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: linked, timeoutMs: 60_000 }).exitCode).not.toBe(0)
      expect(readBranchWithoutSpawn(linked)).toBeNull()
    })

    it('a .git file naming a directory that exists but holds no repository', () => {
      const dir = path.join(root, 'hollow')
      fs.mkdirSync(path.join(root, 'empty-target'))
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(root, 'empty-target').split(path.sep).join('/')}\n`)
      expect(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: 60_000 }).exitCode).not.toBe(0)
      expect(readBranchWithoutSpawn(dir)).toBeNull()
    })
  })
})
