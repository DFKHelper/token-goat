/**
 * End-to-end regression for `token-goat diff "file::symbol" [refA..refB]`: drives the REAL,
 * unmocked pipeline -- a real git repo (execFileSync git, no mocked runGit), a real
 * indexFileSync seed against the real (test-isolated, see tests/setup/isolate-home.ts) global.db,
 * and the real runDiff command function -- so the "only this function's hunk, not an unrelated
 * changed function in the same file" behavior is proven against the actual git-diff-hunk-vs-
 * symbol-line-range intersection, not an injected-callback stand-in for it. Mirrors the real-DB,
 * real-git pattern already used by tests/read_commands_stale_self_heal_e2e.test.ts (indexFileSync
 * + a real run* command against the real DB) and tests/project.test.ts (execFileSync git for a
 * real repo fixture).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runDiff } from '../src/read_commands.js'

/** Capture stdout/stderr for a function call, same pattern as read_commands.test.ts. */
function capture(fn: () => void): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  try {
    fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = origErr
  }
  return { stdout, stderr }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('runDiff (real git repo + real index, no injected callbacks)', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'tg-diff-e2e-'))
    git(['init'], root)
    git(['config', 'user.email', 'test@example.com'], root)
    git(['config', 'user.name', 'Test'], root)
    return root
  }

  it('shows only the changed symbol\'s hunk, not an unrelated changed function in the same file', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'a.ts')
      writeFileSync(
        file,
        [
          'export function firstFn(): number {',
          '  return 1',
          '}',
          '',
          'export function secondFn(): number {',
          '  return 2',
          '}',
        ].join('\n') + '\n',
      )
      git(['add', 'a.ts'], root)
      git(['commit', '-m', 'initial'], root)

      indexFileSync(normalizePath(file))

      // Modify only secondFn -- firstFn's body is untouched on disk.
      writeFileSync(
        file,
        [
          'export function firstFn(): number {',
          '  return 1',
          '}',
          '',
          'export function secondFn(): number {',
          '  return 99 // changed',
          '}',
        ].join('\n') + '\n',
      )

      const { stdout, stderr } = capture(() => {
        expect(runDiff({ spec: `${file}::secondFn`, projectRoot: root })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('changed')
      expect(stdout).not.toContain('firstFn')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a clean, non-error "no changes" message for a symbol that did not change', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'b.ts')
      writeFileSync(
        file,
        [
          'export function stableFn(): number {',
          '  return 1',
          '}',
          '',
          'export function movingFn(): number {',
          '  return 2',
          '}',
        ].join('\n') + '\n',
      )
      git(['add', 'b.ts'], root)
      git(['commit', '-m', 'initial'], root)

      indexFileSync(normalizePath(file))

      // Only movingFn changes; stableFn's own hunk must report "no changes".
      writeFileSync(
        file,
        [
          'export function stableFn(): number {',
          '  return 1',
          '}',
          '',
          'export function movingFn(): number {',
          '  return 3 // moved',
          '}',
        ].join('\n') + '\n',
      )

      const { stdout, stderr } = capture(() => {
        expect(runDiff({ spec: `${file}::stableFn`, projectRoot: root })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('No changes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails cleanly (non-zero, no crash) for an unresolvable symbol spec', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'c.ts')
      writeFileSync(file, 'export function realFn(): number {\n  return 1\n}\n')
      git(['add', 'c.ts'], root)
      git(['commit', '-m', 'initial'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runDiff({ spec: `${file}::doesNotExistSym`, projectRoot: root })).toBe(1)
      })
      expect(stdout).toBe('')
      expect(stderr).toContain('doesNotExistSym')
      expect(stderr).toContain('not found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an explicit ref range only sees changes committed within that range, unlike the default unstaged diff', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'd.ts')
      writeFileSync(file, 'export function rangedFn(): number {\n  return 1\n}\n')
      git(['add', 'd.ts'], root)
      git(['commit', '-m', 'v1'], root)

      writeFileSync(file, 'export function rangedFn(): number {\n  return 2 // v2\n}\n')
      git(['add', 'd.ts'], root)
      git(['commit', '-m', 'v2'], root)

      indexFileSync(normalizePath(file))

      // No further edits are made on disk: the default (no-ref, unstaged-vs-index) diff has
      // nothing to show, while diffing the explicit v1..v2 commit range shows the change.
      const unstaged = capture(() => {
        expect(runDiff({ spec: `${file}::rangedFn`, projectRoot: root })).toBe(0)
      })
      expect(unstaged.stdout).toContain('No changes')

      const ranged = capture(() => {
        expect(runDiff({ spec: `${file}::rangedFn`, ref: 'HEAD~1..HEAD', projectRoot: root })).toBe(0)
      })
      expect(ranged.stdout).toContain('v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
