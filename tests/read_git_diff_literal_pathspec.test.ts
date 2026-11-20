/** `diff "file::symbol"` matches the indexed path literally: `[a].ts` must not pull in the hunks of `a.ts`. */
// Provenance: HAND-DERIVED. A real temporary git repo; pathspec rules: git-scm.com/docs/gitglossary
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { keepRequestedFile, runDiff } from '../src/read_git.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

const git = (args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'ignore' }) }
const body = (name: string, ret: string): string =>
  `export function ${name}(): string {\n  return '${ret}'\n}\n`

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  const o = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: unknown) => { out += String(c); return true }) as typeof process.stdout.write
  process.stderr.write = ((c: unknown) => { err += String(c); return true }) as typeof process.stderr.write
  try {
    return { code: fn(), out, err }
  } finally {
    process.stdout.write = o
    process.stderr.write = e
  }
}

function setup(denyRule: string | null): void {
  fs.writeFileSync(path.join(root, '[a].ts'), body('target', 'old'))
  fs.writeFileSync(path.join(root, 'a.ts'), body('other', 'old'))
  git(['add', '.'])
  git(['commit', '-m', 'initial'])
  fs.writeFileSync(path.join(root, '[a].ts'), body('target', 'ALLOWEDCHANGE'))
  fs.writeFileSync(path.join(root, 'a.ts'), body('other', 'DENIEDTEXT'))
  indexFileSync(normalizePath(path.join(root, '[a].ts')))
  indexFileSync(normalizePath(path.join(root, 'a.ts')))
  if (denyRule !== null) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    const rules = { permissions: { deny: [denyRule] } }
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(rules))
    resetReadDenyCache()
    resetPermissionSourceCache()
  }
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-diff-lit-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-diff-lit-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'core.autocrlf', 'false'])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
})

afterEach(() => {
  cwdSpy.mockRestore()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetReadDenyCache()
  resetPermissionSourceCache()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(cfg, { recursive: true, force: true })
})

const spec = (): string => `${path.join(root, '[a].ts')}::target`
const newSpec = (): string => `${path.join(root, 'new.ts')}::target`

