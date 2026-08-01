// Regression guard: read_commands.ts exports runListSections (list every heading in a file),
// but cli.ts never imported it or registered a --list flag on the `section` command, so
// `token-goat section <file> --list` was a dead command surface -- Commander rejected --list
// outright as an unknown option instead of listing sections. Drive the real run() entry so
// this exercises the actual command wiring, not the handler function in isolation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let tmpDir: string
let mdFile: string
let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true })
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

describe('section --list', () => {
  it('lists every heading in a file instead of rejecting --list as unknown', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-section-list-'))
    mdFile = join(tmpDir, 'doc.md')
    // listSections() returns only the shallowest heading level found in the file, so this
    // fixture uses two same-level headings (no top H1) to exercise both entries.
    writeFileSync(mdFile, ['## First Heading', 'body a', '', '## Second Heading', 'body b', ''].join('\n'), 'utf-8')

    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)

    const code = await runCli(['section', mdFile, '--list'])

    expect(stderr.join('')).not.toMatch(/unknown option/)
    expect(code).toBe(0)
    const out = stdout.join('')
    expect(out).toContain('First Heading')
    expect(out).toContain('Second Heading')
  })
})
