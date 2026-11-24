import { describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'

// PROVENANCE: CAPTURE: CI run 45441436648 (DFKHelper/token-goat), test-windows (1), EISDIR lstat 'C:' under a device-prefixed cwd. HAND-DERIVED: every spelling below is written from the path rules in src/process_util.ts::plainWindowsPath, not copied from output.
describe('a guarded hook command never names a device-prefixed path', () => {
  const SHELLS = ['sh', 'powershell'] as const

  const guardedWith = (shell: (typeof SHELLS)[number], shim: string): string =>
    buildGuardedCommand({ shell, native: ['C:\\Program Files\\nodejs\\node.exe', shim, 'sessionStart'], safe: "printf '%s' '{}'", marker: 'tg-guard-v4' })

  // [device spelling a caller may hold, plain drive form every shell must write]
  const DRIVE_ROWS: ReadonlyArray<readonly [string, string]> = [
    ['\\\\?\\C:\\tgwt\\hooks\\token-goat-shim.cjs', 'C:\\tgwt\\hooks\\token-goat-shim.cjs'],
    ['//?/C:/tgwt/hooks/token-goat-shim.cjs', 'C:/tgwt/hooks/token-goat-shim.cjs'],
    ['\\\\?\\c:\\tgwt\\hooks\\token-goat-shim.cjs', 'c:\\tgwt\\hooks\\token-goat-shim.cjs'],
  ]

  for (const shell of SHELLS) {
    for (const [device, plain] of DRIVE_ROWS) {
      it(`${shell}: ${device} is written as the plain drive form`, () => {
        const cmd = guardedWith(shell, device)
        expect(cmd, 'the plain drive word is written').toContain(`'${plain}'`)
        expect(cmd, 'the backslash device prefix is gone').not.toContain('\\\\?\\')
        expect(cmd, 'the forward-slash device prefix is gone').not.toContain('//?/')
      })
    }

    it(`${shell}: a plain drive path is written exactly as before`, () => {
      expect(guardedWith(shell, 'C:\\tgwt\\hooks\\token-goat-shim.cjs')).toContain("'C:\\tgwt\\hooks\\token-goat-shim.cjs'")
    })

    it(`${shell}: a device prefix that is not leading is left as written`, () => {
      const raw = 'C:\\a\\\\?\\D:\\b'
      expect(guardedWith(shell, raw), 'the mid-string spelling is written unchanged').toContain(`'${raw}'`)
    })

    it(`${shell}: a plain UNC share is written exactly as before`, () => {
      const expected = shell === 'sh' ? "'//host/share/x.cjs'" : "'\\\\host\\share\\x.cjs'"
      expect(guardedWith(shell, '\\\\host\\share\\x.cjs')).toContain(expected)
    })
  }

  it('sh: a device prefix on a UNC share is written as the plain //host/share form Node 22 loads', () => {
    expect(guardedWith('sh', '\\\\?\\UNC\\host\\share\\shim.cjs')).toContain("'//host/share/shim.cjs'")
  })

  it('powershell: a device prefix on a UNC share is written as the plain \\\\host\\share form', () => {
    expect(guardedWith('powershell', '\\\\?\\UNC\\host\\share\\shim.cjs')).toContain("'\\\\host\\share\\shim.cjs'")
  })
})
