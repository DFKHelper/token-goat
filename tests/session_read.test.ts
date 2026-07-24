import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'

// vi.mock is hoisted -- wrap homedir so projectTranscriptsDir/resolveSessionTranscript resolve
// against an isolated fake home instead of the real developer machine's
// ~/.claude/projects/, which this test must never read from or write into.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

// vi.mock is hoisted -- wrap createReadStream as a transparent passthrough spy (delegates to the
// real implementation) so one test below can assert streamTurns' finally block actually destroys
// the underlying stream on an early break, without altering real behavior for any other test.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return {
    ...original,
    createReadStream: vi.fn((...args: Parameters<typeof original.createReadStream>) => original.createReadStream(...args)),
  }
})

import {
  buildSessionOutline,
  formatSessionOutline,
  formatSessionSlice,
  parseTurnRange,
  resolveSessionTranscript,
  sliceSessionTurns,
} from '../src/session_read.js'
import { projectTranscriptsDir } from '../src/waste.js'
import { resolveProjectRoot } from '../src/project.js'
import { clearModuleCaches } from '../src/reset.js'

let tempDir: string
let fakeHome: string
let projectRoot: string
let transcriptsDir: string

beforeEach(() => {
  clearModuleCaches()
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-read-test-'))
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-read-home-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(fakeHome)
  projectRoot = path.join(tempDir, 'proj')
  fs.mkdirSync(projectRoot, { recursive: true })
  // resolveSessionTranscript resolves --project through resolveProjectRoot (same as
  // cli_waste.ts's runWasteCommand) before slugifying it into a transcripts dir, so the
  // fixture must be written under that resolved root's dir, not the raw tempDir path
  // (resolveProjectRoot's canonicalize() can normalize drive-letter casing on Windows).
  transcriptsDir = projectTranscriptsDir(resolveProjectRoot({ project: projectRoot }))
  fs.mkdirSync(transcriptsDir, { recursive: true })
})

afterEach(() => {
  clearModuleCaches()
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(fakeHome, { recursive: true, force: true })
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReset()
})

/** A realistic multi-turn synthetic transcript: user text, assistant tool_use, tool_result, another assistant turn -- plus a mix of non-turn bookkeeping lines that must be skipped. */
function fixtureLines(): unknown[] {
  return [
    { type: 'custom-title', customTitle: 'test session' },
    { type: 'mode', mode: 'normal' },
    { type: 'user', message: { role: 'user', content: 'Please read config.ts and summarize it.' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read the file first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/config.ts' } },
        ],
      },
    },
    { type: 'attachment', foo: 'bar' },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export const X = 1\n'.repeat(20) }] }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'config.ts exports a single constant X set to 1.' }],
      },
    },
  ]
}

function writeFixture(lines: unknown[], name = 'session.jsonl'): string {
  const file = path.join(transcriptsDir, name)
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf-8')
  return file
}

describe('resolveSessionTranscript', () => {
  it('resolves an explicit existing file path directly', () => {
    const file = writeFixture(fixtureLines())
    expect(resolveSessionTranscript(file, { project: projectRoot })).toBe(file)
  })

  it('resolves a bare session id against the project transcripts dir', () => {
    const file = writeFixture(fixtureLines(), 'abc-123.jsonl')
    expect(resolveSessionTranscript('abc-123', { project: projectRoot })).toBe(file)
  })

  it('defaults to the most-recently-modified transcript when no arg is given', () => {
    const older = writeFixture(fixtureLines(), 'older.jsonl')
    const newer = writeFixture(fixtureLines(), 'newer.jsonl')
    const now = Date.now()
    fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000))
    fs.utimesSync(newer, new Date(now), new Date(now))
    expect(resolveSessionTranscript(undefined, { project: projectRoot })).toBe(newer)
  })

  it('returns null for an unknown session id', () => {
    expect(resolveSessionTranscript('does-not-exist', { project: projectRoot })).toBeNull()
  })

  // Regression (mutation-testing gap): a session id passed with an already-present `.jsonl`
  // suffix (not a literal existing path relative to cwd, so it falls through to id resolution)
  // must resolve to `<id>.jsonl`, not `<id>.jsonl.jsonl`. A mutation always appending the suffix
  // unconditionally still passed the full suite, since the only bare-id case tested omits it.
  it('resolves a session id that already carries the .jsonl suffix without doubling it', () => {
    const file = writeFixture(fixtureLines(), 'xyz-456.jsonl')
    expect(resolveSessionTranscript('xyz-456.jsonl', { project: projectRoot })).toBe(file)
  })

  it('returns null when no transcripts exist and no arg is given', () => {
    expect(resolveSessionTranscript(undefined, { project: path.join(tempDir, 'no-such-project') })).toBeNull()
  })
})

