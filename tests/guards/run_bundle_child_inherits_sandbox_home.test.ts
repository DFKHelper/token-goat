/** A bundle child spawned with no env inherits the sandboxed HOME and USERPROFILE from tests/setup/isolate-home.ts, never the developer's real home that the setup stashes as TG_REAL_HOME and TG_REAL_USERPROFILE. Provenance: HAND-DERIVED from tests/helpers/bundle.ts (runBundle passes env: undefined, which Node resolves to the parent's process.env) and tests/setup/isolate-home.ts (process.env.HOME and USERPROFILE assigned the sandbox). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runBundle } from '../helpers/bundle.js'

const PAIRS = [
  ['HOME', 'TG_REAL_HOME'],
  ['USERPROFILE', 'TG_REAL_USERPROFILE'],
] as const

describe('runBundle with no env hands the child the sandboxed home', () => {
  it('runs the bundle under the inherited env and the child sees the sandboxed home, not the real one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bundle-home-'))
    // A preload that records the child's own home variables, so the assertion reads what the spawned child received, not the parent's env.
    const probe = path.join(dir, 'probe.cjs')
    const seenFile = path.join(dir, 'seen.json')
    fs.writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }))\n`)
    const savedNodeOptions = process.env.NODE_OPTIONS
    try {
      process.env.NODE_OPTIONS = `${savedNodeOptions ?? ''} --require ${path.resolve(probe).replace(/\\/g, '/')}`.trim()
      const res = runBundle(['config', 'validate'])
      expect(res.status, res.stderr).toBe(0)
      const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')) as Record<string, string | undefined>
      const stashed = PAIRS.filter(([, real]) => process.env[real])
      expect(stashed.length, 'isolate-home must stash at least one real home').toBeGreaterThan(0)
      for (const [inherited, real] of stashed) {
        expect(seen[inherited], `child inherits ${inherited}`).toBe(process.env[inherited])
        expect(seen[inherited], `child received the real ${inherited}, not the sandbox`).not.toBe(process.env[real])
      }
    } finally {
      if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = savedNodeOptions
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