describe('symbol diff of a file whose name holds a glob character', () => {
  it('prints its own hunk and none of the sibling a.ts, with no deny rule at all', () => {
    setup(null)
    const r = capture(() => runDiff({ spec: spec(), projectRoot: root }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('ALLOWEDCHANGE')
    expect(r.out, 'the glob [a] must not match a.ts').not.toContain('DENIEDTEXT')
  })

  it('prints no text of a denied sibling (text mode)', () => {
    setup('Read(a.ts)')
    const r = capture(() => runDiff({ spec: spec(), projectRoot: root }))
    expect(r.out).toContain('ALLOWEDCHANGE')
    expect(r.out + r.err).not.toContain('DENIEDTEXT')
  })

  it('prints no text of a denied sibling (json)', () => {
    setup('Read(a.ts)')
    const r = capture(() => runDiff({ spec: spec(), projectRoot: root, json: true }))
    expect(r.out).toContain('ALLOWEDCHANGE')
    expect(r.out + r.err).not.toContain('DENIEDTEXT')
  })

  it('prints no text of a denied sibling (comma list, json)', () => {
    setup('Read(a.ts)')
    const list = `${path.join(root, '[a].ts')}::target,target`
    const r = capture(() => runDiff({ spec: list, projectRoot: root, json: true }))
    expect(r.out).toContain('ALLOWEDCHANGE')
    expect(r.out + r.err).not.toContain('DENIEDTEXT')
  })

  it('prints no text of a denied sibling (cross-file list, json)', () => {
    setup('Read(a.ts)')
    const both = `${path.join(root, '[a].ts')}::target,${path.join(root, '[a].ts')}::target`
    const r = capture(() => runDiff({ spec: both, projectRoot: root, json: true }))
    expect(r.out).toContain('ALLOWEDCHANGE')
    expect(r.out + r.err).not.toContain('DENIEDTEXT')
  })

  it('keeps only the sections whose header names the requested file', () => {
    const text = [
      'diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-x', '+SIBLING',
      'diff --git a/[a].ts b/[a].ts', '@@ -1 +1 @@', '+MINE', '',
    ].join('\n')
    const kept = keepRequestedFile(text, '/proj/[a].ts')
    expect(kept).toContain('MINE')
    expect(kept).not.toContain('SIBLING')
    expect(keepRequestedFile(text, '/proj/a.ts')).not.toContain('MINE')
  })

  it('drops a section whose header has no a/ b/ prefix, and says so', () => {
    // HAND-DERIVED: the header git prints under diff.noprefix=true (no a/ or b/); never guessed to be the file.
    const text = ['diff --git [a].ts [a].ts', '@@ -1 +1 @@', '+NOPREFIX', ''].join('\n')
    let kept = ''
    const r = capture(() => { kept = keepRequestedFile(text, '/proj/[a].ts'); return 0 })
    expect(kept).not.toContain('NOPREFIX')
    expect(r.err).toContain('omitted:')
  })

  it('reads the quoted header form git prints for an unusual name', () => {
    // FORMAT-DERIVED: git-scm.com/docs/git-diff header format: a name with a quote is C-quoted with its prefix.
    const text = [
      'diff --git "a/q\\"u.ts" "b/q\\"u.ts"', '@@ -1 +1 @@', '+MINE',
      'diff --git "a/o\\"ther.ts" "b/o\\"ther.ts"', '@@ -1 +1 @@', '+OTHER', '',
    ].join('\n')
    const kept = keepRequestedFile(text, '/proj/q"u.ts')
    expect(kept).toContain('MINE')
    expect(kept).not.toContain('OTHER')
  })

  it('prints no denied text when report.ts became a directory and diff.noprefix is set', () => {
    // Traced trigger: the index still holds a symbol for report.ts, now a directory holding a denied file.
    git(['config', 'diff.noprefix', 'true'])
    fs.writeFileSync(path.join(root, 'report.ts'), body('target', 'old'))
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    indexFileSync(normalizePath(path.join(root, 'report.ts')))
    fs.rmSync(path.join(root, 'report.ts'))
    fs.mkdirSync(path.join(root, 'report.ts'))
    fs.writeFileSync(path.join(root, 'report.ts', 'inner.ts'), body('target', 'DENIEDTEXT'))
    git(['add', '.'])
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    const rules = { permissions: { deny: ['Read(/report.ts/inner.ts)'] } }
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(rules))
    resetReadDenyCache()
    resetPermissionSourceCache()
    const spec = `${path.join(root, 'report.ts')}::target`
    const r = capture(() => runDiff({ spec, projectRoot: root, ref: 'HEAD' }))
    expect(r.out + r.err).not.toContain('DENIEDTEXT')
  })

  it('diffs a changed file when GIT_LITERAL_PATHSPECS=1 is in the environment', () => {
    // CAPTURE: git 2.53.0 under GIT_LITERAL_PATHSPECS=1 reads `:(literal)` as part of the file name.
    setup(null)
    const before = process.env['GIT_LITERAL_PATHSPECS']
    process.env['GIT_LITERAL_PATHSPECS'] = '1'
    try {
      const plain = `${path.join(root, 'a.ts')}::other`
      const r = capture(() => runDiff({ spec: plain, projectRoot: root, ref: 'HEAD' }))
      expect(r.out).toContain('DENIEDTEXT')
    } finally {
      if (before === undefined) delete process.env['GIT_LITERAL_PATHSPECS']
      else process.env['GIT_LITERAL_PATHSPECS'] = before
    }
  })

  it('answers "no changes" for a file that was only renamed', () => {
    fs.writeFileSync(path.join(root, 'old.ts'), body('target', 'same'))
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    git(['mv', 'old.ts', 'new.ts'])
    indexFileSync(normalizePath(path.join(root, 'new.ts')))
    const r = capture(() => runDiff({ spec: newSpec(), projectRoot: root, ref: 'HEAD' }))
    expect(r.out).toContain('No changes')
  })

  it('shows only the real edit of a renamed file, not the whole file as new', () => {
    fs.writeFileSync(path.join(root, 'old.ts'), `${body('target', 'same')}${body('keep', 'KEEPTEXT')}`)
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    git(['mv', 'old.ts', 'new.ts'])
    fs.writeFileSync(path.join(root, 'new.ts'), `${body('target', 'EDITED')}${body('keep', 'KEEPTEXT')}`)
    indexFileSync(normalizePath(path.join(root, 'new.ts')))
    const r = capture(() => runDiff({ spec: newSpec(), projectRoot: root, ref: 'HEAD' }))
    expect(r.out).toContain('EDITED')
    expect(r.out).not.toContain('KEEPTEXT')
  })

  it('withholds a rename whose source is under a deny rule while its destination is not', () => {
    fs.writeFileSync(path.join(root, 'old.ts'), body('target', 'SOURCETEXT'))
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    git(['mv', 'old.ts', 'new.ts'])
    fs.writeFileSync(path.join(root, 'new.ts'), body('target', 'EDITED'))
    indexFileSync(normalizePath(path.join(root, 'new.ts')))
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    const rules = { permissions: { deny: ['Read(/old.ts)'] } }
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(rules))
    resetReadDenyCache()
    resetPermissionSourceCache()
    const r = capture(() => runDiff({ spec: newSpec(), projectRoot: root, ref: 'HEAD' }))
    expect(r.out + r.err).not.toContain('SOURCETEXT')
    expect(r.err).toContain('omitted:')
    expect(r.err).toContain('old.ts')
  })

  it('still diffs a plain file against a ref', () => {
    setup(null)
    const plain = `${path.join(root, 'a.ts')}::other`
    const r = capture(() => runDiff({ spec: plain, projectRoot: root, ref: 'HEAD' }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('DENIEDTEXT')
  })
})
