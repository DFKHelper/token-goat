import { spawnSync } from 'node:child_process'
// tg-no-regex-preload: spawns the built bundle or runs a subprocess and never calls the parser in this process
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROOT } from '../helpers/bundle.js'
import { pinnedPopulation } from './population.js'
// @ts-expect-error -- a maintainer script in plain JavaScript, deliberately outside the typed source tree.
import { npmCommand } from '../../scripts/dependabot-body.mjs'

interface PackedFileRecord {
  readonly path: string
}

interface PackedPackageRecord {
  readonly files: readonly PackedFileRecord[]
}

export function parseNpmPackJson(stdout: string): string[] {
  const start = stdout.search(/^\s*(?:\[|\{)/m)
  if (start < 0) throw new Error('npm pack output did not contain JSON')
  const parsed: unknown = JSON.parse(stdout.slice(start))
  const packs: readonly PackedPackageRecord[] = Array.isArray(parsed)
    ? parsed as readonly PackedPackageRecord[]
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed as Record<string, unknown>)
        .filter((value): value is PackedPackageRecord => (
          typeof value === 'object'
          && value !== null
          && Array.isArray((value as PackedPackageRecord).files)
        ))
      : []
  if (packs.length !== 1) throw new Error(`expected one packed package, received ${packs.length}`)
  return packs[0]!.files.map((file) => file.path.replaceAll('\\', '/'))
}

/** What `npm pack` would publish, read from npm itself rather than from package.json's `files` list: `dist/.npmignore` also decides, and it drops every `.cjs` except the hook client by name, so a new CommonJS file added to the build without a matching exception would build, pass every test that reads dist/, and be missing from every install. The dry run reads the working dist/, which the suite's global setup has just built. */
function packedPaths(): string[] {
  // npm's own entry through this Node rather than its Windows .cmd wrapper, which Node spawns only through a shell.
  const npm = npmCommand({ platform: process.platform, env: process.env, execPath: process.execPath, exists: fs.existsSync })
  expect(npm, 'no npm-cli.js to run').not.toBeNull()
  const res = spawnSync(npm.file, [...npm.prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
  // npm 10 emits a top-level array; npm 11 emits a package-name-keyed object. npm 10 may also prefix the JSON with prepare-hook output.
  return parseNpmPackJson(res.stdout)
}

describe('the published tarball', () => {
  it('parses npm 10 array and npm 11 object pack JSON', () => {
    const npm10 = '[{"files":[{"path":"dist/token-goat.mjs"},{"path":"dist/token-goat.core.mjs"}]}]'
    const npm11 = '{"token-goat@2.9.35":{"files":[{"path":"dist/token-goat.mjs"},{"path":"dist/token-goat.core.mjs"}]}}'
    expect(parseNpmPackJson(npm10)).toEqual(['dist/token-goat.mjs', 'dist/token-goat.core.mjs'])
    expect(parseNpmPackJson(`prepare hook output\n${npm11}`)).toEqual(['dist/token-goat.mjs', 'dist/token-goat.core.mjs'])
  })

  it('carries every entry file and every chunk the build emits', () => {
    const packed = new Set(packedPaths())
    // FORMAT-DERIVED from scripts/build-options.mjs (ENTRY_POINTS, emitted as `[name].mjs`, and CJS_CLIENT, emitted again as `[name].cjs`) and the launcher esbuild.config.mjs writes as dist/token-goat.mjs. The client is named twice because the shim template (src/bridges/shim_try_server.ts) loads the `.cjs` and the launcher loads the `.mjs`. FORMAT-DERIVED from esbuild.config.mjs too: the WebAssembly runtime's glue module, copied beside the chunks because ONNX Runtime loads it by URL rather than through the bundle.
    const entries = ['token-goat.mjs', 'token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs', 'ort-wasm-simd-threaded.mjs']
    const chunks = pinnedPopulation({ what: 'dist/ chunks', items: fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.startsWith('token-goat-chunk-') && f.endsWith('.mjs')), floor: 5 })
    const missing = [...entries, ...chunks].map((f) => `dist/${f}`).filter((p) => !packed.has(p))
    expect(missing).toEqual([])
  })
})