describe('buildSessionOutline', () => {
  it('shows turn structure without full tool_result/text content', async () => {
    const file = writeFixture(fixtureLines())
    const turns = await buildSessionOutline(file)

    // Only the 4 real user/assistant turns are numbered -- custom-title/mode/attachment are skipped.
    expect(turns).toHaveLength(4)
    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3, 4])
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    const toolTurn = turns[1]
    expect(toolTurn?.toolCalls).toEqual(['Read'])

    const resultTurn = turns[2]
    // Preview must not contain the full 20-line repeated body -- it's truncated.
    expect(resultTurn?.preview.length).toBeLessThan(200)
    expect(resultTurn?.preview).not.toContain('export const X = 1\nexport const X = 1\nexport const X = 1')

    // Exact per-turn tokens/bytes/lineNumber from the fixed fixtureLines() fixture -- pins the
    // real computed values instead of just checking each is nonzero.
    expect(turns.map((t) => ({ tokens: t.tokens, bytes: t.bytes, lineNumber: t.lineNumber }))).toEqual([
      { tokens: 32, bytes: 93, lineNumber: 3 },
      { tokens: 72, bytes: 215, lineNumber: 4 },
      { tokens: 180, bytes: 538, lineNumber: 6 },
      { tokens: 46, bytes: 136, lineNumber: 7 },
    ])
  })

  it('returns an empty array for a transcript with no user/assistant turns', async () => {
    const file = writeFixture([{ type: 'custom-title', customTitle: 'x' }, { type: 'mode', mode: 'normal' }])
    expect(await buildSessionOutline(file)).toEqual([])
  })

  it('skips malformed JSON lines instead of throwing', async () => {
    const file = path.join(transcriptsDir, 'malformed.jsonl')
    fs.writeFileSync(
      file,
      'not json\n\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      'utf-8',
    )
    const turns = await buildSessionOutline(file)
    expect(turns).toHaveLength(1)
  })
})

describe('sliceSessionTurns', () => {
  it('extracts full content for the requested turn range only', async () => {
    const file = writeFixture(fixtureLines())
    const slice = await sliceSessionTurns(file, 2, 3)

    expect(slice.map((t) => t.turn)).toEqual([2, 3])

    const toolUseTurn = slice[0]
    const toolUseBlock = toolUseTurn?.blocks.find((b) => b.type === 'tool_use')
    expect(toolUseBlock?.name).toBe('Read')
    expect(toolUseBlock?.input).toEqual({ file_path: '/repo/config.ts' })

    const resultTurn = slice[1]
    const resultBlock = resultTurn?.blocks.find((b) => b.type === 'tool_result')
    // Full content, not truncated -- 20 repeats of a 19-char line.
    expect(resultBlock?.resultText).toBe('export const X = 1\n'.repeat(20))
  })

  it('returns an empty array when the range is entirely past the end of the transcript', async () => {
    const file = writeFixture(fixtureLines())
    expect(await sliceSessionTurns(file, 50, 60)).toEqual([])
  })

  it('a single-turn range extracts exactly one turn', async () => {
    const file = writeFixture(fixtureLines())
    const slice = await sliceSessionTurns(file, 1, 1)
    expect(slice).toHaveLength(1)
    expect(slice[0]?.role).toBe('user')
    expect(slice[0]?.blocks[0]?.text).toBe('Please read config.ts and summarize it.')
  })

  it('destroys the underlying read stream, not just the readline interface, on an early break', async () => {
    // Regression: streamTurns' `finally` block only called rl.close(), which does not itself
    // destroy the fs.ReadStream backing it -- an early `break` (any range ending before the
    // transcript's last turn, like this 1-1 slice) left the file's read handle/fd open until GC.
    const file = writeFixture(fixtureLines())
    const createReadStreamSpy = vi.mocked(fs.createReadStream)
    createReadStreamSpy.mockClear()
    await sliceSessionTurns(file, 1, 1)
    expect(createReadStreamSpy).toHaveBeenCalledTimes(1)
    const stream = createReadStreamSpy.mock.results[0]?.value as fs.ReadStream
    expect(stream.destroyed).toBe(true)
  })
})

