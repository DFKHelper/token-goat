import { describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'

// PROVENANCE: HAND-DERIVED. The spelling is the one the self-test installs through on Windows (`\\?\C:\...`, see tests/vscode_duplicate.test.ts::twoSeparatorSpelling) and the failure is Node 22's `EISDIR: lstat 'C:'` on a device-prefixed script path, reproduced with node 22.23.5 and node 26.13.1 in a scratch probe. The assertions are on the generated command text, which is the defect's surface, so they hold on every platform.
describe('a guarded hook command never names a device-prefixed drive path', () => {
  const device = '\\\\?\\C:\\tgwt\\hooks\\token-goat-shim.cjs'
  const native = ['C:\\Program Files\\nodejs\\node.exe', device, 'sessionStart']

  for (const shell of ['sh', 'powershell'] as const) {
    it(`${shell}: the shim path is written as the plain drive form`, () => {
      const cmd = buildGuardedCommand({ shell, native, safe: "printf '%s' '{}'", marker: 'tg-guard-v4' })
      expect(cmd).not.toContain('\\\\?\\')
      expect(cmd).not.toContain('//?/')
      expect(cmd).toContain('C:\\tgwt\\hooks\\token-goat-shim.cjs')
    })
  }

  it('a device prefix on a UNC share is left as written', () => {
    const unc = ['node', '\\\\?\\UNC\\host\\share\\shim.cjs', 'sessionStart']
    const cmd = buildGuardedCommand({ shell: 'powershell', native: unc, safe: '', marker: 'tg-guard-v4' })
    expect(cmd).toContain('\\\\?\\UNC\\host\\share\\shim.cjs')
  })
})
