/**
 * The two things that happen to text on its way from an editor selection into a chat message:
 * personal data is taken out of it, and what is left is fenced.
 *
 * Both had a hole. The email pattern's domain part let one character class match the separator
 * that follows it, so a long run that never completes an address was re-tried from every position
 * -- quadratic, on the extension host's own thread, with the editor frozen for the duration. And
 * the compressor returned the text unfenced whenever the decoder was not set up, which is the
 * branch a user hits before they have ever installed anything: raw editor content landing between
 * two sentences the composer wrote, with nothing marking where it starts or stops.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { compressText, fencePayload, resetDecoderCheckedForTests, scrubPii } from '../src/extension'

// 'vscode' only exists inside a real extension host; faked wholesale the way decoder_setup.test.ts
// does. `get` answers every setting with its own default so scrubbing and stats stay on.
const { setStatusBarMessage, showWarningMessage, showInformationMessage, showErrorMessage } = vi.hoisted(() => ({
  setStatusBarMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}))

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback, update: vi.fn() }),
  },
  window: { setStatusBarMessage, showWarningMessage, showInformationMessage, showErrorMessage },
  ConfigurationTarget: { Global: 1 },
}))

const runTokenGoat = vi.hoisted(() => vi.fn())
vi.mock('../src/launcher', () => ({
  runTokenGoat,
  assertSafeArgSegment: vi.fn(),
  runGitDiff: vi.fn(),
  resolveNodeExecutable: vi.fn(),
  resolveTokenGoatEntrypoint: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  resetDecoderCheckedForTests()
})

/** Milliseconds spent scrubbing `text`, which is time the extension host spends doing nothing else. */
function scrubMillis(text: string): number {
  const started = Date.now()
  scrubPii(text)
  return Date.now() - started
}

describe('scrubbing personal data out of a selection', () => {
  it('still finds the addresses it is there to find', () => {
    const scrubbed = scrubPii('mail bob.smith+tag@example.co.uk and a@b.io about it')
    expect(scrubbed).toBe('mail [email removed] and [email removed] about it')
  })

  it('leaves text that only looks like an address alone', () => {
    expect(scrubPii('write to nobody@ or @nowhere.com')).toBe('write to nobody@ or @nowhere.com')
  })

  it('takes the other three kinds out too, so the bounded pattern did not narrow the sweep', () => {
    const scrubbed = scrubPii('ssn 123-45-6789 card 4111 1111 1111 1111 tel 555-867-5309')
    expect(scrubbed).toContain('[id-number removed]')
    expect(scrubbed).toContain('[card-number removed]')
    expect(scrubbed).toContain('[phone removed]')
  })

  it('costs the same per character however long the near-match run is', () => {
    // HAND-DERIVED from the pattern's shape, not from any output of it: `a-` repeated is a domain
    // label that never reaches a dot, so every starting position is a partial match that fails at
    // the end of the run. Under the unbounded pattern this was measured at 6 / 22 / 83 / 337 ms
    // for 2k / 4k / 8k / 16k -- four times the work for twice the input, which is the signature.
    // Bounded, all four are single-digit milliseconds, so the ratio is the assertion, not a
    // wall-clock threshold that a loaded CI runner could trip on its own.
    const runOf = (pairs: number): string => `a@${'a-'.repeat(pairs)}!`
    scrubMillis(runOf(1000)) // warm the JIT, so the first measurement is not the slow one
    const small = scrubMillis(runOf(4000))
    const large = scrubMillis(runOf(32000))
    // Eight times the input. Linear allows roughly eight times the time; quadratic needs sixty-four.
    expect(large).toBeLessThan(Math.max(80, small * 16))
  })
})

describe('what reaches the chat message', () => {
  it('is fenced when the decoder is set up and the payload came back compressed', async () => {
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: true, checkedPaths: [] }))
    runTokenGoat.mockResolvedValueOnce(JSON.stringify({ configured: true, checkedPaths: [] }))
    runTokenGoat.mockResolvedValueOnce('compact_bytes: 12\nrecovery: token-goat retrieve abc')
    const out = await compressText('some selected text', '.txt')
    expect(out).toBe(fencePayload('compact_bytes: 12\nrecovery: token-goat retrieve abc'))
  })

  it('is fenced when there is no decoder and the text goes through as it is', async () => {
    // The branch every user hits before installing anything. It used to return the bare string,
    // so editor content ran straight into the composer's own sentence on both sides.
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: false, checkedPaths: [] }))
    showWarningMessage.mockResolvedValue('Not now')
    const out = await compressText('some selected text', '.txt')
    expect(out).toBe(fencePayload('some selected text'))
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
  })

  it('has the personal data out of it on that branch too, and says so', async () => {
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: false, checkedPaths: [] }))
    showWarningMessage.mockResolvedValue('Not now')
    const out = await compressText('reach me at bob@example.com', '.txt')
    expect(out).toContain('[email removed]')
    expect(out).not.toContain('bob@example.com')
    // Told, not silently done: pre-fix this branch returned before the notice was ever reached.
    expect(setStatusBarMessage.mock.calls.some(([message]) => String(message).includes('personal-data'))).toBe(true)
  })
})
