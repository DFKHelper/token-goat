/** The Windows 8.3 short spelling of an existing directory, or null where there is none (not Windows, or the volume does not generate short names). */
import { spawnSync } from 'node:child_process'

export function shortPathOf(dir: string): string | null {
  if (process.platform !== 'win32') return null
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 20_000 })
  const short = r.status === 0 ? r.stdout.trim() : ''
  return short !== '' && short.toLowerCase() !== dir.toLowerCase() && short.includes('~') ? short : null
}
