/** `grep -v` prints the lines that do NOT match, and grep only prefixes a filename when it searches more than one file, so `grep -v '^\s*#' check.sh` prints the script's own lines with no prefix at all. The grep filter read each line's text before its first colon as the file it came from whenever that text held a `.` or `/`, which a script line usually does: CAPTURE (this repo's session, `grep -v '^\s*#' .lefthook-scripts/check-commit-style.sh | head -60`) came back as `grep: 40 matches across 6 files` with `/^[[:` and `function is_item(s) { return s ~ /^[[:` listed as files, and none of the script's lines. A single-file or stdin grep now attributes every line to the one file it searched, and an inverted search counts lines, not matches. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { GrepFilter } from '../src/tool_filters/shell_file.js'
import { makeHookEvent } from './helpers/hook-event.js'

const f = new GrepFilter()

/** A shell script whose code lines carry colons after a `/` or `.`, the way awk patterns, paths and URLs do, between comment lines. */
const SCRIPT = Array.from({ length: 90 }, (_, i) => [
  `# step ${i}: check the next field`,
  `awk '/^[[:space:]]*-/ { n${i}++ }' "$MSG_FILE"`,
  `echo "see docs/guide.md: rule ${i}"`,
]).flat()

/** What `grep -v '^\s*#'` prints for SCRIPT: every line that does not start with optional space and a `#`. Checked against GNU grep 3.0 (Git for Windows) on the same text. */
const NON_COMMENT = SCRIPT.filter((l) => !/^\s*#/.test(l))

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: `grep-v-${Math.random().toString(36).slice(2)}`,
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

describe('an inverted grep is read as lines of the file it searched', () => {
  let savedHarness: string | undefined
  beforeEach(() => {
    savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
  })

  it('keeps every line of `grep -v PATTERN file | head -500` through the post-Bash hook and invents no files', async () => {
    const output = NON_COMMENT.join('\n')
    const result = await postBashHandler(makePostBashEvent(`grep -v '^\\s*#' scripts/check.sh | head -500`, output))
    const body = result.hookType === 'rewriteOutput' ? result.updatedOutput : output
    for (const l of NON_COMMENT) expect(body).toContain(l)
    expect(body).not.toContain('across')
    expect(body).not.toContain('unattributed')
  })

  it('reads a single-file search as unprefixed lines whatever their text holds', () => {
    for (const argv of [
      ['grep', '-v', '^\\s*#', 'scripts/check.sh'],
      ['grep', '--invert-match', '-e', '#', 'scripts/check.sh'],
      ['grep', '-v', '-e', '#', '-e', '^$', 'scripts/check.sh'],
      ['grep', '-v', '#'],
      ['grep', 'awk', 'scripts/check.sh'],
    ]) {
      const out = f.compress(NON_COMMENT.join('\n'), '', 0, argv)
      expect(out, argv.join(' ')).not.toContain('across')
      for (const l of NON_COMMENT) expect(out, argv.join(' ')).toContain(l)
    }
  })

  it('still attributes prefixed lines when the search covers many files, and counts lines rather than matches', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `src/mod_${i % 12}.sh:echo "see docs/guide.md: rule ${i}"`)
    const out = f.compress(lines.join('\n'), '', 0, ['grep', '-rv', '^#', 'src'])
    expect(out).toContain('grep: 260 more lines across 12 files')
    expect(out).toContain('src/mod_4.sh: 22 lines')
    expect(out).not.toMatch(/^ {2}[^s].*: \d+ (lines|matches)$/m)
    expect(out).not.toContain('matches')
  })

  it('attributes by prefix when -H forces one onto a single-file search', () => {
    const lines = NON_COMMENT.map((l) => `scripts/check.sh:${l}`)
    const out = f.compress(lines.join('\n'), '', 0, ['grep', '-Hv', '#', 'scripts/check.sh'])
    for (const l of lines) expect(out).toContain(l)
    expect(out).not.toContain('across')
  })
})
