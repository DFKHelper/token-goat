import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildManifest } from '../src/manifest.js'

// Provenance: HAND-DERIVED. The shim is a stand-in for the npm/cargo-installed `mem` launcher, which is a `.cmd` file on Windows (Node's spawnSync cannot run those without cmd.exe) and an executable script elsewhere; the printed 7 is an arbitrary epoch. No child_process mock: this exercises the real PATH resolution.
describe('buildManifest mem epoch section with a real PATH shim', () => {
  let dir: string
  let savedPath: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-shim-'))
    savedPath = process.env['PATH']
  })

  afterEach(() => {
    if (savedPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = savedPath
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('folds in the epoch printed by a mem launcher that is a .cmd shim on Windows', () => {
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'mem.cmd'), '@echo off\r\necho 7\r\n')
    else fs.writeFileSync(path.join(dir, 'mem'), '#!/bin/sh\necho 7\n', { mode: 0o755 })
    process.env['PATH'] = dir + path.delimiter + (savedPath ?? '')
    const manifest = buildManifest()
    expect(manifest).toContain('mem epoch: 7')
  })

  it('omits the section when no mem launcher is on PATH', () => {
    process.env['PATH'] = dir
    expect(buildManifest()).not.toContain('mem epoch:')
  })
})
