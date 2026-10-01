import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsBash } from '../../src/shell.js'

/** Git for Windows' `bin\bash.exe` is a launcher that puts Git's own `mingw64\bin` and `usr\bin` at the front of PATH before starting `usr\bin\bash.exe`, so a stub prepended to PATH never runs under it. CAPTURE: CI's test-windows job on 6593e34f resolved that launcher from the runner's PATH and the grep-failure case in tests/commit_msg_hook_denylist.test.ts got exit 0, while this machine resolves `usr\bin\bash.exe` and passed. The hook itself runs under whatever bash lefthook finds; only a stub needs the real shell. */
function directBash(bash: string | null): string | null {
  if (bash === null || !/[\\/]git[\\/]bin[\\/]bash\.exe$/i.test(bash)) return bash
  const direct = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'bash.exe')
  return fs.existsSync(direct) ? direct : bash
}

/** The bash the lefthook scripts are run under in tests, or null when this machine has none. */
export const HOOK_BASH = process.platform === 'win32' ? directBash(resolveWindowsBash()) : 'bash'

export function slash(p: string): string {
  return p.replace(/\\/g, '/')
}
