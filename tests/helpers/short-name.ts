import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** The 8.3 short name of a directory, or null off Windows or when the volume has 8dot3 name creation disabled. `dir /x` prints the short name in the column just before the long one; the token is taken from there and must carry the `~` every generated short name has, since a 12-hour locale's AM/PM column also looks like one. */
export function shortNameOf(dir: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', path.dirname(dir)], { encoding: 'utf8' })
    const base = path.basename(dir)
    for (const line of out.split(/\r?\n/)) {
      if (!line.endsWith(` ${base}`)) continue
      const short = line.slice(0, -base.length).trimEnd().split(/\s+/).pop()
      if (short !== undefined && short.includes('~')) return short
    }
    return null
  } catch {
    return null
  }
}
