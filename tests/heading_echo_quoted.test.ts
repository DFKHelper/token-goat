// A heading echoed back in a section error was wrapped in single quotes by hand (`Section '${heading}' not found in '${file}'`), so a heading holding an apostrophe came back as `Section 'it's gone' not found`, which reads as a heading cut at the apostrophe, beside retry forms that quotedArg already quoted. Every such echo now goes through quotedArg. PROVENANCE: HAND-DERIVED headings chosen to break a hand-written single-quoted echo; the expected quoting is quotedArg's double-quote form for a value holding an apostrophe and no `$`, backtick or double quote.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { clearModuleCaches } from '../src/reset.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let out: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy
let dir: string

beforeEach(() => {
  clearModuleCaches()
  out = []
  stdoutSpy = spyOnWrite(process.stdout, out)
  stderrSpy = spyOnWrite(process.stderr, out)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-heading-echo-'))
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  clearModuleCaches()
  fs.rmSync(dir, { recursive: true, force: true })
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

const BODY = ['# Doc', '', "## Bob's notes", 'first', '', "## Bob's notes", 'second', '', '## Other', 'third', ''].join('\n')
const NEW_B64 = Buffer.from('## New\nx\n', 'utf8').toString('base64')

describe('a heading echoed in a section error', () => {
  it('quotes a missing heading and its file with quotedArg in section', async () => {
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, BODY)
    expect(await runCli(['section', file + "::it's gone"])).toBe(1)
    expect(out.join('')).toContain(`Section "it's gone" not found in "${file}"`)
  })

  it('quotes an ambiguous heading in section', async () => {
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, BODY)
    expect(await runCli(['section', file + "::Bob's notes"])).toBe(1)
    expect(out.join('')).toContain(`Ambiguous heading "Bob's notes" in "${file}": 2 headings match.`)
  })

  it('quotes the heading of an ordinal past its occurrences in section', async () => {
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, BODY)
    expect(await runCli(['section', file + "::Bob's notes#3"])).toBe(1)
    expect(out.join('')).toContain(`Heading "Bob's notes" has 2 occurrences in "${file}"; valid ordinals are #1 to #2`)
  })

  it('quotes a missing and an ambiguous --after heading in insert-section, leaving the file untouched', async () => {
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, BODY)
    expect(await runCli(['insert-section', file, '--after', "it's gone", '--content-b64', NEW_B64])).toBe(1)
    expect(out.join('')).toContain(`Section "it's gone" not found in "${file}"`)
    out.length = 0
    expect(await runCli(['insert-section', file, '--after', "Bob's notes", '--content-b64', NEW_B64])).toBe(1)
    expect(out.join('')).toContain(`Ambiguous heading "Bob's notes" in "${file}": 2 headings match.`)
    expect(fs.readFileSync(file, 'utf8')).toBe(BODY)
  })
})
