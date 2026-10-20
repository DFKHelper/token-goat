/** indexSrcFiles, the seed helper behind graph_commands, json_envelope_shape and answer_router: it indexes exactly the files it is given, and a name that no longer exists is an error naming the file rather than a silently smaller seed. */
import { describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { indexSrcFiles } from './helpers/index-src-files.js'

function indexedPaths(): string[] {
  const rows = getDb(globalDbPath()).prepare('SELECT path FROM files').all() as Array<{ path: string }>
  return rows.map((r) => r.path.replace(/\\/g, '/'))
}

describe('indexSrcFiles', () => {
  it('names a missing file in its error instead of seeding fewer files', () => {
    expect(() => indexSrcFiles(['src/__no_such_seed_file__.ts'])).toThrow(/src\/__no_such_seed_file__\.ts does not exist/)
  })

  it('indexes the named files and no others', () => {
    indexSrcFiles(['src/paths.ts', 'src/path_containment.ts'])
    const paths = indexedPaths()
    expect(paths.filter((p) => p.endsWith('/src/paths.ts'))).toHaveLength(1)
    expect(paths.filter((p) => p.endsWith('/src/path_containment.ts'))).toHaveLength(1)
    expect(paths).toHaveLength(2)
    const symbols = getDb(globalDbPath()).prepare('SELECT count(*) AS c FROM symbols').get() as { c: number }
    expect(symbols.c, 'the named files must yield symbol rows, not just file rows').toBeGreaterThan(0)
  })
})
