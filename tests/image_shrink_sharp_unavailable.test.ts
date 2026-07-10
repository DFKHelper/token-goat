import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// Regression test for Fix 2 (sharp reclassified to optionalDependencies): the
// lazy `await import('sharp')` in image_shrink.ts must genuinely degrade (return
// null / pass through unshrunk) when the `sharp` module is unavailable, not just
// assume it is always installed. Mock the module resolution to throw, mirroring
// what actually happens when an optionalDependency failed to install.
vi.mock('sharp', () => {
  throw new Error('Cannot find module \'sharp\'')
})

const _testConfigPath = path.join(os.tmpdir(), `tg-image-shrink-sharp-unavailable-${process.pid}.toml`)
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { preReadImageHandler, shrinkImage } from '../src/image_shrink.js'
import { makeHookEvent } from './helpers/hook-event.js'

describe('sharp unavailable degrade path', () => {
  it('shrinkImage returns null instead of throwing when sharp cannot be loaded', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-nosharp-'))
    const largePath = path.join(TMP, 'large.bin')
    fs.writeFileSync(largePath, Buffer.alloc(600 * 1024, 1))
    const buf = fs.readFileSync(largePath)
    const result = await shrinkImage(buf)
    expect(result).toBeNull()
  })

  it('preReadImageHandler passes through (no crash, no shrink) when sharp is unavailable', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-nosharp-'))
    const largePath = path.join(TMP, 'large.jpg')
    fs.writeFileSync(largePath, Buffer.alloc(600 * 1024, 1))
    const event = makeHookEvent({
      toolName: 'Read',
      toolInput: { file_path: largePath },
    })
    const result = await preReadImageHandler(event)
    expect(result.hookType).toBe('pass')
  })
})
