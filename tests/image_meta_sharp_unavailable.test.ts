import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

// Regression test mirroring image_shrink_sharp_unavailable.test.ts: image-meta reads sharp
// metadata only, so it must degrade with a clear, actionable message (not crash, not report
// fabricated dimensions) when the optional `sharp` dependency is unavailable.
vi.mock('sharp', () => {
  throw new Error('Cannot find module \'sharp\'')
})

const _testConfigPath = tempConfigPath('tg-image-meta-sharp-unavailable.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { runImageMeta } from '../src/read_commands.js'
import { run } from '../src/cli.js'

/** Captures everything the CLI's own out() (process.stdout.write) prints during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = ''
  const origWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = origWrite
  }
  return output
}

describe('image-meta sharp unavailable degrade path', () => {
  it('runImageMeta returns sharpAvailable: false instead of throwing when sharp cannot be loaded', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imgmeta-nosharp-'))
    const file = path.join(TMP, 'x.png')
    fs.writeFileSync(file, Buffer.alloc(1024, 1))

    const meta = await runImageMeta(file)
    expect(meta.sharpAvailable).toBe(false)
    expect(meta.width).toBe(0)
    expect(meta.bytes).toBe(1024)
  })

  it('the image-meta CLI command prints a clear, actionable unavailable message', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imgmeta-nosharp-cli-'))
    const file = path.join(TMP, 'x.png')
    fs.writeFileSync(file, Buffer.alloc(1024, 1))

    const output = await captureStdout(() => run(['node', 'token-goat', 'image-meta', file]))
    expect(output).toContain('image-meta unavailable (install sharp to use this feature)')
  })
})
