// Regression guard for `web-output`/`bash-output`/`mcp-output --section`, which share _applyFiltersAndPrint(): a heading that occurs twice resolved silently to its first occurrence where `section` refuses with the ambiguity list, and `-n` after `--section` numbered the slice from 1 instead of in the stored output's own coordinates, so a follow-up `--lines N` returned the wrong text.
// Provenance: HAND-DERIVED. The body below is written line by line here, and every expected line number is counted from that literal, not from the implementation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { clearModuleCaches } from '../src/reset.js'
import { storeWebOutput } from '../src/web_cache.js'
import { unfence } from './helpers/unfence.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  clearModuleCaches()
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  clearModuleCaches()
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

// Line 1 '# Doc', 3 '## Install', 4 body, 6 '## Usage', 7-8 body, 10 '## Install' (second), 11 body.
const BODY = ['# Doc', '', '## Install', 'first install body', '', '## Usage', 'usage one', 'usage two', '', '## Install', 'second install body', ''].join('\n')

describe('cached-output --section on a duplicated heading', () => {
  it('refuses with the ambiguity list instead of printing the first match', async () => {
    const id = storeWebOutput('https://example.com/dup', BODY)
    const code = await runCli(['web-output', id, '--section', 'Install'])
    expect(code).toBe(1)
    const err = stderr.join('')
    expect(err).toContain('2 headings match')
    expect(err).toContain('line 3')
    expect(err).toContain('line 10')
    expect(err).toContain('--section "Install#2"')
    expect(stdout.join('')).not.toContain('first install body')
  })

  it('still serves an occurrence picked with #N', async () => {
    const id = storeWebOutput('https://example.com/dup-pick', BODY)
    const code = await runCli(['web-output', id, '--section', 'Install#2'])
    expect(code).toBe(0)
    expect(unfence(stdout.join(''))).toContain('second install body')
    expect(stdout.join('')).not.toContain('first install body')
  })
})

describe('cached-output --section with -n', () => {
  it('numbers the slice in the stored output coordinates, the same ones --lines takes', async () => {
    const id = storeWebOutput('https://example.com/num', BODY)
    const code = await runCli(['web-output', id, '--section', 'Usage', '-n'])
    expect(code).toBe(0)
    const shown = unfence(stdout.join(''))
    expect(shown).toContain('6:## Usage')
    expect(shown).toContain('7:usage one')
    expect(shown).toContain('8:usage two')
    expect(shown).not.toContain('1:## Usage')

    stdout.length = 0
    expect(await runCli(['web-output', id, '--lines', '7', '-n'])).toBe(0)
    expect(unfence(stdout.join(''))).toContain('7:usage one')
  })
})

describe('cached-output --section with --lines', () => {
  it('takes the same line numbers -n printed for the section', async () => {
    const id = storeWebOutput('https://example.com/abs', BODY)
    expect(await runCli(['web-output', id, '--section', 'Usage', '--lines', '7-8', '-n'])).toBe(0)
    const shown = unfence(stdout.join(''))
    expect(shown).toContain('7:usage one')
    expect(shown).toContain('8:usage two')
    expect(shown).not.toContain('## Usage')
  })

  it('refuses a range that falls outside the section', async () => {
    const id = storeWebOutput('https://example.com/out', BODY)
    expect(await runCli(['web-output', id, '--section', 'Usage', '--lines', '1-2'])).toBe(1)
    expect(stderr.join('')).toContain("is outside section 'Usage', which covers lines 6-")
    expect(stdout.join('')).not.toContain('# Doc')
  })
})
