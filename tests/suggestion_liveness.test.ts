/** A miss used to offer whatever the index last saw: `symbol widgetAlphaRendr` suggested widgetAlphaRender after the file renamed it outside the index, `symbol gadgetBetaRendr` suggested a function whose file had been deleted, and `read src/b.ts::gadgetBetaRender` pointed at that deleted file. Following any of them ended in a second "No matches". Each suggestion is now checked against disk first: stale files are reindexed and the answer re-read, and rows whose file is gone are dropped. Fixture provenance: HAND-DERIVED. The sources are written here, each name is chosen to sit within (or outside) rankSimilarNames's two-edit budget for its query by counting edits by hand, and the expected suggestions follow from which files the test edits or deletes after indexing, independently of the code under test. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { formatBareNameSpecError, formatCrossFileLead, nearSymbolNames } from '../src/read_suggest.js'
import { runSymbol } from '../src/read_symbol.js'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function write(rel: string, text: string): string {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function fn(name: string): string {
  return `export function ${name}(): number {\n  return 1\n}\n`
}

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-live-suggest-')))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  // Indexed as written here, then changed behind the index's back below.
  const files = [
    write('src/a.ts', fn('widgetAlphaRender')),
    write('src/gone.ts', fn('gadgetBetaRender')),
    write('src/draw.ts', fn('widgetGammaDraw')),
    write('src/live.ts', fn('liveHelperName')),
    write('src/twin_live.ts', fn('sharedTwin')),
    write('src/twin_gone.ts', fn('sharedTwin')),
    write('src/b.ts', 'export const x = 1\n'),
  ]
  for (const f of files) indexFileSync(f)
  write('src/a.ts', fn('widgetAlphaPaint'))
  write('src/draw.ts', fn('widgetGammaDraws'))
  fs.rmSync(path.join(root, 'src/gone.ts'))
  fs.rmSync(path.join(root, 'src/twin_gone.ts'))
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('near-name suggestions are checked against disk', () => {
  it('drops a name the file has since renamed', () => {
    expect(nearSymbolNames('widgetAlphaRendr', root)).toEqual({ skipped: false, candidates: [] })
  })

  it('drops a name whose only file is deleted', () => {
    expect(nearSymbolNames('gadgetBetaRendr', root)).toEqual({ skipped: false, candidates: [] })
  })

  it('offers the name the edited file holds now, once the stale file is reindexed', () => {
    // widgetGammaDrw is one edit from the stale widgetGammaDraw and two from the current widgetGammaDraws.
    expect(nearSymbolNames('widgetGammaDrw', root)).toEqual({ skipped: false, candidates: ['widgetGammaDraws'] })
  })

  it('keeps a name that a deleted file and a live file both define', () => {
    expect(nearSymbolNames('sharedTwn', root)).toEqual({ skipped: false, candidates: ['sharedTwin'] })
  })

  it('keeps a name in a fresh file unchanged', () => {
    expect(nearSymbolNames('liveHelperNam', root)).toEqual({ skipped: false, candidates: ['liveHelperName'] })
  })

  it('reaches the symbol command: no "Did you mean" for a deleted file', () => {
    const r = runSymbol({ name: 'gadgetBetaRendr', projectRoot: root })
    expect(r.code).toBe(1)
    expect(r.text).not.toContain('gadgetBetaRender')
  })
})

describe('cross-file leads are checked against disk', () => {
  it('names no deleted file', () => {
    expect(formatCrossFileLead('read', 'gadgetBetaRender', 'src/b.ts', root)).toBe('')
  })

  it('names no file that no longer defines the name', () => {
    expect(formatCrossFileLead('read', 'widgetAlphaRender', 'src/b.ts', root)).toBe('')
  })

  it('names only the live file of a name a deleted file also defined', () => {
    expect(formatCrossFileLead('read', 'sharedTwin', 'src/b.ts', root)).toBe(`'sharedTwin' is defined in src/twin_live.ts\n  - token-goat read "src/twin_live.ts::sharedTwin"`)
  })

  it('still leads to a live file', () => {
    expect(formatCrossFileLead('read', 'liveHelperName', 'src/b.ts', root)).toBe(`'liveHelperName' is defined in src/live.ts\n  - token-goat read "src/live.ts::liveHelperName"`)
  })
})

describe('bare-name spec suggestions are checked against disk', () => {
  it('suggests no spec in a deleted file', () => {
    expect(formatBareNameSpecError('read', 'gadgetBetaRender', root)).toBe('Invalid spec - expected "file::symbol", got: gadgetBetaRender')
  })

  it('suggests no spec the file no longer holds', () => {
    expect(formatBareNameSpecError('brief', 'widgetAlphaRender', root)).toBe('Invalid spec - expected "file::symbol", got: widgetAlphaRender')
  })

  it('suggests only the live spec of a name a deleted file also defined', () => {
    expect(formatBareNameSpecError('read', 'sharedTwin', root)).toBe(`Not a file: 'sharedTwin'. Did you mean:\n  - token-goat read "src/twin_live.ts::sharedTwin"`)
  })
})
