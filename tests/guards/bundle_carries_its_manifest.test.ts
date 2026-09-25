import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

/** The built bundle names its own version without opening package.json: esbuild.config.mjs inlines the fields src/version.ts exports (scripts/build-options.mjs buildDefines), because that read cost 2.2ms of every CLI start and of every hook call a resident server answers. Run from a copy of dist/ with no package.json above it, a bundle that still read the file would fall back to '0.0.0'. */
describe('the built bundle carries its own manifest', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manifest-'))
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

  it('reports the package version from a dist/ with no package.json beside or above it', () => {
    const copy = path.join(base, 'dist')
    fs.mkdirSync(copy)
    const files = pinnedPopulation({ what: 'dist/ bundle files copied', items: fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /\.(mjs|cjs)$/.test(f)), floor: 8, mustInclude: ['token-goat.mjs', 'token-goat.core.mjs'] })
    for (const f of files) fs.copyFileSync(path.join(ROOT, 'dist', f), path.join(copy, f))
    expect(fs.existsSync(path.join(base, 'package.json'))).toBe(false)
    // HAND-DERIVED expectation: the version package.json declares, read here independently of the bundle.
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
    const res = spawnSync(process.execPath, [path.join(copy, 'token-goat.mjs'), '--version'], { cwd: base, encoding: 'utf8', timeout: 30_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe(version)
  })
})
