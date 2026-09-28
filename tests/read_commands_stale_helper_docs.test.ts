/** warnIfFilesStale's doc comment sat directly above healStaleResultFiles' own, so the parser attached neither to warnIfFilesStale: `outline src/read_commands.ts` showed it with no summary, and `read` served its body with no contract (call it AFTER the query, with the files the results came from). Indexes the real source file through the real parser and checks each helper carries its own comment. */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

// HAND-DERIVED: the opening words of each helper's own doc comment in src/read_commands.ts, read off the source.
const OWN_DOC_OPENING = {
  warnIfFilesStale: "Self-heal AND warn for a multi-file command's own result set",
  healStaleResultFiles: 'Heals the index rows behind a result set whose files the caller never named',
} as const

describe('the stale-result helpers in read_commands.ts each carry their own doc comment', () => {
  const file = normalizePath(fileURLToPath(new URL('../src/read_commands.ts', import.meta.url)))
  indexFileSync(file)

  for (const [name, opening] of Object.entries(OWN_DOC_OPENING)) {
    it(`${name} is indexed with its own comment`, () => {
      const rows = querySymbols({ name, filePath: file })
      expect(rows).toHaveLength(1)
      expect((rows[0]!.docstring ?? '').trimStart()).toMatch(new RegExp(`^${opening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    })
  }
})
