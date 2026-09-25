import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'

/** What `npm pack` would publish, read from npm itself rather than from package.json's `files` list: `dist/.npmignore` also decides, and it drops every `.cjs` except the hook client by name, so a new CommonJS file added to the build without a matching exception would build, pass every test that reads dist/, and be missing from every install. The dry run reads the working dist/, which the suite's global setup has just built. */
function packedPaths(): string[] {
  // Constant arguments, so the shell Windows needs to run npm's .cmd wrapper sees nothing a caller controls.
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
  // CAPTURE (CI on Node 22, and npm 10.9.9 run here): npm 10 still runs `prepare` for a pack despite --ignore-scripts, and its output ("sync hooks: ...") lands on stdout ahead of the JSON; npm 11 skips it. npm's JSON is the array that opens at the start of a line.
  const json = res.stdout.slice(res.stdout.search(/^\[/m))
  const [pack] = JSON.parse(json) as Array<{ files: Array<{ path: string }> }>
  return pack!.files.map((f) => f.path.replaceAll('\\', '/'))
}

describe('the published tarball', () => {
  it('carries every entry file and every chunk the build emits', () => {
    const packed = new Set(packedPaths())
    // FORMAT-DERIVED from scripts/build-options.mjs (ENTRY_POINTS, emitted as `[name].mjs`, and CJS_CLIENT, emitted again as `[name].cjs`) and the launcher esbuild.config.mjs writes as dist/token-goat.mjs. The client is named twice because the shim template (src/bridges/shim_try_server.ts) loads the `.cjs` and the launcher loads the `.mjs`.
    const entries = ['token-goat.mjs', 'token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs']
    const chunks = pinnedPopulation({ what: 'dist/ chunks', items: fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.startsWith('token-goat-chunk-') && f.endsWith('.mjs')), floor: 5 })
    const missing = [...entries, ...chunks].map((f) => `dist/${f}`).filter((p) => !packed.has(p))
    expect(missing).toEqual([])
  })
})
