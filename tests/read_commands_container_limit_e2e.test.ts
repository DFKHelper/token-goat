/**
 * End-to-end regression for the dotted-spec container lookup losing the requested class to the
 * query's LIMIT (defect 2 in the batch this file was added for).
 *
 * `token-goat read "file.ts::ClassB.method"` narrows an ambiguous same-file, same-named-method
 * candidate list by finding a symbol named `ClassB` whose line range contains the candidate.
 * That containers lookup was `querySymbols({ name: symBase, limit: 50 })` with no file filter, so
 * for a container name shared by 50+ classes across the project the requested file's `ClassB` row
 * sorted (by `ORDER BY file_path, line_start`) past the LIMIT before the per-candidate filePath
 * containment check ever saw it, and a correct, unambiguous resolution degraded to `ambiguous`
 * (both same-named methods survive since neither can be attributed to its class).
 *
 * Drives the real, unmocked pipeline: real files on disk under a temp dir (never inside the
 * repo), real indexFileSync, real (test-isolated) global.db, real resolveSymbolSpec via runRead.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { runRead } from '../src/read_commands.js'

// Unique per test file so no other test's rows share these names and perturb the ordering.
const CONTAINER = 'ContainerLimitProbeB9x'
const OTHER_CONTAINER = 'ContainerLimitProbeA9x'
const METHOD = 'probeMethod9x'
const DUMMY_COUNT = 60

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-container-limit-'))
  // 60 files each declaring a class named exactly like the requested container, sorting ahead of
  // the target file alphabetically (`a01.ts .. a60.ts` < `zzz_target.ts`) so the LIMIT 50
  // container query drops the target file's row before the per-candidate filePath check runs.
  for (let i = 1; i <= DUMMY_COUNT; i++) {
    const name = `a${String(i).padStart(2, '0')}.ts`
    const file = join(root, name)
    writeFileSync(file, `class ${CONTAINER} {\n  placeholder() {\n    return ${i}\n  }\n}\n`)
    indexFileSync(file)
  }
  // The target file: two classes sharing one method name, so the bare-method lookup is
  // genuinely ambiguous and the container-name disambiguation is the only thing that can
  // resolve it -- exactly the case comment near the container query describes.
  const targetFile = join(root, 'zzz_target.ts')
  writeFileSync(
    targetFile,
    `class ${OTHER_CONTAINER} {\n  ${METHOD}() {\n    return 111\n  }\n}\n\n` +
      `class ${CONTAINER} {\n  ${METHOD}() {\n    return 222\n  }\n}\n`,
  )
  indexFileSync(targetFile)
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort; WAL sidecars may briefly linger on Windows
  }
})

// HAND-DERIVED: every fixture here is generated from the constants above (CONTAINER, OTHER_CONTAINER, METHOD, and the filler count), and each expectation is the return value the target file's own source states, never a string read off the resolver's output. The filler count is chosen against the query's LIMIT, which is a property of the code under test, so the population size is derived; what the assertions check is not.
describe('dotted-spec container disambiguation survives more same-named containers than the query limit', () => {
  it(`resolves ${CONTAINER}.${METHOD} in the last-sorting file to the right class, not ambiguous or the wrong class`, () => {
    const { text, code } = runRead({ spec: `zzz_target.ts::${CONTAINER}.${METHOD}` })
    expect(code).toBe(0)
    expect(text).toContain('return 222')
    expect(text).not.toContain('return 111')
  })

  it(`still resolves the other same-file class's method by its own container name`, () => {
    const { text, code } = runRead({ spec: `zzz_target.ts::${OTHER_CONTAINER}.${METHOD}` })
    expect(code).toBe(0)
    expect(text).toContain('return 111')
    expect(text).not.toContain('return 222')
  })
})
