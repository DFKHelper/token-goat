import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

// Regression test verifying that image-meta operates completely independently
// of native sharp using the built-in pure-JS image engine.
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
import { encodePng } from '../src/image_engine.js'

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

describe('image-meta pure JS engine without sharp', () => {
  it('runImageMeta succeeds and reports valid dimensions without sharp', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imgmeta-nosharp-'))
    const file = path.join(TMP, 'x.png')
    const rgba = Buffer.alloc(10 * 20 * 4, 255)
    const png = encodePng(10, 20, rgba)
    fs.writeFileSync(file, png)

    const meta = await runImageMeta(file)
    expect(meta.width).toBe(10)
    expect(meta.height).toBe(20)
    expect(meta.format).toBe('png')
    expect(meta.sharpAvailable).toBe(true)
  })

  it('the image-meta CLI command prints valid dimensions without sharp', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imgmeta-nosharp-cli-'))
    const file = path.join(TMP, 'x.png')
    const rgba = Buffer.alloc(15 * 25 * 4, 255)
    const png = encodePng(15, 25, rgba)
    fs.writeFileSync(file, png)

    const output = await captureStdout(() => run(['node', 'token-goat', 'image-meta', file]))
    expect(output).toContain('15x25')
  })
})

