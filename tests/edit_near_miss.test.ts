/** Edit near-miss ladder (src/edit_near_miss.ts) and its use in diagnoseEditFailure. Fixtures: the Claude Code failed-Edit payloads are FORMAT-DERIVED (tests/fixtures/claude_code_2_1_281/edit_not_found.json and edit_multiple_matches.json, PROVENANCE.tsv: real tool_input and error text from a Claude Code transcript inside the envelope of the bash_failure.json CAPTURE); the Copilot CLI payload is FORMAT-DERIVED from the schema cited in tests/fixtures/harness_hook_payloads.ts ('edit failure (old_str not found)': toolName edit, toolArgs path/old_str/new_str, error); the MultiEdit and Antigravity payloads are FORMAT-DERIVED from the tool_input shapes in src/hooks_cli.ts (AGY_EDIT_KEYS) and the Claude Code MultiEdit `edits[]` array. Every file body and every old_string pair below is HAND-DERIVED: written to differ from its partner by exactly one named rung. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

import { describeNearMiss, findNearMiss, isNearMissAdvice, MAX_SPAN_BYTES, MAX_SPAN_LINES } from '../src/edit_near_miss.js'
import type { HookEvent } from '../src/hook_registry.js'
import { diagnoseEditFailure, loadNearMiss, postToolUseFailureWithExtras } from '../src/hooks_tool_failure.js'

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude_code_2_1_281', name), 'utf8')) as Record<string, unknown>
const NOT_FOUND = fixture('edit_not_found.json')
const MULTIPLE = fixture('edit_multiple_matches.json')

const dir = mkdtempSync(join(tmpdir(), 'tg-near-miss-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// The registered handler loads the near-miss module on demand; these calls skip that handler, so load it as it would.
beforeAll(loadNearMiss)
let counter = 0
function fileWith(body: string): string {
  counter += 1
  const path = join(dir, `f${counter}.txt`)
  writeFileSync(path, body, 'utf8')
  return path
}

function editEvent(toolName: string, toolInput: Record<string, unknown>): HookEvent {
  return { eventName: 'post_tool_use_failure', toolName, toolInput, sessionId: 'near-miss', agentId: undefined, raw: { session_id: 'near-miss', tool_name: toolName, tool_input: toolInput } }
}

const claudeError = (payload: Record<string, unknown>): string => payload['error'] as string

describe('findNearMiss', () => {
  it('rung 1: finds a block that differs only by trailing whitespace, over several lines', () => {
    const hit = findNearMiss('head\nconst a = 1;   \nreturn a\t\ntail\n', 'const a = 1;\nreturn a')
    expect(hit?.rung).toBe('trailing-whitespace')
    expect(hit?.hits).toEqual([{ startLine: 2, endLine: 3, start: 5, end: 'head\nconst a = 1;   \nreturn a\t'.length }])
  })

  it('rung 2: folds curly quotes, dashes, a non-breaking space and the ellipsis character', () => {
    const file = 'one\nsay “hi” — it’s done…\ntwo\n'
    const hit = findNearMiss(file, 'say "hi" - it\'s done...')
    expect(hit?.rung).toBe('unicode-punctuation')
    expect(hit?.hits.map((h) => [h.startLine, h.endLine])).toEqual([[2, 2]])
  })

  it('rung 2: also folds a narrow no-break space (U+202F) before a meridiem', () => {
    const hit = findNearMiss('at 10:15 AM sharp\n', 'at 10:15 AM sharp')
    expect(hit?.rung).toBe('unicode-punctuation')
  })

  it('rung 3: matches a re-indented block and reports the on-disk lines', () => {
    const file = 'fn() {\n    if (x) {\n        y()\n    }\n}\n'
    const hit = findNearMiss(file, '  if (x) {\n      y()\n  }')
    expect(hit?.rung).toBe('indentation')
    expect(hit?.hits.map((h) => [h.startLine, h.endLine])).toEqual([[2, 4]])
  })

  it('tries the rungs in order: trailing whitespace is reported as such even when indentation would also match', () => {
    expect(findNearMiss('  a  \n  b\n', '  a\n  b')?.rung).toBe('trailing-whitespace')
  })

  it('returns every hit when several places match, and says when the list was cut', () => {
    const many = Array.from({ length: 30 }, () => 'x = 1;  ').join('\n')
    const hit = findNearMiss(many, 'x = 1;\nx = 1;')
    expect(hit?.hits).toHaveLength(20)
    expect(hit?.truncated).toBe(true)
    expect(findNearMiss('x = 1;  \ny\nx = 1;  \n', 'x = 1;\n')?.hits.map((h) => h.startLine)).toEqual([1, 3])
  })

  it('returns null for an exact match, a missing string, a blank string and a longer string than the file', () => {
    expect(findNearMiss('abc\n', 'abc')).toBeNull()
    expect(findNearMiss('abc\n', 'xyz')).toBeNull()
    expect(findNearMiss('a\n\n\nb\n', '  \n  ')).toBeNull()
    expect(findNearMiss('a\nb\n', 'a\nb\nc\nd\ne')).toBeNull()
  })

  it('does not take a stripped trailing blank for a prefix: `foo  ` is not `foo bar`', () => {
    expect(findNearMiss('foo bar\n', 'foo  ')).toBeNull()
    expect(findNearMiss('foo \n', 'foo  ')?.rung).toBe('trailing-whitespace')
  })
})

describe('diagnoseEditFailure on a near miss', () => {
  it('names the exact on-disk line for the captured not-found payload and fences it', () => {
    const path = fileWith('# notes\n- log it as an observation only, never\u00A0dispatched from.\n- next\n')
    const input = { ...(NOT_FOUND['tool_input'] as Record<string, unknown>), file_path: path }
    const out = diagnoseEditFailure(editEvent('Edit', input), claudeError(NOT_FOUND))
    expect(out).toContain('but line 2 matches, ignoring quote, dash and space-character differences')
    expect(out).toContain('- log it as an observation only, never\u00A0dispatched from.')
    expect(out).toContain('untrusted')
    expect(out).toContain('Copy the on-disk text below into old_string exactly')
  })

  it('the registered handler loads the module itself and still answers with the near-miss text', async () => {
    const path = fileWith('keep\n  tabbed\nend\n')
    const input = { path, old_str: '    tabbed', new_str: 'x' }
    const event = { ...editEvent('Edit', input), sessionId: 'near-miss-registered', raw: { session_id: 'near-miss-registered', tool_name: 'Edit', tool_input: input, error: 'No match found for old_str' } }
    const out = await postToolUseFailureWithExtras(event)
    expect(out.hookType).toBe('context')
    expect(out.hookType === 'context' ? out.context : '').toContain('line 2 matches, ignoring indentation')
  })

  it('falls back to the similar-line advice when no rung matches', () => {
    const path = fileWith('# notes\nlog it as an observation only, never dispatched from the team.\n')
    const input = { ...(NOT_FOUND['tool_input'] as Record<string, unknown>), file_path: path, old_string: 'log it as an observation only, never dispatched TO.' }
    expect(diagnoseEditFailure(editEvent('Edit', input), 'String to replace not found in file.')).toContain('View the target lines')
  })

  it('names only line numbers when several places match', () => {
    const path = fileWith('a = 1;  \nb\na = 1;\t\n')
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: 'a = 1;\n' }), 'String to replace not found in file.')
    expect(out).toContain('2 places match, ignoring trailing whitespace (lines 1, 3)')
    expect(out).not.toContain('untrusted')
  })

  it('gives the line range only when the span passes the line cap', () => {
    const body = Array.from({ length: MAX_SPAN_LINES + 1 }, (_, i) => `    row ${i}`).join('\n')
    const path = fileWith(`${body}\n`)
    const old = Array.from({ length: MAX_SPAN_LINES + 1 }, (_, i) => `  row ${i}`).join('\n')
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: old }), 'String to replace not found in file.')
    expect(out).toContain(`lines 1-${MAX_SPAN_LINES + 1} match, ignoring indentation. View that range`)
    expect(out).not.toContain('row 3')
  })

  it('gives the line range only when the span passes the byte cap', () => {
    const long = 'w'.repeat(MAX_SPAN_BYTES + 10)
    const path = fileWith(`${long} \nz\n`)
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: `${long}\nz` }), 'String to replace not found in file.')
    expect(out).toContain('lines 1-2 match, ignoring trailing whitespace. View that range')
    expect(out).not.toContain('wwww')
  })

  it('redacts a credential on the returned lines', () => {
    // HAND-DERIVED: AWS's documented example access key id, the value src/secret_redact.ts and the existing tool-failure tests treat as a credential.
    const path = fileWith('KEY = "AKIAIOSFODNN7EXAMPLE"  \nnext\n')
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: 'KEY = "AKIAIOSFODNN7EXAMPLE"\nnext' }), 'String to replace not found in file.')
    expect(out).toContain('KEY = ')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('measures the byte cap on the redacted span, so a long key block collapses under it', () => {
    // HAND-DERIVED: a PEM private key block, the shape src/secret_redact.ts replaces whole; its 12 body lines make the raw span 1.6 KB, over MAX_SPAN_BYTES, while the redacted span is a few bytes.
    const body = Array.from({ length: 12 }, () => 'A'.repeat(130)).join('\n')
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    expect(block.length).toBeGreaterThan(MAX_SPAN_BYTES)
    const path = fileWith(`${block}  \nnext\n`)
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: `${block}\nnext` }), 'String to replace not found in file.')
    expect(out).toContain('Copy the on-disk text below')
    expect(out).not.toContain('AAAAAAAAAA')
  })

  it('leaves the multiple-match advice for the captured payload alone', () => {
    const path = fileWith('x\n        self.assertNotRegex(self.read(), r"(?<!\\r)\\n")\ny\n        self.assertNotRegex(self.read(), r"(?<!\\r)\\n")\n')
    const input = { ...(MULTIPLE['tool_input'] as Record<string, unknown>), file_path: path }
    expect(diagnoseEditFailure(editEvent('Edit', input), claudeError(MULTIPLE))).toContain('matched 2 times')
  })

  it('checks each MultiEdit entry and diagnoses the first one the file cannot explain', () => {
    const path = fileWith('alpha\n\tbeta()  \ngamma\n')
    const edits = [
      { old_string: 'alpha', new_string: 'a' },
      { old_string: '\tbeta()\ngamma', new_string: 'b' },
    ]
    const out = diagnoseEditFailure(editEvent('MultiEdit', { file_path: path, edits }), 'String to replace not found in file.')
    expect(out).toContain('lines 2-3 match, ignoring trailing whitespace')
    expect(diagnoseEditFailure(editEvent('MultiEdit', { file_path: path, edits: [{ old_string: 'alpha', new_string: 'a' }, { old_string: 'gamma', new_string: 'g' }] }), 'String to replace not found in file.')).toBeNull()
  })

  it('reads the Copilot CLI keys (path, old_str)', () => {
    const path = fileWith('keep\n  tabbed\nend\n')
    const out = diagnoseEditFailure(editEvent('Edit', { path, old_str: '    tabbed', new_str: 'x' }), 'No match found for old_str')
    expect(out).toContain('line 2 matches, ignoring indentation')
  })

  it('reads the Antigravity keys (TargetFile, TargetContent) when they arrive unmapped', () => {
    const path = fileWith('call(“x”)\n')
    const out = diagnoseEditFailure(editEvent('Edit', { TargetFile: path, TargetContent: 'call("x")', ReplacementContent: 'y' }), 'target content not found')
    expect(out).toContain('line 1 matches, ignoring quote, dash and space-character differences')
  })

  it('stays inside the time budget on a large file with no match', () => {
    const path = fileWith(Array.from({ length: 150_000 }, (_, i) => `    const value${i} = compute(${i}); // note`).join('\n'))
    const started = Date.now()
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: 'const absent = nowhere(1);\nreturn absent' }), 'String to replace not found in file.')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(out).toContain('View the target lines')
  })
})

describe('the built bundle', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-near-miss-e2e-'))
  const project = join(home, 'proj')
  mkdirSync(project, { recursive: true })
  const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function failure(payload: Record<string, unknown>): string {
    const res = runBundle(['hook', 'post_tool_use_failure'], { cwd: project, env, input: JSON.stringify(payload), timeout: 60_000 })
    expect(res.status, res.stderr).toBe(0)
    return res.stdout
  }

  it('answers the captured Claude Code payload with the on-disk line', () => {
    const file = join(project, 'orchestrator.md')
    writeFileSync(file, '- log it as an observation only, never\u00A0dispatched from.\n', 'utf8')
    const payload = { ...NOT_FOUND, session_id: 'nm-claude', cwd: project, tool_input: { ...(NOT_FOUND['tool_input'] as Record<string, unknown>), file_path: file } }
    const out = failure(payload)
    expect(out).toContain('but line 1 matches, ignoring quote, dash and space-character differences')
    expect(out).toContain('- log it as an observation only, never\u00A0dispatched from.')
  })

  it('answers the payload the Copilot adapter canonicalizes from postToolUseFailure', () => {
    // FORMAT-DERIVED: src/hook_adapters.ts copilotRun -- tool_name from copilotCanonicalToolName('edit'), tool_input from toolArgs (path, old_str, new_str), error verbatim, no cwd key.
    const file = join(project, 'notes.md')
    writeFileSync(file, '# Title\n\n    indented text\n', 'utf8')
    const payload = { session_id: 'nm-copilot', tool_name: 'Edit', tool_input: { path: file, old_str: '        indented text', new_str: 'x' }, error: 'No match found for old_str in notes.md' }
    const out = failure(payload)
    expect(out).toContain('line 3 matches, ignoring indentation')
    expect(out).toContain('    indented text')
  })
})

describe('isNearMissAdvice', () => {
  // HAND-DERIVED: the three shapes describeNearMiss prints, plus the generic Edit messages diagnoseEditFailure prints that must stay out of the hint ledger.
  it('matches every shape describeNearMiss emits', () => {
    const file = 'a  \nb\na  \n'
    const several = describeNearMiss(file, 'f.ts', findNearMiss(file, 'a\n') as NonNullable<ReturnType<typeof findNearMiss>>)
    const one = describeNearMiss('x  \ny\n', 'f.ts', findNearMiss('x  \ny\n', 'x\ny') as NonNullable<ReturnType<typeof findNearMiss>>)
    const single = describeNearMiss('x  \nz\n', 'f.ts', findNearMiss('x  \nz\n', 'x\n') as NonNullable<ReturnType<typeof findNearMiss>>)
    const long = 'q'.repeat(MAX_SPAN_BYTES + 10)
    const over = describeNearMiss(`${long}  \nz\n`, 'f.ts', findNearMiss(`${long}  \nz\n`, `${long}\nz`) as NonNullable<ReturnType<typeof findNearMiss>>)
    for (const text of [several, one, single, over]) expect(isNearMissAdvice(text as string)).toBe(true)
  })

  it('rejects the generic edit advice', () => {
    expect(isNearMissAdvice('[token-goat] Edit failed: string not found in f.ts. Read it again.')).toBe(false)
    expect(isNearMissAdvice('[token-goat] Edit failed: string not found in f.ts; matches with normalized line endings')).toBe(false)
    expect(isNearMissAdvice('')).toBe(false)
  })
})

const REJECTED = 'String to replace not found in file.'

describe('the print caps, at their exact edges', () => {
  it('pins the caps the tests below are built on', () => {
    expect(MAX_SPAN_LINES).toBe(20)
    expect(MAX_SPAN_BYTES).toBe(1536)
  })

  it('prints a span of exactly the line cap', () => {
    const body = Array.from({ length: MAX_SPAN_LINES }, (_, i) => `    row ${i}`).join('\n')
    const old = Array.from({ length: MAX_SPAN_LINES }, (_, i) => `  row ${i}`).join('\n')
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: fileWith(`${body}\n`), old_string: old }), REJECTED)
    expect(out).toContain(`lines 1-${MAX_SPAN_LINES} match, ignoring indentation. Copy the on-disk text below`)
    expect(out).toContain('row 3')
  })

  it('prints a multibyte span of exactly the byte cap and names the range one character over', () => {
    // HAND-DERIVED: U+00E9 is 2 bytes in UTF-8, so 768 of them are exactly 1536 bytes and 769 are 1538 while still under 1536 characters.
    const fit = 'é'.repeat(MAX_SPAN_BYTES / 2)
    const printed = diagnoseEditFailure(editEvent('Edit', { file_path: fileWith(`${fit}\n`), old_string: `${fit} ` }), REJECTED)
    expect(printed).toContain('Copy the on-disk text below')
    const over = `${fit}é`
    const named = diagnoseEditFailure(editEvent('Edit', { file_path: fileWith(`${over}\n`), old_string: `${over} ` }), REJECTED)
    expect(named).toContain('line 1 matches, ignoring trailing whitespace. View that range')
    expect(named).not.toContain('éé')
  })
})

describe('what is searched and what is echoed', () => {
  it('skips an old_string past the line cap', () => {
    const lines = Array.from({ length: 201 }, (_, i) => `row ${i}`)
    expect(findNearMiss(`${lines.join('  \n')}\n`, lines.join('\n'))).toBeNull()
    const fit = lines.slice(0, 200)
    expect(findNearMiss(`${fit.join('  \n')}\n`, fit.join('\n'))).not.toBeNull()
  })

  it('skips an old_string past the length cap', () => {
    // HAND-DERIVED: 16383 characters plus a tab are 16384, the cap; one more character is 16385.
    const fit = 'x'.repeat(16383)
    expect(findNearMiss(`${fit}  \n`, `${fit}\t`)).not.toBeNull()
    expect(findNearMiss(`x${fit}  \n`, `x${fit}\t`)).toBeNull()
  })

  it('finds a trimmed line whose blank run is long and not at the end', () => {
    const gap = ' '.repeat(5000)
    expect(findNearMiss(`a${gap}b  \n`, `a${gap}b\t`)?.rung).toBe('trailing-whitespace')
    expect(findNearMiss(`a${gap}  \n`, `a${gap}\t`)).not.toBeNull()
  })

  it('does not take a short fragment for a near miss of a long line', () => {
    const line = 'const configuration = loadTheWholeConfiguration(path)  '
    expect(findNearMiss(`${line}\n`, 'const co')).toBeNull()
    expect(findNearMiss(`${line}\n`, 'const configuration = loadTheWholeConfiguration(path')).toBeNull()
  })

  it('takes a fragment covering at least half of the line', () => {
    // HAND-DERIVED: the curly quote folds to an apostrophe, so "a" plus it is 2 of the 4 characters of "a'cd", exactly half, and a lone one is 1 of 4.
    expect(findNearMiss("a'cd\n", 'a’')).not.toBeNull()
    expect(findNearMiss("a'cd\n", '’')).toBeNull()
  })

  it('gives the line number but not the text for a file with a credential name', () => {
    counter += 1
    const path = join(dir, `.env.local${counter}`)
    writeFileSync(path, 'PLAIN_SETTING=visible-value  \nnext\n', 'utf8')
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: path, old_string: 'PLAIN_SETTING=visible-value\nnext' }), REJECTED)
    expect(out).toContain('lines 1-2 match, ignoring trailing whitespace. View that range')
    expect(out).not.toContain('visible-value')
  })

  it('still echoes the same lines from a file with an ordinary name', () => {
    const out = diagnoseEditFailure(editEvent('Edit', { file_path: fileWith('PLAIN_SETTING=visible-value  \nnext\n'), old_string: 'PLAIN_SETTING=visible-value\nnext' }), REJECTED)
    expect(out).toContain('visible-value')
  })
})
