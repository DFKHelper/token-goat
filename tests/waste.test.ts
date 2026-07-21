import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as NodeOs from 'node:os'

// vi.mock is hoisted -- wrap homedir so projectTranscriptsDir/findLatestTranscript resolve
// against an isolated fake home instead of the real developer machine's
// ~/.claude/projects/, which this test must never read from or write into.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import {
  buildWasteReport,
  costPerCall,
  findLatestTranscript,
  neverTouchedAgain,
  parseTranscript,
  projectTranscriptsDir,
  repeatedUncompressedBashCommands,
  tokensByFile,
  tokensByTool,
  topExpensiveCalls,
} from '../src/waste.js'
import { clearModuleCaches } from '../src/reset.js'

let tempDir: string
let fakeHome: string
let origTokenGoatHome: string | undefined

beforeEach(() => {
  clearModuleCaches()
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-test-'))
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-home-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(fakeHome)
  origTokenGoatHome = process.env['TOKEN_GOAT_HOME']
  process.env['TOKEN_GOAT_HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-tghome-'))
})

afterEach(() => {
  clearModuleCaches()
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(fakeHome, { recursive: true, force: true })
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReset()
  if (origTokenGoatHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = origTokenGoatHome
})

/** Write a synthetic transcript JSONL fixture and return its path. */
function writeFixture(tempPath: string, lines: unknown[]): string {
  const file = path.join(tempPath, 'session.jsonl')
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf-8')
  return file
}

function toolUseLine(id: string, name: string, input: unknown, cwd?: string): unknown {
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  }
}

function toolResultLine(toolUseId: string, text: string): unknown {
  return {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
  }
}

describe('projectTranscriptsDir / findLatestTranscript', () => {
  it('slugifies every non-alphanumeric character of the resolved project root', () => {
    // Build a genuinely absolute path on any platform (OS root + segments) rather than
    // hardcoding a Windows drive letter, which resolves as relative-to-cwd on POSIX.
    const input = path.join(path.parse(process.cwd()).root, 'Projects', 'my-app')
    const dir = projectTranscriptsDir(input)
    expect(dir).toContain(path.join('.claude', 'projects'))
    const expectedSlug = path.resolve(input).replace(/[^A-Za-z0-9]/g, '-')
    expect(path.basename(dir)).toBe(expectedSlug)
  })

  it('returns null when no transcripts directory exists', () => {
    expect(findLatestTranscript(path.join(tempDir, 'nonexistent-project'))).toBeNull()
  })

  it('picks the most-recently-modified .jsonl transcript', () => {
    // os.homedir() is mocked to fakeHome (see beforeEach), so this resolves under an
    // isolated temp directory, not the real developer machine's ~/.claude/projects/.
    const projectRoot = path.join(tempDir, 'proj')
    fs.mkdirSync(projectRoot, { recursive: true })
    const transcriptsDir = projectTranscriptsDir(projectRoot)
    fs.mkdirSync(transcriptsDir, { recursive: true })

    const older = path.join(transcriptsDir, 'older.jsonl')
    const newer = path.join(transcriptsDir, 'newer.jsonl')
    fs.writeFileSync(older, '{}\n', 'utf-8')
    fs.writeFileSync(newer, '{}\n', 'utf-8')
    const now = Date.now()
    fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000))
    fs.utimesSync(newer, new Date(now), new Date(now))

    expect(findLatestTranscript(projectRoot)).toBe(newer)
  })
})

