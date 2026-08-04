import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// Minimal WebVTT fixture with speaker cues
const VTT_WITH_CUES = `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Speaker A>Hello world

00:00:05.000 --> 00:00:10.000
<v Speaker B>This is a test
`

let tmpDir: string
let vttFile: string
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

describe('transcript-outline --json', () => {
  it('emits structured JSON instead of rejecting --json as unknown', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-transcript-outline-json-'))
    vttFile = join(tmpDir, 'transcript.vtt')
    writeFileSync(vttFile, VTT_WITH_CUES)

    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)

    const code = await runCli(['transcript-outline', vttFile, '--json'])

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    const parsed = JSON.parse(stdout.join('')) as { durationSeconds: number; speakers: Array<{ name: string; cueCount: number }>; markers: Array<{ timestamp: string; preview: string }> }
    expect(parsed).toHaveProperty('durationSeconds')
    expect(parsed).toHaveProperty('speakers')
    expect(parsed).toHaveProperty('markers')
    expect(Array.isArray(parsed.speakers)).toBe(true)
    expect(Array.isArray(parsed.markers)).toBe(true)
    expect(parsed.speakers.length).toBeGreaterThan(0)
  })
})
