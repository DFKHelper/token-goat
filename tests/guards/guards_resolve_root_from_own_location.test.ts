/** Guard: a guard test finds the repo from its own location (ROOT), never from the launch directory (process.cwd()). */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

// Provenance: HAND-DERIVED. The file list is read from disk at run time; no list is copied into this file.
const GUARD_DIR = path.join(ROOT, 'tests', 'guards')
const CWD_CALL = /process\.cwd\(\)/
const ALLOW = /\ballow-cwd:\s*\S/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

/** Each process.cwd() call in a guard test that its line and the line above do not excuse with `allow-cwd: <why>`. */
function unexcusedCwdCalls(files: readonly string[]): string[] {
  const offenders: string[] = []
  for (const name of files) {
    const lines = fs.readFileSync(path.join(GUARD_DIR, name), 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (COMMENT_LINE.test(line) || !CWD_CALL.test(line)) return
      if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1] ?? ''))) return
      offenders.push(`tests/guards/${name}:${i + 1}`)
    })
  }
  return offenders
}

describe('guard tests resolve the repo from their own location', () => {
  it('reads no repo path through the launch directory without an allow-cwd reason', () => {
    const files = pinnedPopulation({
      what: 'tests/guards/*.test.ts files scanned for launch-directory repo roots',
      items: fs.readdirSync(GUARD_DIR).filter((n) => n.endsWith('.test.ts')).sort(),
      floor: 200,
      mustInclude: ['guards_resolve_root_from_own_location.test.ts', 'spawned_data_dir_is_isolated.test.ts'],
    })
    expect(
      unexcusedCwdCalls(files),
      'each of these reads the launch directory as the repo root, so a run from another checkout tests that checkout. Use ROOT from tests/helpers/bundle.ts, or put `// allow-cwd: <why the launch directory is what is under test>` on the line above.',
    ).toEqual([])
  })
})
