/** The entry an install bakes under vitest works like an installed bundle (HAND-DERIVED: install_entry.ts). */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { installCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { isDevCheckoutEntry } from '../src/install_entry.js'

const home = mkdtempSync(join(tmpdir(), 'tg-runner-entry-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('the entry an install bakes under the test runner', () => {
  it('is an installed-style bundle outside any checkout, not the pool worker script', () => {
    expect(basename(process.argv[1] ?? ''), 'argv[1] is the pool worker, not a bundle').toBe('token-goat.mjs')
    expect(existsSync(process.argv[1] ?? ''), 'the pinned entry does not exist').toBe(true)
    expect(isDevCheckoutEntry(process.argv[1]), 'the pinned entry sits in a git checkout').toBe(false)
  })

  it('lets the install self-test pass for the Copilot shim', () => {
    expect(() => installCopilotHooksFile(join(home, 'hooks'), 'copilot')).not.toThrow()
  })
})
