import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runWasteCommand } from '../src/cli_waste.js'
import { normalizePath } from '../src/paths.js'

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    return true
  })
  return {
    text: () => chunks.join(''),
    restore: () => spy.mockRestore(),
  }
}

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    return true
  })
  return {
    text: () => chunks.join(''),
    restore: () => spy.mockRestore(),
  }
}

/** Writes a transcript with `count` distinct-named Bash tool calls, each large enough to register real tokens. */
function writeTranscript(transcriptPath: string, count: number): void {
  const lines: unknown[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `toolu_${i}`
    lines.push({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: `Tool${i}`, input: { command: `cmd-${i}` } }],
      },
    })
    lines.push({
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'x'.repeat(300) }] }],
      },
    })
  }
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
}

describe('runWasteCommand', () => {
  let tempDir: string
  let origExitCode: number | string | null | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-waste-test-'))
    origExitCode = process.exitCode
    process.exitCode = undefined
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    process.exitCode = origExitCode
  })

  it('reports "none" for every section when the transcript has zero tool calls', async () => {
    const transcript = path.join(tempDir, 'empty.jsonl')
    fs.writeFileSync(transcript, '', 'utf-8')

    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript })
    } finally {
      cap.restore()
    }

    const out = cap.text()
    expect(out).toContain('Tokens by tool')
    expect(out).toContain('Top expensive tool calls')
    expect(out).toContain('Read once, never touched again')
    expect(out).toContain('Repeated Bash commands not hitting the token-goat cache')
    // Every section should fall through to the "none" placeholder line.
    expect((out.match(/ {2}none\n/g) ?? []).length).toBe(4)
    expect(process.exitCode).toBeUndefined()

    // Zero-turn assistant-output section must render sensibly -- no NaN, no divide-by-zero,
    // and the singular/plural noun must not print "0 turns" as "0 turn" (or vice versa).
    expect(out).toContain('0 turns, 0 tok generated')
    expect(out).not.toMatch(/NaN/)
    expect(out).toContain('Re-send upper bound: 0 tok')
  })

  it('renders the count==1 singular form ("1 turn", not "1 turns") for a single assistant text turn', async () => {
    const transcript = path.join(tempDir, 'one-turn.jsonl')
    const lines = [
      { message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(50) }] } },
    ]
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')

    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript })
    } finally {
      cap.restore()
    }

    const out = cap.text()
    expect(out).toMatch(/\b1 turn\b/)
    expect(out).not.toMatch(/\b1 turns\b/)
  })

  it('exposes assistantOutput under a stable key in --json mode', async () => {
    const transcript = path.join(tempDir, 'json-turn.jsonl')
    const lines = [
      { message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(50) }] } },
    ]
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')

    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript, json: true })
    } finally {
      cap.restore()
    }

    const parsed = JSON.parse(cap.text()) as { assistantOutput: { turnCount: number; generatedTokens: number; resendCeilingTokens: number } }
    expect(parsed.assistantOutput.turnCount).toBe(1)
    expect(parsed.assistantOutput.resendCeilingTokens).toBe(0)
  })

  it('formats the top-expensive-tool-calls section with tokens, name, and summary', async () => {
    const transcript = path.join(tempDir, 'calls.jsonl')
    writeTranscript(transcript, 2)

    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript })
    } finally {
      cap.restore()
    }

    const out = cap.text()
    // printReport's topCalls line format: `  [${tokens} tok] ${name}: ${summary}\n`
    expect(out).toMatch(/ {2}\[\d+ tok\] Tool0: .*cmd-0/)
    expect(out).toMatch(/ {2}\[\d+ tok\] Tool1: .*cmd-1/)
  })

  it('--top limits the number of entries returned in topCalls (passed through to buildWasteReport)', async () => {
    const transcript = path.join(tempDir, 'many-calls.jsonl')
    writeTranscript(transcript, 5)

    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript, top: 2, json: true })
    } finally {
      cap.restore()
    }

    const parsed = JSON.parse(cap.text()) as { topCalls: unknown[] }
    expect(parsed.topCalls.length).toBe(2)
  })

  it('prints a stderr error and sets exitCode 1 when --transcript points at a nonexistent file', async () => {
    const missing = path.join(tempDir, 'does-not-exist.jsonl')

    const err = captureStderr()
    const out = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, transcript: missing })
    } finally {
      err.restore()
      out.restore()
    }

    expect(err.text()).toContain('transcript not found')
    expect(err.text()).toContain(missing)
    expect(process.exitCode).toBe(1)
    expect(out.text()).toBe('')
  })

  it('prints a text "no transcript found" message and sets exitCode 1 when none is discoverable and none is passed', async () => {
    // No --transcript given, and tempDir's slugged ~/.claude/projects/<slug> dir
    // won't exist, so findLatestTranscript resolves to null.
    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir })
    } finally {
      cap.restore()
    }

    // resolveProjectRoot canonicalizes (lowercased drive letter, forward slashes on
    // Windows), so compare the basename rather than the raw tempDir string.
    expect(cap.text()).toContain('No session transcript found')
    expect(cap.text()).toContain(path.basename(tempDir))
    expect(process.exitCode).toBe(1)
  })

  it('emits JSON (not the text banner) for the no-transcript-found case when --json is passed', async () => {
    const cap = captureStdout()
    try {
      await runWasteCommand({ project: tempDir, json: true })
    } finally {
      cap.restore()
    }

    const parsed = JSON.parse(cap.text()) as { error: string; project: string }
    expect(parsed.error).toBe('no session transcript found')
    expect(normalizePath(parsed.project)).toBe(normalizePath(tempDir))
    expect(process.exitCode).toBe(1)
  })
})
