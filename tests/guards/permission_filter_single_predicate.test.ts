/** The permission-source filter has one predicate, in tests/setup/permission-source-filter.cjs: isolate-home.ts installs it in the test process and preloads the same file into every spawned node process. A second copy in isolate-home.ts would let the two sides drift, so a spawned bundle would read sources the in-process run ignores (or the reverse). */
import * as fs from 'node:fs'
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

  it('reads the same hook name the product looks up', () => {
    const src = fs.readFileSync(path.join(testsDir, '..', 'src', 'rewrite_permission.ts'), 'utf8')
    expect(src).toContain(HOOK_NAME)
  })
})
