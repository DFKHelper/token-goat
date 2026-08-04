import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'
import { buildDocxFixture } from './helpers/ooxml_fixtures.js'

let tmpDir: string
let docxFile: string
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

describe('docx-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-docx-outline-json-'))
    docxFile = join(tmpDir, 'doc.docx')
    const docxData = buildDocxFixture([{ text: 'Heading 1', headingLevel: 1 }, { text: 'Heading 2', headingLevel: 2 }])
    writeFileSync(docxFile, docxData)

    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)

    const code = await runCli(['docx-outline', docxFile, '--json'])

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    const parsed = JSON.parse(stdout.join('')) as Array<{ level: number; text: string }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.level).toBe(1)
    expect(parsed[0]?.text).toBe('Heading 1')
    expect(parsed[1]?.level).toBe(2)
    expect(parsed[1]?.text).toBe('Heading 2')
  })
})
