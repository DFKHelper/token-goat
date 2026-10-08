/** `scripts/refresh-dependabot-lock.mjs --verify` must refuse a lock file that disagrees with itself, not only one the disclosure guard rejects. The script finds its repository from its own location, so each test copies it into a throwaway directory beside a lock file of its own, with a stub `vitest` (the disclosure guard passing) and a stub `js-yaml` (the script imports it at load) so the only thing that can fail is the consistency check under test. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** PROVENANCE: HAND-DERIVED. The b479903b shape: lefthook's optionalDependencies map names 2.1.14 while the platform package it names resolves to 2.1.15. */
const STALE_MAP_LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'sandbox', version: '1.0.0' },
    'node_modules/lefthook': { version: '2.1.15', optionalDependencies: { 'lefthook-linux-x64': '2.1.14' } },
    'node_modules/lefthook-linux-x64': { version: '2.1.15' },
  },
}
const CURRENT_MAP_LOCK = { ...STALE_MAP_LOCK, packages: { ...STALE_MAP_LOCK.packages, 'node_modules/lefthook': { version: '2.1.15', optionalDependencies: { 'lefthook-linux-x64': '2.1.15' } } } }

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refresh-lock-'))
  fs.mkdirSync(path.join(sandbox, 'scripts'))
  for (const name of ['refresh-dependabot-lock.mjs', 'dependabot-body.mjs', 'lock-consistency.mjs']) fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(sandbox, 'scripts', name))
  fs.mkdirSync(path.join(sandbox, 'node_modules', 'js-yaml'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'package.json'), JSON.stringify({ name: 'js-yaml', type: 'module', main: 'index.js' }))
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'index.js'), 'export function load() { return {} }\n')
  fs.mkdirSync(path.join(sandbox, 'node_modules', 'vitest'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'vitest', 'vitest.mjs'), 'process.exit(0)\n')
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0' }))
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function verify(lock: unknown): { status: number | null; stdout: string; stderr: string } {
  fs.writeFileSync(path.join(sandbox, 'package-lock.json'), JSON.stringify(lock))
  const r = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'refresh-dependabot-lock.mjs'), '--verify'], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('refresh-dependabot-lock --verify', () => {
  it('refuses a lock whose parent entry names a version the tree does not carry, and names the entry', () => {
    const r = verify(STALE_MAP_LOCK)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('disagrees with itself')
    expect(r.stderr).toContain('node_modules/lefthook declares optionalDependencies lefthook-linux-x64@2.1.14')
    expect(r.stderr).toContain('node_modules/lefthook-linux-x64@2.1.15')
  })

  it('accepts the same lock once the map names the installed version', () => {
    const r = verify(CURRENT_MAP_LOCK)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('every dependency spec in it is met')
  })
})
