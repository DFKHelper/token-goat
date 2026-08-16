import * as os from 'node:os'
import * as path from 'node:path'
import type * as fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Two stage (a) crash-recovery defects in drainOnce, both of which silently lose queued paths.
// Injecting a filesystem failure needs a module mock with hoisted flags: node:fs namespace
// exports are non-configurable, so vi.spyOn cannot patch them (same reason as parser_read_failure_swallow.test.ts).
const mockState = vi.hoisted(() => ({
  readFailTarget: '',
  readFailuresRemaining: 0,
  readFailCount: 0,
  failCleanupFor: '',
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const readFileSync = (target: fs.PathOrFileDescriptor, options?: unknown): string | Buffer => {
    if (typeof target === 'string' && target === mockState.readFailTarget && mockState.readFailuresRemaining > 0) {
      mockState.readFailuresRemaining -= 1
      mockState.readFailCount += 1
      throw Object.assign(new Error('simulated EBUSY failure'), { code: 'EBUSY' })
    }
    return actual.readFileSync(target, options as never)
  }
  const rmSync = (target: fs.PathLike, options?: fs.RmOptions): void => {
    if (typeof target === 'string' && target === mockState.failCleanupFor) {
      throw Object.assign(new Error('simulated EBUSY failure'), { code: 'EBUSY' })
    }
    actual.rmSync(target, options)
  }
  const renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    if (typeof from === 'string' && from === mockState.failCleanupFor) {
      throw Object.assign(new Error('simulated EBUSY failure'), { code: 'EBUSY' })
    }
    actual.renameSync(from, to)
  }
  return { ...actual, default: actual, readFileSync, rmSync, renameSync }
})

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))

const realFs = await vi.importActual<typeof fs>('node:fs')
const { loadConfig } = await import('../src/config.js')
const { closeDb } = await import('../src/db.js')
const { drainOnce } = await import('../src/worker.js')

describe('drainOnce stage (a) crash recovery', () => {
  let DIR: string
  let queuePath: string
  let drainingPath: string

  beforeEach(() => {
    DIR = realFs.mkdtempSync(path.join(os.tmpdir(), 'tg-drain-'))
    queuePath = path.join(DIR, 'queue', 'dirty.txt')
    drainingPath = `${queuePath}.draining`
    realFs.mkdirSync(path.dirname(drainingPath), { recursive: true })
    mockState.readFailTarget = ''
    mockState.readFailuresRemaining = 0
    mockState.readFailCount = 0
    mockState.failCleanupFor = ''
    // Permissive config so this fixture-sized content never trips indexFileSync's size or skip gates.
    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [] },
      indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  afterEach(() => {
    mockState.readFailTarget = ''
    mockState.readFailuresRemaining = 0
    mockState.failCleanupFor = ''
    // The retry-count helpers open a connection to DIR/global.db as a side effect, and a live WAL handle makes rmSync fail with EPERM on Windows.
    closeDb(path.join(DIR, 'global.db'))
    realFs.rmSync(DIR, { recursive: true, force: true })
  })

  function quarantineFiles(): string[] {
    return realFs.readdirSync(path.dirname(drainingPath)).filter((f) => f.includes('.corrupt-'))
  }

  it('retries a transiently unreadable .draining file instead of quarantining its paths forever', () => {
    // Regression: stage (a) quarantined on the FIRST read failure, and a `.corrupt-` file is excluded from listDrainingFiles permanently, then deleted by cleanupWorkerStateFiles after 30 days -- so every path it named was silently never reindexed. A read failure is not proof of corruption: on Windows an antivirus scan or another process holding the file open fails the read while a rename still succeeds, which is exactly this case.
    const target = path.join(DIR, 'transient.ts')
    realFs.writeFileSync(target, 'export const c = 3\n')
    realFs.writeFileSync(drainingPath, `${target}\n`)
    mockState.readFailTarget = drainingPath
    mockState.readFailuresRemaining = 2

    const indexed: string[] = []
    drainOnce(DIR, (p) => {
      indexed.push(p)
    })

    expect(mockState.readFailCount).toBe(2)
    expect(indexed).toContain(target)
    expect(quarantineFiles()).toEqual([])
    expect(realFs.existsSync(drainingPath)).toBe(false)
  })

  it('still quarantines a .draining file that stays unreadable through every retry', () => {
    // The retry must not turn a genuinely unreadable file into an infinite loop: once the budget is spent the old quarantine behaviour still applies.
    const target = path.join(DIR, 'permanent.ts')
    realFs.writeFileSync(target, 'export const c = 3\n')
    realFs.writeFileSync(drainingPath, `${target}\n`)
    mockState.readFailTarget = drainingPath
    mockState.readFailuresRemaining = Number.MAX_SAFE_INTEGER

    const indexed: string[] = []
    drainOnce(DIR, (p) => {
      indexed.push(p)
    })

    expect(indexed).toEqual([])
    expect(quarantineFiles()).toHaveLength(1)
    expect(realFs.existsSync(drainingPath)).toBe(false)
  })

  it('does not skip a different draining file that happens to hold byte-identical content', () => {
    // Regression: the already-folded guard compared content alone, so a stale snapshot matched a DIFFERENT file reusing the same `.draining` name with identical bytes, and stage (a) skipped a batch nobody had processed. Identical content is the common case, not a rare one: re-editing the same source file queues the same path again. The snapshot now carries the file's mtime, size and inode, which a recreated file does not share.
    const target = path.join(DIR, 'stale.ts')
    realFs.writeFileSync(target, 'export const c = 3\n')
    const content = `${target}\n`

    // First cycle: both cleanup attempts fail, so a snapshot is recorded against this path.
    realFs.writeFileSync(drainingPath, content)
    mockState.failCleanupFor = drainingPath
    const firstPass: string[] = []
    drainOnce(DIR, (p) => {
      firstPass.push(p)
    })
    expect(firstPass).toContain(target)
    expect(realFs.existsSync(drainingPath)).toBe(true)

    // The file then disappears by some other means, leaving the snapshot behind.
    mockState.failCleanupFor = ''
    realFs.rmSync(drainingPath, { force: true })

    // Second cycle: the same name reappears with byte-identical content, a genuinely new batch.
    realFs.writeFileSync(drainingPath, content)
    const secondPass: string[] = []
    drainOnce(DIR, (p) => {
      secondPass.push(p)
    })

    expect(secondPass).toContain(target)
    expect(realFs.existsSync(drainingPath)).toBe(false)
  })

  it('does not reprocess a stuck draining file whose content is unchanged', () => {
    // The guard the eviction must not break: while the file is still there with the same content, its batch is folded in once and not repeated every cycle.
    const target = path.join(DIR, 'stuck.ts')
    realFs.writeFileSync(target, 'export const c = 3\n')
    realFs.writeFileSync(drainingPath, `${target}\n`)
    mockState.failCleanupFor = drainingPath

    const first: string[] = []
    drainOnce(DIR, (p) => {
      first.push(p)
    })
    const second: string[] = []
    drainOnce(DIR, (p) => {
      second.push(p)
    })

    expect(first).toContain(target)
    expect(second).toEqual([])
  })
})
