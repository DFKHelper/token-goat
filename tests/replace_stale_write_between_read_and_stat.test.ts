// Regression: cmdReplace read the target before taking the pre-write stat, so an external write landing between the read and the stat was baked into the baseline and the stale-write check never saw it; the replace then overwrote that write silently.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdReplace } from '../src/cli_file_ops.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const hook = vi.hoisted(() => ({ target: null as string | null, fired: false }))

// Provenance: HAND-DERIVED the wrapper simulates an external writer by appending to the target immediately after the first read of it returns, which is exactly the window between the read and the stat.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const result = (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    if (hook.target !== null && !hook.fired && p === hook.target) {
      hook.fired = true
      actual.appendFileSync(hook.target, 'EXTERNAL WRITE\n')
    }
    return result
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

let dir: string
let spy: WriteSpy

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-replace-race-'))
  spy = spyOnWrite(process.stdout, [])
  hook.fired = false
})

afterEach(() => {
  hook.target = null
  spy.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('replace stale-write window', () => {
  it('refuses to overwrite a file written externally between the read and the pre-write stat', () => {
    const file = path.join(dir, 'doc.txt')
    fs.writeFileSync(file, 'one two three\n')
    hook.target = file
    const call = (): void => cmdReplace(file, { oldB64: Buffer.from('two').toString('base64'), newB64: Buffer.from('2').toString('base64') })
    expect(call).toThrow(/changed on disk/)
    expect(hook.fired).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('one two three\nEXTERNAL WRITE\n')
  })

  it('still applies the replace when nothing else touches the file', () => {
    const file = path.join(dir, 'doc2.txt')
    fs.writeFileSync(file, 'one two three\n')
    cmdReplace(file, { oldB64: Buffer.from('two').toString('base64'), newB64: Buffer.from('2').toString('base64') })
    expect(fs.readFileSync(file, 'utf8')).toBe('one 2 three\n')
  })
})
