/** A compact project map never renders its recent files, yet buildProjectMap used to stat every walked file (up to MAX_FILES_SCANNED, 20000) to rank them. The subagent briefing builds a compact map on every agent spawn, so that hook paid one stat per project file for a list it threw away: measured on a 20000-file tree at 690 ms cold and 335 ms warm. Provenance: HAND-DERIVED. The fixture writes a known set of files and the expected stat counts follow from that list alone (zero for a compact text map, one per file when the list is kept), not from the implementation. */
import type * as nodeFs from 'node:fs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectMap, formatProjectMap } from '../src/baseline.js'
import { loadConfig } from '../src/config.js'

/** `vi.spyOn(fs, 'statSync')` cannot redefine a property of an ESM namespace, so the stat is counted through a hoisted `vi.mock`, the mechanism tests/mcp_server_pins_the_spelling_the_reader_opens.test.ts uses for the same reason. Only stats of paths under the fixture root count, so the database and config reads the map also performs cannot move the number. */
const statCounter = vi.hoisted(() => ({ root: '', calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()
  const statSync = (...args: Parameters<typeof actual.statSync>): ReturnType<typeof actual.statSync> => {
    if (statCounter.root !== '' && String(args[0]).startsWith(statCounter.root)) statCounter.calls += 1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (actual.statSync as any)(...args)
  }
  return { ...actual, default: { ...actual, statSync }, statSync }
})
vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))

const FILES = ['a.ts', 'b.ts', 'sub/c.py', 'sub/deep/d.go']

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-maprecent-'))
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), 'x\n')
  }
  statCounter.root = root
  statCounter.calls = 0
  vi.mocked(loadConfig).mockReturnValue({
    repomap: { exclude_tests: false, compact_file_threshold: 50 },
    indexing: { skip_dirs: [] },
  } as unknown as ReturnType<typeof loadConfig>)
})

afterEach(() => {
  const root = statCounter.root
  statCounter.root = ''
  fs.rmSync(root, { recursive: true, force: true })
})

describe('buildProjectMap recent files', () => {
  it('stats no project file for a compact map rendered as text', () => {
    const map = buildProjectMap(statCounter.root, { compact: true })

    expect(statCounter.calls).toBe(0)
    expect(map.recentFiles).toEqual([])
    expect(map.fileCount).toBe(FILES.length)
    expect(formatProjectMap(map, map.compact)).not.toContain('## Recent files')
  })

  it('skips the stats when the file count alone switches the map to compact', () => {
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false, compact_file_threshold: 1 },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(statCounter.root)

    expect(map.compact).toBe(true)
    expect(statCounter.calls).toBe(0)
  })

  it('keeps recent files for a compact map the caller prints as JSON', () => {
    const map = buildProjectMap(statCounter.root, { compact: true, emitsJson: true })

    expect(statCounter.calls).toBe(FILES.length)
    expect([...map.recentFiles].sort()).toEqual([...FILES].sort())
  })

  it('keeps recent files for a full map, which renders them', () => {
    const map = buildProjectMap(statCounter.root)

    expect(map.compact).toBe(false)
    expect(statCounter.calls).toBe(FILES.length)
    expect([...map.recentFiles].sort()).toEqual([...FILES].sort())
    expect(formatProjectMap(map, map.compact)).toContain('## Recent files')
  })
})
