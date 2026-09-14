/** The two things that happen to text on its way from an editor selection into a chat message: personal data is taken out of it, and what is left is fenced. Both had a hole. The email pattern's domain part let one character class match the separator that follows it, so a long run that never completes an address was re-tried from every position -- quadratic, on the extension host's own thread, with the editor frozen for the duration. And the compressor returned the text unfenced whenever the decoder was not set up, which is the branch a user hits before they have ever installed anything: raw editor content landing between two sentences the composer wrote, with nothing marking where it starts or stops. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { compressText, fencePayload, resetDecoderCheckedForTests, scrubPii } from '../src/extension'

// 'vscode' only exists inside a real extension host; faked wholesale the way decoder_setup.test.ts does. `get` answers every setting with its own default so scrubbing and stats stay on.
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

/** What one scrub of `text` costs, averaged over `runs`. Averaged and taken off the high-resolution clock because the assertion is a ratio: a single `Date.now()` scrub of the smaller input can measure 0 or 1 ms, and a ratio against a number that coarse compares noise to noise. */
function scrubMillis(text: string, runs: number): number {
  const started = performance.now()
  for (let i = 0; i < runs; i++) scrubPii(text)
  return (performance.now() - started) / runs
}

describe('scrubbing personal data out of a selection', () => {
  it('still finds the addresses it is there to find', () => {
    const scrubbed = scrubPii('mail bob.smith+tag@example.co.uk and a@b.io about it')
    expect(scrubbed.text).toBe('mail [email removed] and [email removed] about it')
    expect(scrubbed.redactions, 'the count travels with the text it describes, not in a module global').toBe(2)
  })

  it('leaves text that only looks like an address alone', () => {
    expect(scrubPii('write to nobody@ or @nowhere.com')).toEqual({ text: 'write to nobody@ or @nowhere.com', redactions: 0 })
  })

  it('takes the other three kinds out too, so the bounded pattern did not narrow the sweep', () => {
    const scrubbed = scrubPii('ssn 123-45-6789 card 4111 1111 1111 1111 tel 555-867-5309')
    expect(scrubbed.text).toContain('[id-number removed]')
    expect(scrubbed.text).toContain('[card-number removed]')
    expect(scrubbed.text).toContain('[phone removed]')
    expect(scrubbed.redactions).toBe(3)
  })

  it('takes the whole address or none of it, never the tail of one beside a notice saying it went', () => {
    // A local part past the bound used to re-anchor inside itself and match only its last 64 characters, so the first characters of a real address shipped intact, immediately left of the marker claiming it had been removed. That is worse than a miss: a miss is visible.
    const scrubbed = scrubPii(`mail ${'b'.repeat(70)}@example.com now`)
    expect(scrubbed.text).not.toContain('bb')
    expect(scrubbed.text).toContain('[email removed]')
  })

  it('costs the same per character however long the near-match run is', () => {
    // HAND-DERIVED from the pattern's shape, not from any output of it: `a-` repeated is a domain label that never reaches a dot, so every starting position is a partial match that fails at the end of the run. Under the unbounded pattern this was measured at 6 / 22 / 83 / 337 ms for 2k / 4k / 8k / 16k -- four times the work for twice the input, which is the signature. Bounded, all four are single-digit milliseconds, so the ratio is the assertion, not a wall-clock threshold that a loaded CI runner could trip on its own.
    const runOf = (pairs: number): string => `a@${'a-'.repeat(pairs)}!`
    scrubMillis(runOf(1000), 20) // warm the JIT, so the first measurement is not the slow one
    const small = scrubMillis(runOf(4000), 20)
    const large = scrubMillis(runOf(32000), 5)
    // Eight times the input. Linear allows roughly eight times the time; quadratic needs sixty-four. No wall-clock floor beside the ratio: a floor is loosest exactly where the small measurement is smallest, which is where a quadratic implementation slips under it.
    expect(large).toBeLessThan(small * 24)
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
    // The branch every user hits before installing anything. It used to return the bare string, so editor content ran straight into the composer's own sentence on both sides.
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

  it('fences a file that is mostly backticks, rather than throwing on the count of them', () => {
    // Sizing the fence once meant spreading one argument per backtick run into Math.max, and V8 refuses past roughly 125,000 arguments -- so an ordinary file of about 260 KB turned a fence into a RangeError. The runs are attacker-supplied by anyone who can put a file in the repo.
    const payload = 'a`'.repeat(130_000)
    const out = fencePayload(payload)
    expect(out).toContain(payload)
    // Every run here is a single backtick, so the ordinary three-backtick fence is wide enough.
    expect(out.split('\n')[0]).toBe('```')
  })
})
