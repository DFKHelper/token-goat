import type * as ChildProcessModule from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ listing: '', ended: [] as number[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const answering = ((file: string, ...rest: unknown[]) => {
    if (file.toLowerCase().endsWith('taskkill.exe')) {
      stub.ended.push(Number((rest[0] as string[])[3]))
      return { status: 0, signal: null, output: [], pid: 0, stdout: '', stderr: '' }
    }
    return { status: 0, signal: null, output: [], pid: 0, stdout: stub.listing, stderr: '' }
  }) as unknown as typeof real.spawnSync
  return { ...real, spawnSync: answering }
})

const { killChildrenOfExitedRoot } = await import('../src/process_tree.js')

const ROOT = 500
const SPAWNED = 1_000_000
const EXITED = 1_010_000

afterEach(() => {
  stub.listing = ''
  stub.ended = []
})

// The Windows branch ends children through taskkill, so the rows run only where that is the real call.
describe.skipIf(process.platform !== 'win32')(
  'killChildrenOfExitedRoot only ends children created in its own window',
  () => {
  it('a child created just before the spawn is left alone', () => {
    stub.listing = `601 ${ROOT} ${SPAWNED - 1}\n602 ${ROOT} ${SPAWNED - 1500}\n`
    killChildrenOfExitedRoot(ROOT, SPAWNED, EXITED)
    expect(stub.ended, 'a child older than the spawn was ended').toEqual([])
  })

  it('a row whose creation time is not a number is left alone', () => {
    stub.listing = `603 ${ROOT} NaN\n604 ${ROOT} abc\n605 ${ROOT} Infinity\n`
    killChildrenOfExitedRoot(ROOT, SPAWNED, EXITED)
    expect(stub.ended, 'a row with no usable creation time was ended').toEqual([])
  })

  it('a child created inside the window is still ended', () => {
    stub.listing = `606 ${ROOT} ${SPAWNED}\n607 ${ROOT} ${SPAWNED + 500}\n608 ${ROOT} ${EXITED}\n`
    killChildrenOfExitedRoot(ROOT, SPAWNED, EXITED)
    expect(stub.ended, 'a child inside the window was not ended').toEqual([606, 607, 608])
  })

  it('a child created after the shell exited, or of another parent, is left alone', () => {
    stub.listing = `609 ${ROOT} ${EXITED + 1}\n610 ${ROOT + 1} ${SPAWNED + 5}\n`
    killChildrenOfExitedRoot(ROOT, SPAWNED, EXITED)
    expect(stub.ended, 'a child outside the window or of another parent was ended').toEqual([])
  })
})
