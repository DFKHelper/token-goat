import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { stripNotebook, getOrCreateSidecar, pruneSidecars, NB_STRIP_MIN_SAVINGS } from '../src/notebook_compact.js'

describe('stripNotebook', () => {
  it('clears outputs from code cells', () => {
    const nb = {
      cells: [
        {
          cell_type: 'code',
          source: ['print("hello")'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['hello\n'] }],
          execution_count: 5,
        },
      ],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped.cells).toHaveLength(1)
    expect(stripped.cells?.[0]).toMatchObject({
      cell_type: 'code',
      source: ['print("hello")'],
      outputs: [],
      execution_count: null,
    })
  })

  it('preserves markdown cells untouched', () => {
    const nb = {
      cells: [
        {
          cell_type: 'markdown',
          source: ['# Title'],
          metadata: {},
        },
      ],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped.cells).toHaveLength(1)
    expect(stripped.cells?.[0]).toMatchObject({
      cell_type: 'markdown',
      source: ['# Title'],
    })
  })

  it('preserves raw cells untouched', () => {
    const nb = {
      cells: [
        {
          cell_type: 'raw',
          source: ['raw content'],
          metadata: {},
        },
      ],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped.cells).toHaveLength(1)
    expect(stripped.cells?.[0]?.cell_type).toBe('raw')
  })

  it('handles mixed cell types', () => {
    const nb = {
      cells: [
        {
          cell_type: 'markdown',
          source: ['# Header'],
        },
        {
          cell_type: 'code',
          source: ['x = 1'],
          outputs: [{ text: 'output' }],
          execution_count: 1,
        },
        {
          cell_type: 'raw',
          source: ['raw'],
        },
      ],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped.cells).toHaveLength(3)
    expect(stripped.cells?.[0]?.cell_type).toBe('markdown')
    expect(stripped.cells?.[1]?.outputs).toEqual([])
    expect(stripped.cells?.[1]?.execution_count).toBeNull()
    expect(stripped.cells?.[2]?.cell_type).toBe('raw')
  })

  it('preserves other cell fields', () => {
    const nb = {
      cells: [
        {
          cell_type: 'code',
          source: ['code'],
          metadata: { collapsed: true },
          outputs: [{ output_type: 'stream' }],
          execution_count: 3,
          custom_field: 'preserved',
        },
      ],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped.cells?.[0]).toHaveProperty('metadata')
    expect(stripped.cells?.[0]).toHaveProperty('custom_field', 'preserved')
  })

  it('handles empty notebook', () => {
    const nb = { cells: [] }
    const stripped = stripNotebook(nb)
    expect(stripped.cells).toEqual([])
  })

  it('handles notebook without cells key', () => {
    const nb = { metadata: {} }
    const stripped = stripNotebook(nb)
    expect(stripped.cells).toEqual([])
  })

  it('preserves top-level notebook fields', () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3' } },
      cells: [{ cell_type: 'code', outputs: [{ text: 'out' }], execution_count: 1 }],
    }
    const stripped = stripNotebook(nb as never)
    expect(stripped).toHaveProperty('nbformat', 4)
    expect(stripped).toHaveProperty('metadata')
    expect(stripped).toHaveProperty('cells')
  })
})