describe('parseTranscript', () => {
  it('extracts tool_use calls in order and matches tool_result text by id', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/repo/foo.ts' }),
      toolResultLine('t1', 'file contents here'),
      toolUseLine('t2', 'Bash', { command: 'npm test' }, '/repo'),
      toolResultLine('t2', 'test output'),
    ])

    const { calls, resultTextById } = parseTranscript(transcript)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ seq: 0, id: 't1', name: 'Read', filePath: '/repo/foo.ts', command: null })
    expect(calls[1]).toMatchObject({ seq: 1, id: 't2', name: 'Bash', filePath: null, command: 'npm test', cwd: '/repo' })
    expect(resultTextById.get('t1')).toBe('file contents here')
    expect(resultTextById.get('t2')).toBe('test output')
  })

  it('ignores malformed JSON lines and blank lines instead of throwing', () => {
    const file = path.join(tempDir, 'malformed.jsonl')
    fs.writeFileSync(file, 'not json\n\n' + JSON.stringify(toolUseLine('t1', 'Read', { file_path: '/x.ts' })) + '\n', 'utf-8')
    const { calls } = parseTranscript(file)
    expect(calls).toHaveLength(1)
  })

  it('handles a plain-string tool_result content field, not just an array of text blocks', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Grep', { pattern: 'foo' }),
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plain string result' }] } },
    ])
    const { resultTextById } = parseTranscript(transcript)
    expect(resultTextById.get('t1')).toBe('plain string result')
  })
})

describe('cost aggregation', () => {
  it('tokensByTool sums estimated tokens per tool name, descending', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/a.ts' }),
      toolResultLine('t1', 'x'.repeat(300)),
      toolUseLine('t2', 'Bash', { command: 'ls' }),
      toolResultLine('t2', 'y'.repeat(30)),
      toolUseLine('t3', 'Read', { file_path: '/b.ts' }),
      toolResultLine('t3', 'z'.repeat(300)),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const byTool = tokensByTool(costs)
    expect(byTool[0]?.key).toBe('Read')
    expect(byTool.find((t) => t.key === 'Bash')?.tokens).toBeGreaterThan(0)
    expect(byTool[0]?.tokens).toBeGreaterThan(byTool.find((t) => t.key === 'Bash')?.tokens ?? 0)
  })

  // Regression: costPerCall used compact.ts's estimateTokens, which counts raw text.length with
  // no ANSI stripping -- a colorized Bash result (git diff --color, a color-forcing test runner,
  // etc.) inflated its token estimate by the escape-sequence bytes, skewing which calls the
  // report flags as expensive. overflow_guard.ts's estimateTokens strips ANSI first for exactly
  // this reason; costPerCall now uses that copy instead.
  it('estimates tokens from ANSI-stripped result text, not raw escape-code-inflated length', () => {
    const plain = 'x'.repeat(300)
    const ansiWrapped = `\x1b[32m${plain}\x1b[0m`
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Bash', { command: 'git diff --color' }),
      toolResultLine('t1', ansiWrapped),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const plainTokens = Math.max(1, Math.floor(plain.length / 3) + 1)
    expect(costs[0]?.tokens).toBe(plainTokens)
  })

  it('tokensByFile only aggregates Read/Edit/Write/NotebookEdit calls, keyed by file_path', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/a.ts' }),
      toolResultLine('t1', 'a'.repeat(90)),
      toolUseLine('t2', 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
      toolResultLine('t2', 'ok'),
      toolUseLine('t3', 'Bash', { command: 'ls' }),
      toolResultLine('t3', 'listing'),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const byFile = tokensByFile(costs)
    expect(byFile).toHaveLength(1)
    expect(byFile[0]?.key).toBe('/a.ts')
    expect(byFile[0]?.tokens).toBeGreaterThan(0)
  })

  // Regression: FILE_PATH_TOOLS omitted MultiEdit, even though hooks_edit.ts registers it
  // identically to Edit/Write and it carries the same file_path field. tokensByFile silently
  // dropped every MultiEdit call's cost from the per-file breakdown instead of attributing it.
  it('tokensByFile also aggregates MultiEdit calls, keyed by file_path', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'MultiEdit', { file_path: '/b.ts', edits: [{ old_string: 'x', new_string: 'y' }] }),
      toolResultLine('t1', 'ok'.repeat(50)),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const byFile = tokensByFile(costs)
    expect(byFile).toHaveLength(1)
    expect(byFile[0]?.key).toBe('/b.ts')
    expect(byFile[0]?.tokens).toBeGreaterThan(0)
  })

  it('topExpensiveCalls returns the N highest-cost calls, descending', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/small.ts' }),
      toolResultLine('t1', 'x'.repeat(30)),
      toolUseLine('t2', 'Read', { file_path: '/big.ts' }),
      toolResultLine('t2', 'y'.repeat(3000)),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const top = topExpensiveCalls(costs, 1)
    expect(top).toHaveLength(1)
    expect(top[0]?.filePath).toBe('/big.ts')
  })
})

