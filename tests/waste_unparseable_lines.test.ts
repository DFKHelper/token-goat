/** `token-goat waste` must say how many transcript lines it could not parse, never print a clean total over a transcript it only partly read. waste.ts::parseTranscript skipped a line that failed JSON.parse with a bare `continue`: an all-truncated transcript printed `Total tokens: 0` and `Tokens by tool: none`, and a half-truncated one printed a total covering half the calls, both at exit 0 with no hint that lines were dropped. The repro is a real transcript file on disk, read by the shipping runWasteCommand; no reader is mocked. Provenance: HAND-DERIVED. The transcript lines follow the Claude Code JSONL shape tests/waste.test.ts already builds (an assistant tool_use line, then a user tool_result line carrying 9000 characters), and the truncation (the last five characters cut, so the object never closes) is the T3 repro's own, computed from the input rather than read off the parser. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runWasteCommand } from '../src/cli_waste.js'

let tempDir: string

function goodLines(pairs: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < pairs; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Read', input: { file_path: `/x/f${i}.ts` } }] } }))
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: 'x'.repeat(9000) }] } }))
  }
  return lines
}

function writeTranscript(name: string, lines: string[]): string {
  const file = path.join(tempDir, name)
  fs.writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n')
  return file
}

/** Cuts the last five characters, so the object never closes and JSON.parse throws. */
function truncate(line: string): string {
  return line.slice(0, -5)
}

async function waste(transcript: string, json: boolean): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await runWasteCommand({ transcript, json })
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-unparseable-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('waste over a transcript with unparseable lines', () => {
  it('an all-truncated transcript prints the total as unknown, not 0', async () => {
    const file = writeTranscript('all.jsonl', goodLines(4).map(truncate))

    const text = await waste(file, false)
    expect(text).toMatch(/Total tokens: unknown \(.*8 of 8 transcript lines/)
    expect(text, 'a clean zero total over lines nobody read').not.toMatch(/Total tokens: 0\b/)

    const report = JSON.parse(await waste(file, true)) as Record<string, unknown>
    expect(report['totalTokens']).toBeNull()
    expect(report['unparseableLines']).toBe(8)
    expect(report['transcriptLines']).toBe(8)
  })

  it('a half-truncated transcript keeps its total but states the share it could not read', async () => {
    const file = writeTranscript('half.jsonl', goodLines(4).map((l, i) => (i % 2 === 0 ? l : truncate(l))))

    const text = await waste(file, false)
    expect(text).toMatch(/Total tokens: \d+ \(lower bound: 4 of 8 transcript lines could not be parsed\)/)

    const report = JSON.parse(await waste(file, true)) as Record<string, unknown>
    expect(typeof report['totalTokens']).toBe('number')
    expect(report['unparseableLines']).toBe(4)
    expect(report['transcriptLines']).toBe(8)
  })

  it('control: a fully parseable transcript prints a plain total and no skipped-line note', async () => {
    const file = writeTranscript('good.jsonl', goodLines(4))

    const text = await waste(file, false)
    expect(text).toMatch(/Total tokens: [1-9]\d*\n/)
    expect(text).not.toContain('could not be parsed')

    const report = JSON.parse(await waste(file, true)) as Record<string, unknown>
    expect(report['unparseableLines']).toBe(0)
    expect(report['transcriptLines']).toBe(8)
  })

  it('control: a genuinely empty transcript is a measured zero, not unknown', async () => {
    const file = writeTranscript('empty.jsonl', [])

    const text = await waste(file, false)
    expect(text).toMatch(/Total tokens: 0\n/)
    expect(text).not.toContain('unknown')

    const report = JSON.parse(await waste(file, true)) as Record<string, unknown>
    expect(report['totalTokens']).toBe(0)
    expect(report['unparseableLines']).toBe(0)
  })
})
