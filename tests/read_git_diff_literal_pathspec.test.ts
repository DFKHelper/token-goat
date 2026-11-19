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

  it('still diffs a plain file against a ref', () => {
    setup(null)
    const plain = `${path.join(root, 'a.ts')}::other`
    const r = capture(() => runDiff({ spec: plain, projectRoot: root, ref: 'HEAD' }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('DENIEDTEXT')
  })
})