describe('neverTouchedAgain', () => {
  it('flags a file read once and never referenced again', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/orphan.ts' }),
      toolResultLine('t1', 'z'.repeat(100)),
      toolUseLine('t2', 'Bash', { command: 'ls' }),
      toolResultLine('t2', 'unrelated'),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const flagged = neverTouchedAgain(costs)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ filePath: '/orphan.ts' })
    expect(flagged[0]?.tokens).toBeGreaterThan(0)
  })

  it('does not flag a file that is Read again later', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/touched.ts' }),
      toolResultLine('t1', 'a'.repeat(50)),
      toolUseLine('t2', 'Read', { file_path: '/touched.ts' }),
      toolResultLine('t2', 'b'.repeat(50)),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    expect(neverTouchedAgain(costs)).toHaveLength(0)
  })

  it('does not flag a file that is Edited afterward', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/edited.ts' }),
      toolResultLine('t1', 'a'.repeat(50)),
      toolUseLine('t2', 'Edit', { file_path: '/edited.ts', old_string: 'x', new_string: 'y' }),
      toolResultLine('t2', 'ok'),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    expect(neverTouchedAgain(costs)).toHaveLength(0)
  })

  it('does not flag a file whose path is only mentioned inside a later tool input (e.g. a scoped Bash command)', () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/mentioned.ts' }),
      toolResultLine('t1', 'a'.repeat(50)),
      toolUseLine('t2', 'Bash', { command: 'rm /mentioned.ts' }),
      toolResultLine('t2', 'ok'),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    expect(neverTouchedAgain(costs)).toHaveLength(0)
  })
})

describe('repeatedUncompressedBashCommands', () => {
  it('flags a command normalized-and-grouped, run 2+ times, with no bash-output cache hit', async () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Bash', { command: 'git status' }, tempDir),
      toolResultLine('t1', 'x'.repeat(100)),
      toolUseLine('t2', 'Bash', { command: 'git   status' }, tempDir), // normalizes to the same key
      toolResultLine('t2', 'y'.repeat(100)),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    const flagged = await repeatedUncompressedBashCommands(costs)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ normalized: 'git status', count: 2 })
    expect(flagged[0]?.totalTokens).toBeGreaterThan(0)
  })

  it('does not flag a command run only once', async () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Bash', { command: 'echo hi' }, tempDir),
      toolResultLine('t1', 'hi'),
    ])
    const costs = costPerCall(parseTranscript(transcript))
    expect(await repeatedUncompressedBashCommands(costs)).toHaveLength(0)
  })
})

describe('buildWasteReport', () => {
  it('assembles totals, per-tool/per-file breakdowns, and waste signals from a transcript file', async () => {
    const transcript = writeFixture(tempDir, [
      toolUseLine('t1', 'Read', { file_path: '/orphan.ts' }),
      toolResultLine('t1', 'x'.repeat(300)),
      toolUseLine('t2', 'Bash', { command: 'git status' }, tempDir),
      toolResultLine('t2', 'y'.repeat(100)),
      toolUseLine('t3', 'Bash', { command: 'git status' }, tempDir),
      toolResultLine('t3', 'z'.repeat(100)),
    ])

    const report = await buildWasteReport(transcript, { topN: 5 })
    expect(report.transcriptPath).toBe(transcript)
    expect(report.totalTokens).toBeGreaterThan(0)
    expect(report.tokensByTool.length).toBeGreaterThan(0)
    expect(report.topCalls.length).toBeGreaterThan(0)
    expect(report.neverTouchedAgain.some((f) => f.filePath === '/orphan.ts')).toBe(true)
    expect(report.repeatedUncompressedBash.some((c) => c.normalized === 'git status')).toBe(true)
  })
})
