/**
 * End-to-end regression for `token-goat log "file::symbol" [ref]`: drives the REAL,
 * unmocked pipeline -- a real git repo (execFileSync git, no mocked runGit), a real
 * indexFileSync seed against the real (test-isolated, see tests/setup/isolate-home.ts) global.db,
 * and the real runLog command function -- so the `git log -L` line-range-tracking behavior
 * (a symbol's history surviving earlier commits that shift its lines up/down) is proven
 * against real git output, not a hand-authored stand-in for its format. Mirrors the real-DB,
 * real-git pattern already used by tests/read_commands_diff_e2e.test.ts.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runLog } from '../src/read_commands.js'

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

describe('runLog (real git repo + real index, no injected callbacks)', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'tg-log-e2e-'))
    git(['init'], root)
    git(['config', 'user.email', 'test@example.com'], root)
    git(['config', 'user.name', 'Test'], root)
    return root
  }

  it('shows commit history scoped to the symbol, respecting a custom --max-count', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'a.ts')
      writeFileSync(
        file,
        ['export function historyFn(): number {', '  return 1', '}'].join('\n') + '\n',
      )
      git(['add', 'a.ts'], root)
      git(['commit', '-m', 'add historyFn v1'], root)

      writeFileSync(
        file,
        ['export function historyFn(): number {', '  return 2 // v2', '}'].join('\n') + '\n',
      )
      git(['add', 'a.ts'], root)
      git(['commit', '-m', 'bump historyFn to v2'], root)

      writeFileSync(
        file,
        ['export function historyFn(): number {', '  return 3 // v3', '}'].join('\n') + '\n',
      )
      git(['add', 'a.ts'], root)
      git(['commit', '-m', 'bump historyFn to v3'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::historyFn`, projectRoot: root })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('historyFn')
      expect(stdout).toContain('bump historyFn to v3')
      expect(stdout).toContain('bump historyFn to v2')
      expect(stdout).toContain('add historyFn v1')

      const { stdout: capped } = capture(() => {
        expect(runLog({ spec: `${file}::historyFn`, projectRoot: root, maxCount: 1 })).toBe(0)
      })
      expect(capped).toContain('bump historyFn to v3')
      expect(capped).not.toContain('bump historyFn to v2')
      expect(capped).not.toContain('add historyFn v1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tracks the symbol\'s line range through commits that shift content above it', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'b.ts')
      writeFileSync(
        file,
        ['export function trackedFn(): number {', '  return 1', '}'].join('\n') + '\n',
      )
      git(['add', 'b.ts'], root)
      git(['commit', '-m', 'add trackedFn'], root)

      // Insert an unrelated function above trackedFn, shifting its line range down. A naive
      // fixed-line-range history (not git's own -L tracking) would lose trackedFn's earlier
      // history once its line numbers move.
      writeFileSync(
        file,
        [
          'export function precedingFn(): number {',
          '  return 0',
          '}',
          '',
          'export function trackedFn(): number {',
          '  return 2 // moved and changed',
          '}',
        ].join('\n') + '\n',
      )
      git(['add', 'b.ts'], root)
      git(['commit', '-m', 'insert an unrelated function, bump trackedFn'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::trackedFn`, projectRoot: root })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('add trackedFn')
      expect(stdout).toContain('insert an unrelated function, bump trackedFn')
      // The scoped diff must track trackedFn's shifted range, not precedingFn's own definition.
      expect(stdout).not.toContain('export function precedingFn')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an explicit ref narrows history to commits reachable from that ref', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'c.ts')
      writeFileSync(file, 'export function rangedFn(): number {\n  return 1\n}\n')
      git(['add', 'c.ts'], root)
      git(['commit', '-m', 'v1'], root)

      writeFileSync(file, 'export function rangedFn(): number {\n  return 2 // v2\n}\n')
      git(['add', 'c.ts'], root)
      git(['commit', '-m', 'v2'], root)

      indexFileSync(normalizePath(file))

      const full = capture(() => {
        expect(runLog({ spec: `${file}::rangedFn`, projectRoot: root })).toBe(0)
      })
      expect(full.stdout).toContain('v1')
      expect(full.stdout).toContain('v2')

      const narrowed = capture(() => {
        expect(runLog({ spec: `${file}::rangedFn`, ref: 'HEAD~1', projectRoot: root })).toBe(0)
      })
      expect(narrowed.stdout).toContain('v1')
      expect(narrowed.stdout).not.toContain('v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails cleanly (non-zero, no crash) for an unresolvable symbol spec', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'd.ts')
      writeFileSync(file, 'export function realFn(): number {\n  return 1\n}\n')
      git(['add', 'd.ts'], root)
      git(['commit', '-m', 'initial'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::doesNotExistSym`, projectRoot: root })).toBe(1)
      })
      expect(stdout).toBe('')
      expect(stderr).toContain('doesNotExistSym')
      expect(stderr).toContain('not found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('errors up front on an ambiguous spec matching several definitions in the same file', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'e.ts')
      writeFileSync(
        file,
        [
          'export function dupSym(): number {',
          '  return 1',
          '}',
          '',
          'export function dupSym(): number {',
          '  return 2',
          '}',
        ].join('\n') + '\n',
      )
      git(['add', 'e.ts'], root)
      git(['commit', '-m', 'initial'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::dupSym`, projectRoot: root })).toBe(1)
      })
      expect(stdout).toBe('')
      expect(stderr).toContain('Ambiguous')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits a structured --json envelope that round-trips into valid JSON with per-commit fields', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'f.ts')
      writeFileSync(file, 'export function jsonFn(): number {\n  return 1\n}\n')
      git(['add', 'f.ts'], root)
      git(['commit', '-m', 'add jsonFn'], root)

      writeFileSync(file, 'export function jsonFn(): number {\n  return 2 // v2\n}\n')
      git(['add', 'f.ts'], root)
      git(['commit', '-m', 'bump jsonFn'], root)

      indexFileSync(normalizePath(file))

      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::jsonFn`, projectRoot: root, json: true })).toBe(0)
      })
      expect(stderr).toBe('')
      const parsed = JSON.parse(stdout) as {
        symbol: string
        file: string
        lineStart: number
        lineEnd: number
        commits: Array<{ hash: string; author: string; date: string; message: string; diff: string }>
        truncated: boolean
        totalCount: number
      }
      expect(parsed.symbol).toBe('jsonFn')
      expect(parsed.commits).toHaveLength(2)
      for (const entry of parsed.commits) {
        expect(entry.hash).toMatch(/^[0-9a-f]{40}$/)
        expect(entry.author).toContain('Test')
        expect(entry.date.length).toBeGreaterThan(0)
      }
      expect(parsed.commits[0]?.message).toBe('bump jsonFn')
      expect(parsed.commits[0]?.diff).toContain('v2')
      expect(parsed.commits[1]?.message).toBe('add jsonFn')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a clean, non-error "no history" message when git log has nothing to show', () => {
    const root = makeRepo()
    try {
      const file = join(root, 'g.ts')
      writeFileSync(file, 'export function onceFn(): number {\n  return 1\n}\n')
      git(['add', 'g.ts'], root)
      git(['commit', '-m', 'add onceFn'], root)

      indexFileSync(normalizePath(file))

      // --max-count=0 asks git for zero commits, exercising the empty-stdout branch without
      // relying on a symbol that has literally never been committed (which wouldn't resolve).
      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: `${file}::onceFn`, projectRoot: root, maxCount: 0 })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('No history')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
