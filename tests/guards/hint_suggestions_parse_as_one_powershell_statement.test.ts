// FORMAT-DERIVED: the quote and dash code points are PowerShell's own, read off SpecialChars and CharExtensions.IsDoubleQuote/IsSingleQuote/IsDash in https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/engine/parser/CharTraits.cs. HAND-DERIVED: each payload path is built from that grammar to close the emitter's double quote, run Write-Output, and reopen, independently of the guard's code; the oracle is PowerShell's parser, not the guard.
import { describe, expect, it } from 'vitest'

import { docSectionHint, grepLinesHint, stripUnsafeSuggestions } from '../../src/hint_suggestion_guard.js'
import { fileQueryHint, hintTarget, sliceCommand } from '../../src/hint_target.js'
import { relayInProcess } from '../../src/relay.js'
import { fencedSuggestions, parseWithPowerShell, powershellForParsing } from '../helpers/powershell_parse.js'

const cp = (code: number): string => String.fromCodePoint(code)
const DOUBLE_QUOTES = [0x201c, 0x201d, 0x201e]
const SINGLE_QUOTES = [0x2018, 0x2019, 0x201a, 0x201b]
const DASHES = [0x2013, 0x2014, 0x2015]
const MARKER = 'PWNED'

// Paths that leave a double-quoted argument under PowerShell: one per double-quote code point, plus the opener/closer pair a word processor would produce.
const BREAKOUT_PATHS: readonly string[] = [
  ...DOUBLE_QUOTES.map((c) => 'a' + cp(c) + '; Write-Output ' + MARKER + '; ' + cp(c) + 'b.ts'),
  'notes' + cp(0x201d) + '; Write-Output ' + MARKER + '; ' + cp(0x201c) + 'x.md',
]

// Names a real repository has (a curly apostrophe, an en dash in a date range), which stay literal inside a double-quoted argument and must keep their suggestion.
const BENIGN_PATHS: readonly string[] = [
  'John' + cp(0x2019) + 's notes.md',
  'Q3 2025' + cp(0x2013) + '2026 plan.ts',
  ...SINGLE_QUOTES.map((c) => 'say' + cp(c) + 'hi' + cp(c) + '.ts'),
  ...DASHES.map((c) => 'a ' + cp(c) + 'join b.ts'),
]

// ASCII payloads the guard already handled, kept so the PowerShell oracle covers the whole corpus.
const ASCII_PAYLOAD_PATHS: readonly string[] = [
  'a";Write-Output ' + MARKER + ';#.ts',
  "q';Write-Output " + MARKER + ';#.ts',
  'a";Write-Output ' + MARKER + ';#"b.ts',
  'a" > out.txt "b.ts',
  'a""; Write-Output ' + MARKER + '; ""b.ts',
]

/** Every hint shape a path reaches, each passed through the guard as relayInProcess passes it. */
function guardedHints(p: string): string[] {
  const raw = [
    'Use `token-goat read "' + p + '::SymbolName"` to read one function or class.',
    docSectionHint(p, 'Intro', 'The file is large.'),
    grepLinesHint('<pattern>', p),
    fileQueryHint(p.replace(/\.\w+$/, '.json')),
    fileQueryHint(p.replace(/\.\w+$/, '.toml')),
  ]
  return raw.map((t) => stripUnsafeSuggestions(t))
}

/** Every string value in a hook's JSON wire output, where the suggestions sit. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

function bashEvent(command: string, session: string): Record<string, unknown> {
  return { session_id: 'ps-parse-' + session, cwd: process.cwd(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }
}

/** `s` with every single-quoted argument cut out: quotedArg and quotedArgs single-quote a value holding a PowerShell double quote, and a single-quoted argument ends only at `'` or U+2018-U+201B (CharExtensions.IsSingleQuote), so a marker inside one is literal text in both shells. */
const outsideSingleQuotes = (s: string): string => s.replace(/'[^'‘-‛]*'/g, '')

