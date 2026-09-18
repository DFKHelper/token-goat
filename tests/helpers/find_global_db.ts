import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Path of the first global.db under `dir`, searched depth-first, or null: a fixture's data dir layout differs per platform, so tests find the database rather than rebuild the platform path. */
export function findGlobalDb(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findGlobalDb(full)
      if (found !== null) return found
    } else if (entry.name === 'global.db') return full
  }
  return null
}
