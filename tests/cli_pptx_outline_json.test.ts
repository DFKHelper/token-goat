import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'
import { buildPptxFixture } from './helpers/ooxml_fixtures.js'

let tmpDir: string
let pptxFile: string
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

describe('pptx-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-pptx-outline-json-'))
    pptxFile = join(tmpDir, 'doc.pptx')
    const pptxData = buildPptxFixture([{ title: 'Slide 1', body: ['Hello'] }])
    writeFileSync(pptxFile, pptxData)

    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)

    const code = await runCli(['pptx-outline', pptxFile, '--json'])

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    const parsed = JSON.parse(stdout.join('')) as Array<{ slide: number; title: string; bodyChars: number; hasNotes: boolean }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.slide).toBe(1)
    expect(parsed[0]?.title).toBe('Slide 1')
  })
})
