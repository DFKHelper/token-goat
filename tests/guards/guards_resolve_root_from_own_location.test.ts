/** Guard: a guard test finds the repo from its own location (ROOT), never from the launch directory (process.cwd()). */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

// Provenance: HAND-DERIVED. The file list is read from disk at run time; no list is copied into this file.
const GUARD_DIR = path.join(ROOT, 'tests', 'guards')
const SELF = 'guards_resolve_root_from_own_location.test.ts'
const ALLOW = /\/\/\s*allow-cwd:\s*(\S.*)$/
// Strings stay (a call inside a string literal still counts); comments are blanked to the same width so offsets hold.
const STRING_OR_COMMENT = /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const LAUNCH_DIR_SHAPES: readonly RegExp[] = [
  /(?<![\w$])process\s*\??\.\s*cwd\s*(?:\?\.)?\s*(?:\.\s*call\s*)?\(/g,
  /(?<![\w$])process\s*\[\s*(['"`])cwd\1\s*\]\s*\(\s*\)/g,
  /(?<![\w$])path\s*\.\s*resolve\s*\(\s*['"`)]/g,
  /(?<![\w$])require\s*\(\s*['"](?:node:)?path['"]\s*\)\s*\.\s*resolve\s*\(/g,
  /(?<![\w$])process\s*\.\s*env\s*(?:\.\s*INIT_CWD\b|\[\s*(['"`])INIT_CWD\1\s*\])/g,
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

type Excuse = { line: number; reason: string }

/** allow-cwd excuses per guard file, this file included: each line number and the reason text after the marker. */
function excuseReasons(files: readonly string[]): Map<string, Excuse[]> {
  const found = new Map<string, Excuse[]>()
  for (const name of files) {
    const excuses = fs.readFileSync(path.join(GUARD_DIR, name), 'utf8').split(/\r?\n/).flatMap((text, i): Excuse[] => {
      const reason = ALLOW.exec(text)?.[1]
      return reason === undefined ? [] : [{ line: i + 1, reason: reason.trim() }]
    })
    if (excuses.length > 0) found.set(name, excuses)
  }
  return found
}

// Pinned by file, in line order, as each excuse's reason text. A new, moved or reworded excuse fails until it is pinned here.
const PINNED_EXCUSES: Readonly<Record<string, readonly string[]>> = {
  'hint_suggestions_parse_as_one_powershell_statement.test.ts': [
    "hook payload cwd simulates the session's launch directory, not a repo root",
  ],
  'installer_writes_are_contained.test.ts': ['quoted text inside a finding message, not a root lookup'],
  'permission_filter_single_predicate.test.ts': [
    'the spawned child runs with the fixture root as its cwd, so this path lies inside that root',
  ],
  'pre_handler_fs_touches_are_gated.test.ts': [
    'provenance text naming a code path, not a root lookup',
    'provenance text naming a code path, not a root lookup',
    'provenance text naming a code path, not a root lookup',
  ],
  'root_caches_reset.test.ts': ['the directory this test chdirs into and restores, not a repo root'],
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
      'each of these reads the launch directory as the repo root, so a run from another checkout tests that checkout. Use ROOT from tests/helpers/bundle.ts, or put an allow-cwd comment with the reason on the line above.',
    ).toEqual([])
  })

  it('keeps allow-cwd excuses to the pinned files and reason text', () => {
    const actual = excuseReasons(population())
    const names = [...new Set([...actual.keys(), ...Object.keys(PINNED_EXCUSES)])].sort()
    const drift = names.flatMap((n) => {
      const got = actual.get(n) ?? []
      const pinned = PINNED_EXCUSES[n] ?? []
      if (got.length === pinned.length && got.every((e, i) => e.reason === pinned[i])) return []
      if (got.length === 0) return [`tests/guards/${n}: ${pinned.length} pinned excuse(s), none found`]
      return got.map((e) => `tests/guards/${n}:${e.line} excuse "${e.reason}" does not match its pin`)
    })
    expect(
      drift,
      'a new, moved or reworded allow-cwd excuse: pin its file and reason text in PINNED_EXCUSES in this test, with the reason the launch directory is under test, or remove the excuse',
    ).toEqual([])
  })
})
