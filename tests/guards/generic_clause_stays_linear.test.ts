/**
 * `GENERIC_CLAUSE` is a nesting-aware type-parameter group shared by the Dart, Kotlin and Swift
 * regex adapters. Building a pattern by concatenating an imported constant puts it out of reach of
 * `regexp/no-super-linear-backtracking`, which only analyses a literal or a same-file const: moving
 * these five patterns onto the shared clause dropped ten entries from `eslint-suppressions.json`
 * without fixing a single one of them. The linter stopped looking; it did not start approving.
 *
 * This is the empirical backstop that replaces what the static rule can no longer see. The oracle is
 * a WALL CLOCK, because that is the only thing that separates a clause the engine walks once from
 * one it backtracks over: a unit test asserting the same symbols come out looks identical either way.
 * The adapters run over whatever is in a repository being indexed, including generated and
 * machine-mangled sources, so an unclosed or absurdly nested generic clause is ordinary input.
 *
 * PROVENANCE: HAND-DERIVED. The pathological shapes are built here from the clause's own alphabet
 * (`<`, `>`, and identifier text), independently of anything in src/, and the timings are read off
 * `Date.now()` in this file. The budget is loose -- 2 s against shapes that measure under a
 * millisecond -- so a loaded CI runner cannot fail it; a pattern that has gone super-linear on these
 * lengths takes minutes, not milliseconds.
 *
 * Calibrated by substituting a deliberately ambiguous clause (`<(?:[^>]|[^>])*>`) for the real one:
 * the run did not return inside three minutes and was killed. Note the failure shape that produces
 * -- V8 cannot interrupt a backtracking regex, so a regressed clause wedges the worker rather than
 * printing a red assertion, and the budget below is only reached by a pattern slow enough to matter
 * and still able to finish. A file in this suite that stops terminating is this guard firing.
 */
import { describe, expect, it } from 'vitest'

import { extractDart } from '../../src/languages/dart.js'
import { extractKotlin } from '../../src/languages/kotlin.js'
import { extractSwift } from '../../src/languages/swift.js'

const BUDGET_MS = 2000

/** Long enough that a super-linear clause cannot finish, short enough to be an ordinary source line. */
const N = 400

/** Each shape leaves the clause unterminated, which is what forces a backtracking group to try every split it has. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['unclosed parameter list', '<' + 'T, '.repeat(N) + 'X'],
  ['nothing but openers', '<'.repeat(N)],
  ['unterminated nesting', '<' + 'Map<String, List<'.repeat(N) + 'int'],
  ['bounded parameters, never closed', '<' + 'T : Comparable<T>, '.repeat(N) + 'X'],
]

/** One line per adapter, each spelled so the generic clause sits where that adapter's patterns look for it. */
const LINES: ReadonlyArray<readonly [string, (clause: string) => readonly [string, string]]> = [
  ['dart typedef', (c) => [`typedef Alias${c} = int Function(int a);\n`, 'main.dart']],
  ['dart function', (c) => [`int fn${c}(int a) => 0;\n`, 'main.dart']],
  ['dart extension', (c) => [`extension Ext${c} on List<int> {}\n`, 'main.dart']],
  ['dart mixin-application class', (c) => [`class Alias${c} = Object with Mixin;\n`, 'main.dart']],
  ['kotlin typealias', (c) => [`typealias Alias${c} = Set<Int>\n`, 'main.kt']],
  ['kotlin function', (c) => [`fun ${c} name(x: Int) {}\n`, 'main.kt']],
  ['swift function', (c) => [`func name${c}(x: Int) {}\n`, 'main.swift']],
]

const EXTRACT: Record<string, (content: string, filePath: string) => unknown> = {
  '.dart': extractDart,
  '.kt': extractKotlin,
  '.swift': extractSwift,
}

describe('the shared generic clause stays linear on input no static rule is checking any more', () => {
  it.each(
    LINES.flatMap(([lineName, make]) => SHAPES.map(([shapeName, clause]) => [`${lineName} / ${shapeName}`, make(clause)] as const)),
  )('finishes %s well inside the budget', (_name, [content, filePath]) => {
    const extract = EXTRACT[filePath.slice(filePath.lastIndexOf('.'))]!
    const started = Date.now()
    extract(content, filePath)
    expect(Date.now() - started).toBeLessThan(BUDGET_MS)
  })
})
