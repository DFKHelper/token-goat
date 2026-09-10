/**
 * Population guard: every "is this raw shell command string a single, compound-operator-free invocation" decision in src/ must run its `&&`/`||`/`|`/`;`/`<`/`>` check through the quote-aware hasUnquotedOperator (backed by maskQuotedSpans), never a raw `cmd.includes(op)` or `/[<>]/.test(cmd)` substring check -- see tool_filters/helpers.ts's own doc comment on hasUnquotedOperator for the shipped defect this replaced (`grep -E 'foo|bar'` misread as a pipeline because a quoted `|` disqualified an otherwise-single command). isCompressibleSingleCommand in hooks_bash.ts regressed to the naive check for `|`/`;`/`<`/`>` (and briefly `&&`/`||`) while its sibling detectFromCommand (tool_filters/dispatch.ts) stayed quote-aware the whole time; this guard keeps that specific class -- a decision helper correctly quote-aware in one path and hand-rolled naively in a sibling -- from regrowing anywhere else in src/.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC_DIR = join(process.cwd(), 'src')
// This guard's own file: it necessarily quotes the naive pattern in its self-test and must not scan itself.
const SELF = join(process.cwd(), 'tests', 'guards', 'shell_operator_quote_awareness.test.ts').replace(/\\/g, '/')
// The one file allowed to reference the raw operator literals: it defines hasUnquotedOperator/maskQuotedSpans themselves, and hasBareBackgroundOrNewline's own bare-`&` regex.
const DEFINITION_FILE = join(SRC_DIR, 'tool_filters', 'helpers.ts').replace(/\\/g, '/')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.name.endsWith('.ts')) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

// A cmd-like variable's raw, quote-unaware test for a shell control operator -- the exact shape hasUnquotedOperator's own doc comment names as the shipped defect.
const NAIVE_RE = /\b(?:cmd|command|gateCmd|rawCmd)\.includes\(\s*['"](?:\|\||&&|\||;)['"]\s*\)|\/\[<>\]\/\.test\(\s*(?:cmd|command|gateCmd|rawCmd)\s*\)/

// The sanctioned quote-aware call these naive checks must be replaced by.
const SANCTIONED_RE = /hasUnquotedOperator\(/

describe('shell control-operator detection stays quote-aware', () => {
  const files = pinnedPopulation({
    what: 'src/**/*.ts files scanned for a naive shell control-operator check',
    items: walk(SRC_DIR).filter((f) => f !== SELF && f !== DEFINITION_FILE),
    floor: 200,
    mustInclude: ['hooks_bash.ts', 'tool_filters/dispatch.ts'],
  })

  it('the sanctioned quote-aware call site population is non-empty (proves the scan mechanics work, not just a silent zero match)', () => {
    const sites = files.filter((f) => SANCTIONED_RE.test(readFileSync(f, 'utf-8')))
    expect(sites.length, 'no file calls hasUnquotedOperator -- the scan itself is broken, not the population').toBeGreaterThan(0)
  })

  it('the naive-check regex itself still fires on a known-bad fixture, and not on the sanctioned call (self-test, HAND-DERIVED from the reverted diff)', () => {
    expect(NAIVE_RE.test("if (cmd.includes('|') || cmd.includes(';')) return false")).toBe(true)
    expect(NAIVE_RE.test('if (/[<>]/.test(cmd)) return false')).toBe(true)
    expect(NAIVE_RE.test("if (['&&', '||'].some((op) => cmd.includes(op))) return false")).toBe(false)
    expect(NAIVE_RE.test("if (hasUnquotedOperator(cmd, ['|', ';', '<', '>'])) return false")).toBe(false)
  })

  it('no file outside the definition site reintroduces a raw, quote-unaware operator check on a command string', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf-8')
      if (NAIVE_RE.test(text)) offenders.push(f)
    }
    expect(offenders, `naive quote-unaware shell-operator check(s) found: ${offenders.join(', ')}`).toEqual([])
  })
})
