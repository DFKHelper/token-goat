/** The permission-source filter has one predicate, in tests/setup/permission-source-filter.cjs: isolate-home.ts installs it in the test process and preloads the same file into every spawned node process. A second copy in isolate-home.ts would let the two sides drift, so a spawned bundle would read sources the in-process run ignores (or the reverse). */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]): string => fs.readFileSync(path.join(testsDir, ...p), 'utf8')
const HOOK_NAME = "Symbol.for('token-goat.permission-source-filter')"

describe('permission source filter', () => {
  it('is defined once, in the shared preload', () => {
    expect(read('setup', 'permission-source-filter.cjs')).toContain(HOOK_NAME)
    expect(read('setup', 'isolate-home.ts')).not.toContain('token-goat.permission-source-filter')
  })

  it('is installed in-process and preloaded into spawned processes from that same file', () => {
    const iso = read('setup', 'isolate-home.ts')
    expect(iso).toContain("permission-source-filter.cjs')")
    expect(iso).toContain('permissionFilter.install(permissionRoot)')
    expect(iso).toContain("process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], preload]")
  })

  // HAND-DERIVED: the product asks sourceAllowed about `registry:<key>` for the machine policy; resolved as a path that string lands under the cwd, which for a spawned hook in a fixture directory is inside the run root, so the registry was read after all.
  it('refuses a registry source even when the process runs from a directory inside the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-filter-'))
    try {
      const probe = [
        "const f = globalThis[Symbol.for('token-goat.permission-source-filter')]",
        "const reg = f('registry:HKLM' + String.fromCharCode(92) + 'SOFTWARE' + String.fromCharCode(92) + 'Policies')",
        "const inside = f(require('node:path').join(process.cwd(), 'x', 'settings.json'))",
        'process.stdout.write(JSON.stringify({ reg, inside }))',
      ].join(';')
      const res = spawnSync(process.execPath, ['-e', probe], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, TG_TEST_PERMISSION_ROOT: root, NODE_OPTIONS: `--require "${path.join(testsDir, 'setup', 'permission-source-filter.cjs').replaceAll('\\', '/')}"` },
      })
      expect(JSON.parse(res.stdout)).toEqual({ reg: false, inside: true })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the same hook name the product looks up', () => {
    const src = fs.readFileSync(path.join(testsDir, '..', 'src', 'rewrite_permission.ts'), 'utf8')
    expect(src).toContain(HOOK_NAME)
  })
})
