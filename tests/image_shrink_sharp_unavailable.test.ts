import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// The shrink path must not need sharp. It once loaded it lazily and had to degrade when the
// optionalDependency was missing; since the move to the pure-TypeScript engine in
// `image_engine.ts` it must not reach for sharp at all. Mocking the module to be unresolvable
// pins that: reintroducing an `import('sharp')` anywhere under shrinkImage would fail here rather
// than quietly making a native library load-bearing again on a path that no longer needs one. The
// undecodable inputs below therefore have to pass through on their own merits.
vi.mock('sharp', () => {
  throw new Error('Cannot find module \'sharp\'')
})

const _testConfigPath = tempConfigPath('tg-image-shrink-sharp-unavailable.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { preReadImageHandler, shrinkImage } from '../src/image_shrink.js'
import { makeHookEvent } from './helpers/hook-event.js'

describe('the shrink path does not reach for sharp', () => {
  it('shrinkImage returns null on bytes it cannot decode, with sharp unresolvable', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-nosharp-'))
    const largePath = path.join(TMP, 'large.bin')
    fs.writeFileSync(largePath, Buffer.alloc(600 * 1024, 1))
    const buf = fs.readFileSync(largePath)
    const result = await shrinkImage(buf)
    expect(result).toBeNull()
  })

  it('preReadImageHandler passes through an undecodable file rather than crashing', async () => {
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

  it('preReadImageHandler passes through the dimension-probe path too (small byte size, would otherwise probe dimensions)', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-nosharp-'))
    const smallPath = path.join(TMP, 'small.png')
    // Well under the byte threshold, so this exercises the dimension-probe branch specifically --
    // it must pass through on bytes it cannot read rather than crash the hook.
    fs.writeFileSync(smallPath, Buffer.alloc(1024, 1))
    const event = makeHookEvent({
      toolName: 'Read',
      toolInput: { file_path: smallPath },
    })
    const result = await preReadImageHandler(event)
    expect(result.hookType).toBe('pass')
  })
})
