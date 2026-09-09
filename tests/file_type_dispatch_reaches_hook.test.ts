/**
 * `dispatchFileTypeHandler` routes `.svg` and `.xml` to handlers with their own thresholds
 * (8 KB and 20 KB), but the read hook only calls that dispatcher when the extension is in
 * `TEXT_FILE_TYPE_EXTS` or the file is already past the 100 KB generic gate. An extension the
 * dispatcher knows and that list does not is a handler whose threshold can never be reached:
 * the advisory is dead below 100 KB, and at 100 KB the generic gate would have fired anyway.
 *
 * Every other test for these handlers calls `handleSvg` or `dispatchFileTypeHandler` directly,
 * which is precisely why this shipped green. The direct call supplies the routing the real path
 * omits, so the suite proves the handler works and says nothing about whether anything invokes
 * it. These tests go through `preReadHandler` for that reason and must not be rewritten to call
 * the dispatcher: the dispatcher is not the part that was broken.
 *
 * Sizes here sit deliberately between each handler's own threshold and the 100 KB generic gate,
 * so a regression that drops the extension from the list fails here rather than passing on the
 * generic catch-all.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { preReadHandler } from '../src/hooks_read.js'
import { FILE_TYPE_THRESHOLDS } from '../src/hints/file_type_handler.js'
import { makeHookEvent } from './helpers/hook-event.js'

let base = ''

// PROVENANCE: HAND-DERIVED. The bodies are built here from each format's own syntax and padded
// to a size chosen from FILE_TYPE_THRESHOLDS, independently of any matcher in the code under
// test. The strings asserted below are read off the handlers' own message text in
// src/hints/file_type_handler.ts (FORMAT-DERIVED), which is sound for this test because the
// claim being pinned is reachability, not wording: the handler is known to produce them, and
// what was broken is whether anything ever calls it.
function writeSvg(name: string, bytes: number): string {
  const head = '<svg xmlns="http://www.w3.org/2000/svg">\n<title>Architecture</title>\n<g id="layer1"><path d="M 0 0 L 10 10"/></g>\n'
  const tail = '\n</svg>\n'
  const pad = `<path d="${'M 0 0 L 9 9 '.repeat(Math.ceil(bytes / 12))}"/>`
  const file = path.join(base, name)
  fs.writeFileSync(file, head + pad + tail)
  return file
}

function writeXml(name: string, bytes: number): string {
  const head = '<?xml version="1.0"?>\n<root>\n'
  const tail = '</root>\n'
  const pad = `  <item name="padding">${'x'.repeat(bytes)}</item>\n`
  const file = path.join(base, name)
  fs.writeFileSync(file, head + pad + tail)
  return file
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ft-dispatch-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('the read hook reaches every extension the file-type dispatcher routes', () => {
  it('intercepts an SVG above the SVG threshold and well below the generic gate', () => {
    const file = writeSvg('diagram.svg', FILE_TYPE_THRESHOLDS.svg * 2)
    const size = fs.statSync(file).size
    // The window this test exists to cover: past the handler's own bar, nowhere near the
    // catch-all that would mask a missing route.
    expect(size).toBeGreaterThan(FILE_TYPE_THRESHOLDS.svg)
    expect(size).toBeLessThan(FILE_TYPE_THRESHOLDS.generic)

    const result = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: 'svg-reach' }))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('xml-outline')
    }
  })

  it('intercepts an XML file above the XML threshold and well below the generic gate', () => {
    const file = writeXml('data.xml', FILE_TYPE_THRESHOLDS.xml * 2)
    const size = fs.statSync(file).size
    expect(size).toBeGreaterThan(FILE_TYPE_THRESHOLDS.xml)
    expect(size).toBeLessThan(FILE_TYPE_THRESHOLDS.generic)

    const result = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: 'xml-reach' }))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('xml-outline')
    }
  })

  it('leaves an SVG under its own threshold alone, so the interception is the threshold and not the extension', () => {
    const file = writeSvg('small.svg', 200)
    expect(fs.statSync(file).size).toBeLessThan(FILE_TYPE_THRESHOLDS.svg)

    const result = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: 'svg-small' }))

    expect(result.hookType).not.toBe('deny')
  })
})
