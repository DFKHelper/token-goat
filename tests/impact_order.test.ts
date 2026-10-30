// Provenance: HAND-DERIVED. The call graphs below are written by hand from the ordering rule under test (same hop, cross-file callers before same-file callers); no external tool emits them.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runImpact } from '../src/graph_commands.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'

// More same-file hop-1 callers than the default --top (20), so the alphabetical order alone would push a late-named caller out of the printed set.
const SAME_FILE_CALLERS = 22

interface ImpactRow {
  symbol: string
  hops: number
}

afterEach(() => {
  vi.restoreAllMocks()
})

function sameFileName(tag: string, index: number): string {
  return `${tag}Same${String(index).padStart(2, '0')}`
}

// Builds a real indexed scratch project: a target, SAME_FILE_CALLERS callers in the target's file, and a cross-file caller named to sort last.
function buildProject(tag: string, withHopTwo: boolean): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `tg-impact-order-${tag.toLowerCase()}-`))
  const defFile = join(root, `${tag}-def.ts`)
  const crossFile = join(root, `${tag}-cross.ts`)
  const hopTwoFile = join(root, `${tag}-hop2.ts`)
  const defLines = [`export function ${tag}Target() { return 1 }`]
  for (let i = 0; i < SAME_FILE_CALLERS; i += 1) {
    defLines.push(`function ${sameFileName(tag, i)}() { return ${tag}Target() }`)
  }
  writeFileSync(defFile, `${defLines.join('\n')}\n`)
  writeFileSync(crossFile, `function zz${tag}Cross() { return ${tag}Target() }\n`)
  indexFileSync(normalizePath(defFile))
  indexFileSync(normalizePath(crossFile))
  if (withHopTwo) {
    writeFileSync(hopTwoFile, `function ${tag}HopTwo() { return zz${tag}Cross() }\n`)
    indexFileSync(normalizePath(hopTwoFile))
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

// Runs the real runImpact CLI path with the scratch project as the working directory and returns the printed rows in order.
function runImpactRows(root: string, symbol: string, top?: number): string[] {
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  try {
    const out = captureStdout(() => {
      const code = top === undefined ? runImpact({ symbol, json: true }) : runImpact({ symbol, json: true, top })
      expect(code).toBe(0)
    })
    return (JSON.parse(out) as ImpactRow[]).map((row) => row.symbol)
  } finally {
    cwdSpy.mockRestore()
  }
}

describe('runImpact cross-file callers first within a hop', () => {
  it('keeps the cross-file caller inside the default --top', () => {
    const project = buildProject('OrdA', false)
    try {
      const printed = runImpactRows(project.root, 'OrdATarget')
      expect(printed).toHaveLength(20)
      expect(printed).toContain('zzOrdACross')
      expect(printed[0]).toBe('zzOrdACross')
    } finally {
      project.dispose()
    }
  })

  it('never lets a cross-file hop-2 caller jump a hop-1 caller', () => {
    const project = buildProject('OrdB', true)
    try {
      const printed = runImpactRows(project.root, 'OrdBTarget', 30)
      const hopTwoIndex = printed.indexOf('OrdBHopTwo')
      expect(hopTwoIndex).toBe(printed.length - 1)
      expect(printed.indexOf('zzOrdBCross')).toBeLessThan(hopTwoIndex)
      for (let i = 0; i < SAME_FILE_CALLERS; i += 1) {
        expect(printed.indexOf(sameFileName('OrdB', i))).toBeLessThan(hopTwoIndex)
      }
    } finally {
      project.dispose()
    }
  })
})

describe('compareImpactHops ordering rule', () => {
  const defFile = '/scratch/def.ts'
  const otherFile = '/scratch/other.ts'

  it('puts a same-hop cross-file caller before a same-hop same-file caller', async () => {
    const { compareImpactHops } = await import('../src/impact_order.js')
    const cross = { key: 'other|x', name: 'zCross', hop: 1, filePath: otherFile }
    const local = { key: 'def||aLocal|3', name: 'aLocal', hop: 1, filePath: defFile }
    expect(Math.sign(compareImpactHops({ left: cross, right: local, rootFilePaths: [defFile] }))).toBe(-1)
    expect(Math.sign(compareImpactHops({ left: local, right: cross, rootFilePaths: [defFile] }))).toBe(1)
  })

  it('never lets a cross-file hop-2 entry jump a same-file hop-1 entry', async () => {
    const { compareImpactHops } = await import('../src/impact_order.js')
    const crossHopTwo = { key: 'other|y', name: 'aCrossHopTwo', hop: 2, filePath: otherFile }
    const localHopOne = { key: 'def||zLocal|9', name: 'zLocal', hop: 1, filePath: defFile }
    expect(Math.sign(compareImpactHops({ left: crossHopTwo, right: localHopOne, rootFilePaths: [defFile] }))).toBe(1)
  })

  it('keeps the previous name and key order for ties inside one hop and one locality', async () => {
    const { compareImpactHops } = await import('../src/impact_order.js')
    const bName = { key: 'def||bName|5', name: 'bName', hop: 1, filePath: defFile }
    const aName = { key: 'def||aName|7', name: 'aName', hop: 1, filePath: defFile }
    expect(Math.sign(compareImpactHops({ left: aName, right: bName, rootFilePaths: [defFile] }))).toBe(-1)
    const sameNameLow = { key: 'def||dup|1', name: 'dup', hop: 1, filePath: defFile }
    const sameNameHigh = { key: 'def||dup|2', name: 'dup', hop: 1, filePath: defFile }
    expect(Math.sign(compareImpactHops({ left: sameNameLow, right: sameNameHigh, rootFilePaths: [defFile] }))).toBe(-1)
    const crossA = { key: 'other|a', name: 'same', hop: 1, filePath: otherFile }
    const crossB = { key: 'other|b', name: 'same', hop: 1, filePath: otherFile }
    expect(Math.sign(compareImpactHops({ left: crossA, right: crossB, rootFilePaths: [defFile] }))).toBe(-1)
  })
})
