/**
 * Loop 56 regression coverage for two admission gaps in the adapters that no earlier sweep
 * touched: the dotenv extractor behind `languages/env_idx.ts`, and `languages/salesforce_metadata.ts`.
 *
 * Both fixtures are FORMAT-DERIVED, and neither was read off token-goat's own matchers:
 *
 * - The indented and tab-indented `.env` assignments come from dotenv's own parser, whose LINE
 *   regex opens with `^\s*(?:export\s+)?([\w.-]+)`, i.e. leading blanks are part of a legal
 *   assignment. Source: https://raw.githubusercontent.com/motdotla/dotenv/master/lib/main.js
 * - The `</fullName >` and `</name >` end tags come from the XML 1.0 grammar, production [42]:
 *   `ETag ::= '</' Name S? '>'`, so whitespace before the `>` is legal in any end tag.
 *   Source: https://www.w3.org/TR/xml/#sec-starttags
 *
 * Coverage drives the REAL indexing pipeline (indexFileSync writing the symbols table, then
 * querySymbols reading it back), not the adapter functions in isolation.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { listSections } from '../src/section_reader.js'

const tempDirs = new Set<string>()
const dbPaths = new Set<string>()

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

function indexed(fileName: string, body: string): { dbPath: string; file: string } {
  const repo = tempDir('tg-l56-repo-')
  const data = tempDir('tg-l56-data-')
  const file = path.join(repo, fileName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { encoding: 'utf8' })
  const dbPath = path.join(data, 'global.db')
  dbPaths.add(dbPath)
  indexFileSync(file, dbPath)
  return { dbPath, file }
}

afterEach(() => {
  for (const dbPath of dbPaths) closeDb(dbPath)
  dbPaths.clear()
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

describe('dotenv admission: leading whitespace', () => {
  it('indexes indented, tab-indented and exported assignments alongside a column-0 one', () => {
    const { dbPath } = indexed('.env', 'PLAIN_KEY=1\n  INDENTED_KEY=2\n\texport TABBED_KEY=3\n  # a comment\n')

    const names = querySymbols({ kind: 'env_key' }, dbPath)
      .map((s) => s.name)
      .sort()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toEqual(['INDENTED_KEY', 'PLAIN_KEY', 'TABBED_KEY'])
  })

  it('resolves an indented key as a live section heading too, matching the indexed symbol', () => {
    const repo = tempDir('tg-l56-sec-')
    const file = path.join(repo, '.env')
    fs.writeFileSync(file, 'PLAIN_KEY=1\n  INDENTED_KEY=2\nAFTER=3\n', { encoding: 'utf8' })

    const headings = listSections(file)
    expect(headings.length).toBeGreaterThan(0)
    expect(headings).toEqual(['PLAIN_KEY', 'INDENTED_KEY', 'AFTER'])
  })

  it('non-firing: an indented continuation of a multi-line quoted value is still not a key', () => {
    const { dbPath } = indexed('.env', 'OUTER="first\n  NOT_A_KEY=2\n"\nAFTER=3\n')

    const names = querySymbols({ kind: 'env_key' }, dbPath)
      .map((s) => s.name)
      .sort()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toEqual(['AFTER', 'OUTER'])
  })
})

describe('Salesforce metadata admission: whitespace before an end tag bracket', () => {
  it('reads an object fullName closed as </fullName > instead of swallowing the rest of the file', () => {
    const { dbPath } = indexed(
      path.join('objects', 'Account', 'Account.object-meta.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">',
        '    <fullName>Account</fullName >',
        '    <label>Account</label>',
        '    <fields>',
        '        <fullName>Region__c</fullName>',
        '    </fields>',
        '</CustomObject>',
        '',
      ].join('\n'),
    )

    const objects = querySymbols({ kind: 'sf_object' }, dbPath)
    expect(objects.length).toBeGreaterThan(0)
    expect(objects.map((s) => s.name)).toEqual(['Account'])
  })

  it('keeps two flow elements separate when the first closes its name as </name >', () => {
    const { dbPath } = indexed(
      path.join('flows', 'Onboard.flow-meta.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
        '    <variables>',
        '        <name>FirstVar</name >',
        '        <dataType>String</dataType>',
        '    </variables>',
        '    <variables>',
        '        <name>SecondVar</name>',
        '        <dataType>String</dataType>',
        '    </variables>',
        '</Flow>',
        '',
      ].join('\n'),
    )

    const vars = querySymbols({ kind: 'sf_flow_variable' }, dbPath)
    expect(vars.length).toBeGreaterThan(0)
    expect(vars.map((s) => s.name).sort()).toEqual(['FirstVar', 'SecondVar'])
    expect(vars.map((s) => [s.name, s.lineStart, s.lineEnd]).sort()).toEqual([
      ['FirstVar', 3, 6],
      ['SecondVar', 7, 10],
    ])
  })

  it('non-firing: ordinary end tags with no whitespace still index every flow element', () => {
    const { dbPath } = indexed(
      path.join('flows', 'Plain.flow-meta.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
        '    <variables>',
        '        <name>Alpha</name>',
        '    </variables>',
        '    <variables>',
        '        <name>Beta</name>',
        '    </variables>',
        '</Flow>',
        '',
      ].join('\n'),
    )

    const vars = querySymbols({ kind: 'sf_flow_variable' }, dbPath)
    expect(vars.length).toBeGreaterThan(0)
    expect(vars.map((s) => s.name).sort()).toEqual(['Alpha', 'Beta'])
  })
})