describe('getOrCreateSidecar', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates sidecar on first call', () => {
    const content = JSON.stringify({
      nbformat: 4,
      cells: [
        {
          cell_type: 'code',
          outputs: [{ text: 'output' }],
          execution_count: 1,
        },
      ],
    })
    const bytes = Buffer.from(content)

    const [sidecarPath, created] = getOrCreateSidecar(bytes, tempDir)

    expect(created).toBe(true)
    expect(fs.existsSync(sidecarPath)).toBe(true)
    const strippedContent = fs.readFileSync(sidecarPath, 'utf-8')
    const stripped = JSON.parse(strippedContent)
    expect(stripped.cells[0].outputs).toEqual([])
    expect(stripped.cells[0].execution_count).toBeNull()
  })

  it('reuses sidecar for identical content (same SHA)', () => {
    const content = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', outputs: [{ text: 'out' }], execution_count: 1 }],
    })
    const bytes = Buffer.from(content)

    const [path1, created1] = getOrCreateSidecar(bytes, tempDir)
    const [path2, created2] = getOrCreateSidecar(bytes, tempDir)

    expect(created1).toBe(true)
    expect(created2).toBe(false)
    expect(path1).toBe(path2)
  })

  it('creates different sidecars for different content', () => {
    const content1 = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', outputs: [], execution_count: 1 }],
    })
    const content2 = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', outputs: [], execution_count: 2 }],
    })

    const [path1] = getOrCreateSidecar(Buffer.from(content1), tempDir)
    const [path2] = getOrCreateSidecar(Buffer.from(content2), tempDir)

    expect(path1).not.toBe(path2)
    expect(fs.existsSync(path1)).toBe(true)
    expect(fs.existsSync(path2)).toBe(true)
  })

  it('throws on invalid JSON', () => {
    const bytes = Buffer.from('not valid json')
    expect(() => getOrCreateSidecar(bytes, tempDir)).toThrow('Failed to parse notebook JSON')
  })

  it('throws on non-notebook dict', () => {
    const bytes = Buffer.from(JSON.stringify({ some: 'object' }))
    expect(() => getOrCreateSidecar(bytes, tempDir)).toThrow('Not a notebook')
  })

  it('throws on dict with no cells key', () => {
    const bytes = Buffer.from(JSON.stringify({ nbformat: 4 }))
    expect(() => getOrCreateSidecar(bytes, tempDir)).toThrow('Not a notebook')
  })

  it('creates sidecar in correct directory structure', () => {
    const content = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', outputs: [{ text: 'out' }] }],
    })
    const bytes = Buffer.from(content)

    const [sidecarPath] = getOrCreateSidecar(bytes, tempDir)

    expect(sidecarPath).toContain('nb_strip')
    expect(sidecarPath).toMatch(/[a-f0-9]{64}/)
    expect(sidecarPath).toContain('stripped.ipynb')
    const dir = path.dirname(sidecarPath)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('exports NB_STRIP_MIN_SAVINGS constant', () => {
    expect(typeof NB_STRIP_MIN_SAVINGS).toBe('number')
    expect(NB_STRIP_MIN_SAVINGS).toBeGreaterThan(0)
  })

  it('strips multiple cells correctly', () => {
    const content = JSON.stringify({
      nbformat: 4,
      cells: [
        { cell_type: 'markdown', source: ['# Title'] },
        { cell_type: 'code', outputs: [{ text: 'out1' }], execution_count: 1 },
        { cell_type: 'code', outputs: [{ text: 'out2' }], execution_count: 2 },
        { cell_type: 'raw', source: ['raw'] },
      ],
    })
    const bytes = Buffer.from(content)

    const [sidecarPath] = getOrCreateSidecar(bytes, tempDir)
    const strippedContent = fs.readFileSync(sidecarPath, 'utf-8')
    const stripped = JSON.parse(strippedContent)

    expect(stripped.cells).toHaveLength(4)
    expect(stripped.cells[1].outputs).toEqual([])
    expect(stripped.cells[2].outputs).toEqual([])
    expect(stripped.cells[0].cell_type).toBe('markdown')
    expect(stripped.cells[3].cell_type).toBe('raw')
  })

  it('preserves metadata and other notebook fields', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 2,
      metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
      cells: [{ cell_type: 'code', outputs: [{ text: 'out' }] }],
    })
    const bytes = Buffer.from(content)

    const [sidecarPath] = getOrCreateSidecar(bytes, tempDir)
    const strippedContent = fs.readFileSync(sidecarPath, 'utf-8')
    const stripped = JSON.parse(strippedContent)

    expect(stripped.nbformat).toBe(4)
    expect(stripped.nbformat_minor).toBe(2)
    expect(stripped.metadata).toBeDefined()
    expect(stripped.metadata.kernelspec.name).toBe('python3')
  })
})

describe('pruneSidecars', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-prune-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('evicts the least-recently-modified sidecars beyond maxCount (fail-on-buggy: unbounded accumulation with no pruning)', () => {
    const dirs: string[] = []
    for (let i = 0; i < 5; i++) {
      const content = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', outputs: [], execution_count: i }] })
      const [sidecarPath] = getOrCreateSidecar(Buffer.from(content), tempDir, { maxCount: 1000 })
      const dir = path.dirname(sidecarPath)
      const t = new Date(Date.now() - (5 - i) * 60_000)
      fs.utimesSync(dir, t, t)
      dirs.push(dir)
    }

    pruneSidecars(tempDir, 2, 24 * 3600 * 1000)

    const nbStripDir = path.join(tempDir, 'nb_strip')
    const remaining = fs.readdirSync(nbStripDir)
    expect(remaining).toHaveLength(2)
    expect(fs.existsSync(dirs[3]!)).toBe(true)
    expect(fs.existsSync(dirs[4]!)).toBe(true)
    expect(fs.existsSync(dirs[0]!)).toBe(false)
  })

  it('drops sidecars older than maxAgeMs', () => {
    const content1 = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', outputs: [], execution_count: 1 }] })
    const content2 = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', outputs: [], execution_count: 2 }] })
    const [path1] = getOrCreateSidecar(Buffer.from(content1), tempDir, { maxCount: 1000 })
    const [path2] = getOrCreateSidecar(Buffer.from(content2), tempDir, { maxCount: 1000 })
    const dir1 = path.dirname(path1)
    const past = new Date(Date.now() - 48 * 3600 * 1000)
    fs.utimesSync(dir1, past, past)

    const removed = pruneSidecars(tempDir, 1000, 24 * 3600 * 1000)

    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(dir1)).toBe(false)
    expect(fs.existsSync(path2)).toBe(true)
  })

  it('getOrCreateSidecar wires opts through to pruning after each write (fail-on-buggy: unbounded growth when opts is ignored)', () => {
    for (let i = 0; i < 5; i++) {
      const content = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', outputs: [], execution_count: i }] })
      getOrCreateSidecar(Buffer.from(content), tempDir, { maxCount: 2, maxAgeMs: 24 * 3600 * 1000 })
    }
    const nbStripDir = path.join(tempDir, 'nb_strip')
    const remaining = fs.readdirSync(nbStripDir)
    expect(remaining.length).toBeLessThanOrEqual(2)
  })

  it('returns 0 for a cache root with no nb_strip directory', () => {
    expect(pruneSidecars(tempDir, 10, 1000)).toBe(0)
  })
})
