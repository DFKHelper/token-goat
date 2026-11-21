/** Guard: a guard test finds the repo from its own location (ROOT), never from the launch directory (process.cwd()). */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

// Provenance: HAND-DERIVED. The file list is read from disk at run time; no list is copied into this file.
const GUARD_DIR = path.join(ROOT, 'tests', 'guards')
const SELF = 'guards_resolve_root_from_own_location.test.ts'
const ALLOW = /\ballow-cwd:\s*\S/
// Strings stay (a call inside a string literal still counts); comments are blanked to the same width so offsets hold.
const STRING_OR_COMMENT = /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const LAUNCH_DIR_SHAPES: readonly RegExp[] = [
  /(?<![\w$])process\s*\.\s*cwd\s*\(\s*\)/g,
  /(?<![\w$])process\s*\[\s*(['"`])cwd\1\s*\]\s*\(\s*\)/g,
  /(?<![\w$])path\s*\.\s*resolve\s*\(\s*(?:(['"`])\.\1\s*)?\)/g,
]
const DESTRUCTURED_FROM_PROCESS = /\{[^{}]*\bcwd\b[^{}]*\}\s*=\s*process\b/
const BARE_CWD_CALL = /(?<![\w$.])cwd\s*\(\s*\)/g
const RESOLVE_FROM_NODE_PATH = /\bimport\s*\{[^}]*\bresolve\b[^}]*\}\s*from\s*['"](?:node:)?path['"]/
const BARE_RESOLVE_CALL = /(?<![\w$.])resolve\s*\(\s*(?:(['"`])\.\1\s*)?\)/g

function maskComments(text: string): string {
  return text.replace(STRING_OR_COMMENT, (match: string, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, ' ') : match,
  )
}

function excused(lines: readonly string[], i: number): boolean {
  return ALLOW.test(lines[i] ?? '') || (i > 0 && ALLOW.test(lines[i - 1] ?? ''))
}

/** Each launch-directory read in one guard file, as file:line, unless its line or the line above carries an allow-cwd. */
function launchDirHits(name: string): string[] {
  const raw = fs.readFileSync(path.join(GUARD_DIR, name), 'utf8')
  const code = maskComments(raw)
  const shapes: RegExp[] = [...LAUNCH_DIR_SHAPES]
  if (DESTRUCTURED_FROM_PROCESS.test(code)) shapes.push(BARE_CWD_CALL)
  if (RESOLVE_FROM_NODE_PATH.test(code)) shapes.push(BARE_RESOLVE_CALL)
  const lines = raw.split(/\r?\n/)
  const hits = new Set<string>()
  for (const shape of shapes) {
    for (const m of code.matchAll(shape)) {
      const line = code.slice(0, m.index).split('\n').length
      if (!excused(lines, line - 1)) hits.add(`tests/guards/${name}:${line}`)
    }
  }
  return [...hits]
}

/** allow-cwd lines per guard file, excluding this file, whose own regexes quote the token. */
function excuseCounts(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const name of files) {
    if (name === SELF) continue
    const n = fs.readFileSync(path.join(GUARD_DIR, name), 'utf8').split(/\r?\n/).filter((l) => ALLOW.test(l)).length
    if (n > 0) counts.set(name, n)
  }
  return counts
}

// Pinned by file and line count. A new or moved excuse fails until its entry is added here with its reason.
const PINNED_EXCUSES: Readonly<Record<string, number>> = {
  // hook payload cwd simulates the session's launch directory, not a repo root
  'hint_suggestions_parse_as_one_powershell_statement.test.ts': 1,
  // quoted text inside a finding message, not a root lookup
  'installer_writes_are_contained.test.ts': 1,
  // the spawned child runs with the fixture root as its cwd, so this path lies inside that root
  'permission_filter_single_predicate.test.ts': 1,
  // provenance text naming a code path, not a root lookup
  'pre_handler_fs_touches_are_gated.test.ts': 3,
  // the directory this test chdirs into and restores, not a repo root
  'root_caches_reset.test.ts': 1,
}

describe('guard tests resolve the repo from their own location', () => {
  // 228 files when this was pinned; 220 lets up to 8 be removed in one change, and a larger drop fails here.
  const population = (): readonly string[] =>
    pinnedPopulation({
      what: 'tests/guards/*.test.ts files scanned for launch-directory repo roots',
      items: fs.readdirSync(GUARD_DIR).filter((n) => n.endsWith('.test.ts')).sort(),
      floor: 220,
      mustInclude: [SELF, 'spawned_data_dir_is_isolated.test.ts'],
    })

  it('reads no repo path through the launch directory without an allow-cwd reason', () => {
    expect(
      population().flatMap(launchDirHits),
      'each of these reads the launch directory as the repo root, so a run from another checkout tests that checkout. Use ROOT from tests/helpers/bundle.ts, or put `// allow-cwd: <why the launch directory is what is under test>` on the line above.',
    ).toEqual([])
  })

  it('keeps allow-cwd excuses to the pinned files and line counts', () => {
    const actual = excuseCounts(population())
    const names = [...new Set([...actual.keys(), ...Object.keys(PINNED_EXCUSES)])].sort()
    const drift = names
      .filter((n) => (actual.get(n) ?? 0) !== (PINNED_EXCUSES[n] ?? 0))
      .map((n) => `tests/guards/${n}: ${actual.get(n) ?? 0} allow-cwd line(s), pinned ${PINNED_EXCUSES[n] ?? 0}`)
    expect(
      drift,
      'a new or changed allow-cwd excuse: add its file to PINNED_EXCUSES in this test with the count and the reason the launch directory is under test, or remove the excuse',
    ).toEqual([])
  })
})