describe('parseTurnRange', () => {
  it('parses a single number as a one-turn range', () => {
    expect(parseTurnRange('5')).toEqual({ start: 5, end: 5 })
  })

  it('parses an N-M range', () => {
    expect(parseTurnRange('3-7')).toEqual({ start: 3, end: 7 })
  })

  it('rejects an inverted range', () => {
    expect(() => parseTurnRange('7-3')).toThrow(/invalid --range spec/)
  })

  it('rejects a non-numeric spec', () => {
    expect(() => parseTurnRange('abc')).toThrow(/invalid --range spec/)
  })

  // Regression (mutation-testing gap): turns are 1-based (see streamTurns' doc comment), so a
  // spec of "0" must be rejected the same way an inverted range is -- silently accepting it
  // would functionally coincide with start=1 (since no turn is ever 0), masking a user's typo
  // as if it had been interpreted correctly. A mutation dropping the `start < 1` half of the
  // guard (keeping only `end < start`) still passed the full suite.
  it('rejects a spec starting at turn 0', () => {
    expect(() => parseTurnRange('0')).toThrow(/invalid --range spec/)
    expect(() => parseTurnRange('0-5')).toThrow(/invalid --range spec/)
  })
})

describe('formatSessionOutline / formatSessionSlice', () => {
  it('formats an outline as one line per turn with turn number, role, and tool calls', async () => {
    const file = writeFixture(fixtureLines())
    const text = formatSessionOutline(await buildSessionOutline(file))
    expect(text).toContain('1. [user]')
    expect(text).toContain('2. [assistant]')
    expect(text).toContain('[tools: Read]')
  })

  it('formats a slice as full turn content', async () => {
    const file = writeFixture(fixtureLines())
    const text = formatSessionSlice(await sliceSessionTurns(file, 2, 3))
    expect(text).toContain('Turn 2 [assistant]')
    expect(text).toContain('tool_use: Read')
    expect(text).toContain('export const X = 1')
  })

  // Regression (mutation-testing gap): toSessionBlock prefers a block's `text` field over its
  // `thinking` field when (unusually) both are present as strings on the same raw block -- the
  // `thinking` assignment is guarded by `block.text === undefined` specifically so it never
  // clobbers a `text` value already set. A mutation dropping that guard (unconditionally
  // overwriting from `thinking` whenever present) still passed the full suite, since no fixture
  // exercises a block carrying both fields at once.
  it('prefers a block\'s text field over thinking when a raw block improbably carries both', async () => {
    const file = writeFixture([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'real answer', thinking: 'internal reasoning' }],
        },
      },
    ])
    const text = formatSessionSlice(await sliceSessionTurns(file, 1, 1))
    expect(text).toContain('real answer')
    expect(text).not.toContain('internal reasoning')
  })

  it('reports no turns found / no turns in range for empty inputs', () => {
    expect(formatSessionOutline([])).toBe('(no turns found)')
    expect(formatSessionSlice([])).toBe('(no turns in range)')
  })

  // Regression (mutation-testing gap): formatBlock's default branch (any block `type` other than
  // text/thinking/tool_use/tool_result -- e.g. a future/unrecognized content-block type) renders
  // `[<type>]` so the slice still shows *something* identifying the block rather than silently
  // dropping it. A mutation returning '' from that branch instead still passed the full suite,
  // since no existing fixture exercises a block type outside the four named cases.
  it('renders an unrecognized block type as a labeled placeholder, not silently dropped', () => {
    const text = formatSessionSlice([
      { turn: 1, lineNumber: 1, role: 'assistant', blocks: [{ type: 'image' }] },
    ])
    expect(text).toContain('[image]')
  })

  // Regression (mutation-testing gap): a malformed tool_use block missing its `name` field must
  // not appear in the outline's tool-calls list at all. A mutation removing the
  // `b.name !== undefined` half of toolCallsForBlocks' filter still passed the full suite (it
  // surfaces as an empty `[tools: ]` tag, since Array.join renders an undefined element as ''),
  // since no fixture exercises a nameless tool_use block.
  it('omits a nameless tool_use block from the outline\'s tool-calls tag entirely', async () => {
    const file = writeFixture([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', input: {} }],
        },
      },
    ])
    const text = formatSessionOutline(await buildSessionOutline(file))
    expect(text).not.toContain('[tools:')
  })

  // Regression (mutation-testing gap): previewForBlocks' `toolUse.name ?? 'tool'` fallback exists
  // for the same malformed-input case above -- a nameless tool_use block, when it is the only
  // block present (so it drives the preview, not just the tool-calls tag), must render the
  // generic label 'tool(...)' rather than the literal string 'undefined(...)'. A mutation
  // dropping the `?? 'tool'` fallback still passed the full suite.
  it('previews a nameless tool_use block as "tool(...)" rather than "undefined(...)"', async () => {
    const file = writeFixture([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', input: { x: 1 } }],
        },
      },
    ])
    const text = formatSessionOutline(await buildSessionOutline(file))
    expect(text).toContain('tool({"x":1})')
    expect(text).not.toContain('undefined(')
  })
})
