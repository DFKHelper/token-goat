import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SHIM_FALLBACK_TIMEOUT_MS } from '../src/bridges/shim_common.js'
import { buildManifest, buildMemEpochSection, MEM_EPOCH_TIMEOUT_MS } from '../src/manifest.js'

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

  // HAND-DERIVED: the launcher spins 1.2 s before printing, longer than the 800 ms the build used to wait. The limit is passed in and is far above that, so a cmd.exe stall on a loaded machine cannot push the answer past it.
  function slowLauncher(): void {
    const body = 'node -e "const u=Date.now()+1200;while(Date.now()<u);console.log(7)"'
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'mem.cmd'), `@echo off\r\n${body}\r\n`)
    else fs.writeFileSync(path.join(dir, 'mem'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    process.env['PATH'] = dir + path.delimiter + (savedPath ?? '')
  }

  it('folds in the epoch from a launcher that takes longer than the old 800 ms cap', () => {
    slowLauncher()
    const section = buildMemEpochSection(60_000)
    expect(section.flatMap((s) => s.header).join('\n')).toContain('mem epoch: 7')
  })

  // The same launcher against a limit it cannot meet: it can only get slower under load, so the section is dropped on any machine speed.
  it('drops the section when the launcher outlasts the limit it is given', () => {
    slowLauncher()
    expect(buildMemEpochSection(300)).toEqual([])
  })

  // CAPTURE: 3 of 20 calls to an echo-only .cmd launcher stalled 729-1043 ms on a loaded Windows machine (2026-10-08, measured while writing this fix). The default must clear the worst of them and stay a small share of the Claude Code shim's whole fallback budget, so the two cannot drift apart unnoticed.
  it('keeps the default limit above the measured stalls and well inside the shim fallback budget', () => {
    expect(MEM_EPOCH_TIMEOUT_MS).toBeGreaterThan(1043)
    expect(MEM_EPOCH_TIMEOUT_MS).toBeLessThanOrEqual(SHIM_FALLBACK_TIMEOUT_MS.claudecode / 4)
  })

  it('omits the section when no mem launcher is on PATH', () => {
    process.env['PATH'] = dir
    expect(buildManifest()).not.toContain('mem epoch:')
  })
})
