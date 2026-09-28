// The Copilot CLI adapter the resident hook server runs (src/hook_adapters.ts) answers a `view` of a large image by pointing the call at a shrunk temp copy, as the installed Copilot shim does, and it writes that copy with the function VS Code's image path uses (materializeShrunkImageFile in src/bridges/vscode_hooks.ts) rather than a second typed copy of it. The two copies differed in one thing: the adapter's swept the temp directory at most once an hour per process, as MATERIALIZE_SHRUNK_IMAGE_JS does in every shim, while VS Code's listed the whole temp directory on every image, which in the hook server is every image for as long as the server stays up. The shared function keeps the hourly sweep.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { runAdapter } from '../src/hook_adapters.js'
import { relayInProcess } from '../src/relay.js'

const ENV_KEYS = ['TOKEN_GOAT_HARNESS_OVERRIDE', 'TOKEN_GOAT_OFFLINE', 'TEMP', 'TMP', 'TMPDIR'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let base: string
let tmp: string
let project: string
let image: string

// HAND-DERIVED: random noise at JPEG quality 100, large enough to qualify for a real shrink and certain to re-encode smaller, built as makeLargeJpegFixture in tests/bridges/inprocess.test.ts builds it.
async function writeLargeJpeg(file: string): Promise<void> {
  const side = 1200
  const noise = Buffer.alloc(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  fs.writeFileSync(file, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer())
}

beforeAll(async () => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-view-shrink-')))
  tmp = path.join(base, 'tmp')
  project = path.join(base, 'project')
  fs.mkdirSync(tmp)
  fs.mkdirSync(project)
  // The copies and the sweep go to a temp dir this file owns, so the sweep reaches no other test's files and no other test's files reach these assertions.
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = tmp
  // Noise has no text in it; offline, the OCR attempt that precedes the shrink declines before fetching its language model, as in tests/bridges/inprocess.test.ts.
  process.env['TOKEN_GOAT_OFFLINE'] = '1'
  image = path.join(project, 'shot.jpeg')
  await writeLargeJpeg(image)
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(base, { recursive: true, force: true })
})

// FORMAT-DERIVED: Copilot CLI's preToolUse payload (sessionId, workingDirectory, toolName, and toolArgs as a JSON string) per GitHub's hooks reference, and `view` with a `path` argument per @github/copilot-sdk's tool types, both cited in src/bridges/copilot_cli.ts. `viewRange` is HAND-DERIVED: an extra argument the rewrite has to carry, as in the shim's own test in tests/bridges/inprocess.test.ts.
async function viewModifiedArgs(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const input = JSON.stringify({ sessionId, workingDirectory: project, toolName: 'view', toolArgs: JSON.stringify({ path: image, viewRange: [1, 40] }) })
  // The relay the hook server hands the adapter (src/hook_server.ts), minus its timing and after-reply plumbing.
  const result = await runAdapter('copilot_cli', { event: 'preToolUse', input }, { early: () => 0, relay: (event, payload, harnessWaitMs) => relayInProcess(event, payload, harnessWaitMs) })
  expect(result.exit).toBe(0)
  return (JSON.parse(result.stdout) as { modifiedArgs?: Record<string, unknown> }).modifiedArgs
}

describe('the Copilot CLI adapter on a view of a large image', () => {
  it('points the call at a smaller copy in the temp dir and carries every other argument', async () => {
    const args = await viewModifiedArgs('copilot-view-shrink-copy')
    const copy = args?.['path'] as string
    expect(typeof copy).toBe('string')
    expect(path.dirname(copy)).toBe(tmp)
    expect(path.basename(copy)).toMatch(/^token-goat-shrink-\d+-\d+-[a-z0-9-]+\.(jpeg|webp)$/)
    expect(fs.statSync(copy).size).toBeLessThan(fs.statSync(image).size)
    expect(args?.['viewRange']).toEqual([1, 40])
  })

  it.skipIf(process.platform === 'win32')('writes the copy readable by its owner only (0600)', async () => {
    const copy = (await viewModifiedArgs('copilot-view-shrink-mode'))?.['path'] as string
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600)
  })
})

describe('the sweep of earlier shrunk copies', () => {
  it('runs on the first copy a process writes and after that at most once an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    // A fresh module, so the first call below is this process's first sweep whatever ran before it in this file.
    vi.resetModules()
    const { materializeShrunkImageFile } = await import('../src/bridges/vscode_hooks.js')
    // FORMAT-DERIVED: the "<summary>\ndata:image/<fmt>;base64,<data>" payload formatShrinkSummary builds in src/image_shrink.ts. The bytes are HAND-DERIVED; the function writes them without decoding an image.
    const context = 'shrunk\ndata:image/png;base64,' + Buffer.from('not decoded').toString('base64')
    // HAND-DERIVED: a copy an earlier call left behind two hours ago, in the name shape the function writes.
    const plantStale = (name: string): string => {
      const file = path.join(tmp, `token-goat-shrink-999999-0-${name}.png`)
      fs.writeFileSync(file, 'old')
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      fs.utimesSync(file, twoHoursAgo, twoHoursAgo)
      return file
    }

    const first = plantStale('first')
    expect(materializeShrunkImageFile(context)).toBeDefined()
    expect(fs.existsSync(first)).toBe(false)

    const second = plantStale('second')
    vi.setSystemTime(start + 30 * 60 * 1000)
    expect(materializeShrunkImageFile(context)).toBeDefined()
    expect(fs.existsSync(second)).toBe(true)

    vi.setSystemTime(start + 61 * 60 * 1000)
    expect(materializeShrunkImageFile(context)).toBeDefined()
    expect(fs.existsSync(second)).toBe(false)
  })
})