describe('PowerShell double quotes in a path', () => {
  it.each(BREAKOUT_PATHS)('never lets the command break out when the path is %j', (p) => {
    let kept = 0
    for (const out of guardedHints(p)) {
      for (const s of fencedSuggestions(out)) {
        if (s.includes(MARKER)) kept++
        expect(outsideSingleQuotes(s), 'a PowerShell breakout survived the guard').not.toContain(MARKER)
      }
    }
    // The section and grep hints keep their command, single-quoted; the hand-built double-quoted read is still dropped.
    expect(kept).toBeGreaterThanOrEqual(2)
  })

  it.each(BENIGN_PATHS)('leaves the suggestion for %j byte-identical', (p) => {
    const poisoned = 'Use `token-goat read "' + p + '::SymbolName"` to read one function or class.'
    expect(stripUnsafeSuggestions(poisoned)).toBe(poisoned)
    const section = docSectionHint(p, 'Intro')
    expect(stripUnsafeSuggestions(section)).toBe(section)
  })

  it('never picks a heading holding a PowerShell double quote as the section a hint names', () => {
    const hostile = 'a' + cp(0x201d) + '; Write-Output ' + MARKER + '; ' + cp(0x201c) + 'b'
    const content = '# Title\n\n## ' + hostile + '\n\ntext\n\n## Usage\n\nmore\n'
    const target = hintTarget('d.md', 'section', { content })
    expect(target.name).toBe('Usage')
    expect(sliceCommand('d.md', target)).toBe('token-goat section "d.md::Usage"')
  })
})

// Resolved at collection, so a CI runner without PowerShell fails the file instead of skipping it.
const POWERSHELL = powershellForParsing()

describe.skipIf(POWERSHELL === null)('every suggestion that survives the guard is one PowerShell statement', () => {
  const exe = POWERSHELL ?? ''

  it('parses each fenced suggestion from the emitters and the relay as exactly one statement with no errors', async () => {
    const texts: string[] = []
    for (const p of [...BREAKOUT_PATHS, ...BENIGN_PATHS, ...ASCII_PAYLOAD_PATHS]) texts.push(...guardedHints(p))
    let relayed = 0
    for (const [i, p] of [...BREAKOUT_PATHS, ...BENIGN_PATHS, ...ASCII_PAYLOAD_PATHS].entries()) {
      const wire = await relayInProcess('pre_tool_use', bashEvent("cat '" + p.split("'").join("'\\''") + "'", String(i)))
      if (wire !== '{}') relayed++
      texts.push(...stringsIn(JSON.parse(wire)))
    }
    const suggestions = Array.from(new Set(texts.flatMap(fencedSuggestions)))
    // Floors, so the oracle cannot pass on silence. CAPTURE on 2026-10-05: 78 distinct suggestions, and the relay hinted on 17 of the 18 cat commands.
    expect(suggestions.length).toBeGreaterThanOrEqual(60)
    expect(relayed).toBeGreaterThanOrEqual(14)
    expect(suggestions.some((s) => s.includes('John' + cp(0x2019) + 's notes.md')), 'a curly apostrophe cost a benign file its suggestion').toBe(true)
    const parsed = parseWithPowerShell(exe, suggestions)
    const broken = parsed.filter((r) => r.statements !== 1 || r.errors !== 0)
    expect(broken, 'suggestions PowerShell does not read as one command').toEqual([])
  }, 120_000)

  it('the oracle itself sees the breakout: an unguarded payload parses as three statements', () => {
    const commands = BREAKOUT_PATHS.slice(0, DOUBLE_QUOTES.length).map((p) => 'token-goat read "' + p + '::SymbolName"')
    expect(parseWithPowerShell(exe, commands).map((r) => r.statements)).toEqual(DOUBLE_QUOTES.map(() => 3))
  }, 60_000)
})
