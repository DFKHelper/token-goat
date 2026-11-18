/** writePregenIndex: the whole pregen.json, owner-only. HAND-DERIVED: expected text written out here. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writePregenIndex } from '../src/cli_install.js'

const WIN = process.platform === 'win32'
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pregen-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(1700000000000))
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writePregenIndex', () => {
  it('writes the whole list and leaves no temp file beside pregen.json', () => {
    writePregenIndex(dir, ['alpha', 'beta'])

    const expected = '{\n  "ts": 1700000000000,\n  "names": [\n    "alpha",\n    "beta"\n  ]\n}'
    expect(fs.readFileSync(path.join(dir, 'pregen.json'), 'utf8')).toBe(expected)
    expect(fs.readdirSync(dir)).toEqual(['pregen.json'])
  })

  it('creates a missing output directory first', () => {
    const nested = path.join(dir, 'skill-outputs')
    writePregenIndex(nested, ['alpha'])

    const parsed = JSON.parse(fs.readFileSync(path.join(nested, 'pregen.json'), 'utf8'))
    expect(parsed).toEqual({ ts: 1700000000000, names: ['alpha'] })
  })

  it.skipIf(WIN)('writes pregen.json owner-only (POSIX mode 0600)', () => {
    writePregenIndex(dir, ['alpha'])

    expect(fs.statSync(path.join(dir, 'pregen.json')).mode & 0o777).toBe(0o600)
  })
})
