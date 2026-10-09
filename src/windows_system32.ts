/** Where a Windows system executable lives, from SystemRoot, then windir, then the literal C:\Windows: only an absolute folder that holds the file counts, so a relative or planted value cannot make a spawn resolve a bare name against the working directory or PATH. Imports only Node built-ins, so hook-eager modules can share it. */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The literal Windows folder every candidate falls back to. */
const DEFAULT_WINDOWS_DIR = 'C:\\Windows'

/** The absolute path of `System32/<rel>`: the first of SystemRoot, windir and C:\Windows that is absolute and holds the file, else the C:\Windows path (absolute, so a spawn of it fails closed instead of searching PATH or the working directory). */
export function windowsSystem32Exe(...rel: string[]): string {
  const missing = path.join(DEFAULT_WINDOWS_DIR, 'System32', ...rel)
  for (const root of [process.env['SystemRoot'], process.env['windir'], DEFAULT_WINDOWS_DIR]) {
    if (root === undefined || !path.win32.isAbsolute(root)) continue
    const exe = path.join(root, 'System32', ...rel)
    if (fs.existsSync(exe)) return exe
  }
  return missing
}
