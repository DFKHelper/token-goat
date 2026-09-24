/** Regression: `changed` (and `changed --symbol`) used to book `sumFileSizes` -- the whole on-disk size of every changed file -- as the "bytes saved" baseline, the same defect shape `refs` already shipped once (crediting whole-file bytes for what is really a search-shaped result). A single real ledger event on this project booked 716,446+ tokens for one `changed` invocation this way. The honest baseline is the size of the diff the command actually replaces reading (`git diff --unified=0`), which for a tiny one-line change on a large file is orders of magnitude smaller than the file itself. Provenance: CAPTURE. The repo, commit, and edit below are real; `runChanged` is exercised end to end against a real git repository and the real global stats DB (isolated per tests/setup/isolate-home.ts), not a mock. The must-not-happen assertion (bytesSaved must not approach the on-disk file size) is HAND-DERIVED from the file size this test itself writes. */
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { runChanged } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES, CLAUDE_CODE_PERSISTED_PREVIEW_BYTES } from '../src/delivery_cap.js'

function sumChangedLookup(): { events: number; bytes: number } {
  const bucket = summarize(30).by_kind['changed_lookup']
  return { events: bucket?.events ?? 0, bytes: bucket?.bytes_saved ?? 0 }
}

describe('changed credits the diff, never the whole changed file (#defect-2)', () => {
  it('a one-line edit on a large file books far less than the file size, in both plain and --symbol mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-changed-baseline-'))
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' })

      const file = join(root, 'big.ts')
      // A large file (~50KB) with one function per line, so a one-line change has a small diff against a large on-disk size -- the exact shape that exposed the whole-file-credit bug.
      const lines: string[] = []
      for (let i = 0; i < 1200; i++) lines.push(`export function bigFileFn${i}() { return ${i} } // padding padding padding padding`)
      writeFileSync(file, lines.join('\n') + '\n')
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })

      const fileBytes = statSync(file).size
      expect(fileBytes).toBeGreaterThan(40_000) // sanity: the file really is large

      lines[500] = 'export function bigFileFn500() { return 999999 } // padding padding padding padding CHANGED'
      writeFileSync(file, lines.join('\n') + '\n')
      // Symbol mode queries the project's symbol index, not the file on disk directly -- index the post-edit content so querySymbols has rows to scope against the diff hunks.
      indexFileSync(normalizePath(file))

      // --- plain mode ---
      const before1 = sumChangedLookup()
      const code1 = runChanged({ ref: 'HEAD', projectRoot: root })
      expect(code1).toBe(0)
      const after1 = sumChangedLookup()
      expect(after1.events).toBe(before1.events + 1)
      const creditedPlain = after1.bytes - before1.bytes
      // Must-not-happen: crediting anywhere near the whole file (the pre-fix defect).
      expect(creditedPlain, 'plain mode must not credit the whole changed file').toBeLessThan(fileBytes / 10)

      // --- --symbol mode ---
      const before2 = sumChangedLookup()
      const code2 = runChanged({ ref: 'HEAD', projectRoot: root, symbolMode: true })
      expect(code2).toBe(0)
      const after2 = sumChangedLookup()
      expect(after2.events).toBe(before2.events + 1)
      const creditedSymbol = after2.bytes - before2.bytes
      expect(creditedSymbol, '--symbol mode must not credit the whole changed file either').toBeLessThan(fileBytes / 10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// HAND-DERIVED: the diff size is measured here with git itself, independently of runChanged; the 20,000-byte cap and 2KB preview are the CAPTURE-derived constants in src/delivery_cap.ts.
describe('changed prices a large diff at what the harness would have delivered', () => {
  it('credits at most the 2KB preview in both modes once the diff is past the Bash cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-changed-delivered-'))
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' })
      const file = join(root, 'big.ts')
      const lines: string[] = []
      for (let i = 0; i < 1200; i++) lines.push(`export function bigFileFn${i}() { return ${i} } // padding padding padding padding`)
      writeFileSync(file, lines.join('\n') + '\n')
      execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })
      for (let i = 0; i < 800; i++) lines[i] = `export function bigFileFn${i}() { return ${i + 1} } // padding padding padding padding`
      writeFileSync(file, lines.join('\n') + '\n')
      indexFileSync(normalizePath(file))

      const diffBytes = Buffer.byteLength(execFileSync('git', ['diff', 'HEAD', '--unified=0', '--', 'big.ts'], { cwd: root, encoding: 'utf8' }), 'utf8')
      expect(diffBytes).toBeGreaterThan(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES)

      const before1 = sumChangedLookup()
      expect(runChanged({ ref: 'HEAD', projectRoot: root })).toBe(0)
      // Plain mode prints the one changed path, so the credit is the preview less those bytes, not the whole diff less them.
      expect(sumChangedLookup().bytes - before1.bytes).toBe(CLAUDE_CODE_PERSISTED_PREVIEW_BYTES - Buffer.byteLength('big.ts', 'utf8'))

      const before2 = sumChangedLookup()
      expect(runChanged({ ref: 'HEAD', projectRoot: root, symbolMode: true })).toBe(0)
      // 800 changed functions print more than the preview holds, so the credit floors at 1.
      expect(sumChangedLookup().bytes - before2.bytes).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
