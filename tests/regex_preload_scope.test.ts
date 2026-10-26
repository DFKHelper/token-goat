/** tests/setup/load-regex-extractors.ts compiled about seventy adapter modules in every fork-per-file worker, and on a busy machine that import alone ran into the 60 s hookTimeout (a full Windows pre-push run, log C:/tgwt/push_fail2_7f42686d9.tests.log: the hook of tests/transcript_extract.test.ts timed out). The globalSetup now lists the test files that never reach src/parser.ts and those files skip the load. The rows pin which files are listed, that the hook obeys the list, and that a file the list could get wrong is still loaded. */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, inject, it } from 'vitest'

import { loadsRegexAdapters } from './setup/regex-preload-decision.js'
import { PARSER_MODULE, readScopeSources, testsOutsideParser } from './setup/regex-preload-scope.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Provenance: HAND-DERIVED. Each tiny repo below is written out by hand and the expected list is read off its import edges, independently of the scan; the specifier spellings (a .js suffix on a TypeScript source, a literal dynamic import, vi.mock) are the ones scripts/prepush-graph.mjs documents and tests/prepush_graph.test.ts captures from this repo.
describe('testsOutsideParser', () => {
  const repo = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files))

  it('lists a test that imports nothing from the parser and leaves out one that does', () => {
    const sources = repo({
      [PARSER_MODULE]: 'export const parse = 1',
      'tests/a.test.ts': "import { parse } from '../src/parser.js'",
      'tests/b.test.ts': "import { x } from '../src/other.js'",
      'src/other.ts': 'export const x = 1',
    })
    expect(testsOutsideParser(sources)).toEqual(['tests/b.test.ts'])
  })

  it('treats a test as reaching the parser through any number of hops, a helper, a dynamic import or a mock', () => {
    const sources = repo({
      [PARSER_MODULE]: 'export const parse = 1',
      'src/middle.ts': "import { parse } from './parser.js'",
      'src/top.ts': "import { m } from './middle.js'",
      'tests/helpers/h.ts': "import { t } from '../../src/top.js'",
      'tests/transitive.test.ts': "import { t } from '../src/top.js'",
      'tests/helper.test.ts': "import { h } from './helpers/h.js'",
      'tests/dynamic.test.ts': "const m = await import('../src/middle.js')",
      'tests/mocked.test.ts': "vi.mock('../src/parser.js', () => ({}))",
      'tests/clear.test.ts': "import { x } from './helpers/plain.js'",
      'tests/helpers/plain.ts': 'export const x = 1',
    })
    expect(testsOutsideParser(sources)).toEqual(['tests/clear.test.ts'])
  })

  it('lists only test files and sorts them', () => {
    const sources = repo({
      [PARSER_MODULE]: '',
      'tests/z.test.ts': '',
      'tests/a.test.ts': '',
      'tests/helpers/not_a_test.ts': '',
      'src/lonely.ts': '',
    })
    expect(testsOutsideParser(sources)).toEqual(['tests/a.test.ts', 'tests/z.test.ts'])
  })
})

describe('loadsRegexAdapters', () => {
  it('skips a file on the list and loads one that is not', () => {
    const list = ['tests/listed.test.ts']
    expect(loadsRegexAdapters('tests/listed.test.ts', list, false)).toBe(false)
    expect(loadsRegexAdapters('tests/other.test.ts', list, false)).toBe(true)
  })

  it('loads when there is no list or the file is outside the repo', () => {
    expect(loadsRegexAdapters('tests/listed.test.ts', undefined, false)).toBe(true)
    expect(loadsRegexAdapters(null, ['tests/listed.test.ts'], false)).toBe(true)
  })

  it('skips an opted-out file whether or not a list exists', () => {
    expect(loadsRegexAdapters('tests/other.test.ts', undefined, true)).toBe(false)
    expect(loadsRegexAdapters('tests/other.test.ts', [], true)).toBe(false)
  })
})

describe('the suite listing', () => {
  const listed = testsOutsideParser(readScopeSources(ROOT))

  it('is the list the globalSetup handed every worker', () => {
    expect(inject('outsideParserTests')).toEqual(listed)
  })

  it('leaves out files that call the parser in their own process', () => {
    expect(listed).not.toContain('tests/parser_markdown_closing_hash.test.ts')
    expect(listed).not.toContain('tests/parse_fixture_helper.test.ts')
  })

  it('lists no file that names a parser entry point in its text, bar the four read by hand', () => {
    // A file the import scan cannot link to the parser (a specifier built at run time) but that names an entry point is the case the scan would get wrong. These four were each read on 2026-10-25 and only quote the names: two scan source text, one holds log-line strings, one imports adapters directly (src/languages/*), which never touch the parser's slot. A new listed file that names one fails here until someone reads it.
    const entry = /\b(?:indexFileSync|parseContent|loadRegexExtractors|extractSymbolsFromContent)\b/
    const readByHand = new Set([
      'tests/guards/parser_fingerprint_covers_extraction_sources.test.ts',
      'tests/guards/read_commands_confinement_bypass.test.ts',
      'tests/indexer_patterns_cannot_stall_the_worker.test.ts',
      'tests/worker_error_log_one_line.test.ts',
    ])
    const naming = listed.filter((file) => !readByHand.has(file) && entry.test(readFileSync(path.join(ROOT, file), 'utf8')))
    expect(naming).toEqual([])
  })

  it('lists the file that proves the hook skips', () => {
    expect(listed).toContain('tests/regex_preload_skipped.test.ts')
  })
})
