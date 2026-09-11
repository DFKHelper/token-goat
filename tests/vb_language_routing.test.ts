/**
 * The `.cls` extension is shared by Apex classes and VB6 class modules, and detectLanguage is path-only, so the indexer refines the language from content after reading the file. These tests drive the two real entry points (parseFile and indexFileSync) rather than the extractor, since a sniff that exists but is never called from the shipping path would pass every extractor-level test.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { extractApex } from '../src/languages/apex.js'
import { indexFileSync, parseFile } from '../src/parser.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APEX_FIXTURE = path.join(HERE, 'fixtures', 'salesforce-dx', 'force-app', 'main', 'default', 'classes', 'SafeNavigationService.cls')

// CAPTURE: lines 1-9 and 24 verbatim from a real VB6 class module, https://github.com/respec/VB6/blob/master/Utility/CFileInfo.cls; the Property pair and Function below it are shortened from the same file.
const VB6_CLASS = [
  'VERSION 1.0 CLASS',
  'BEGIN',
  "  MultiUse = -1  'True",
  'END',
  'Attribute VB_Name = "CFileInfo"',
  'Attribute VB_GlobalNameSpace = False',
  'Attribute VB_Creatable = False',
  'Attribute VB_PredeclaredId = False',
  'Attribute VB_Exposed = False',
  'Option Explicit',
  'Private Declare Function GetFullPathName Lib "kernel32" Alias "GetFullPathNameA" (ByVal lpFileName As String, ByVal nBufferLength As Long, ByVal lpBuffer As String, lpFilePart As Long) As Long',
  'Private m_Path As String',
  'Public Property Let FullPathName(ByVal NewVal As String)',
  '   m_Path = NewVal',
  'End Property',
  'Public Property Get FullPathName() As String',
  '   FullPathName = m_Path',
  'End Property',
  'Public Sub Refresh()',
  'End Sub',
  '',
].join('\r\n')

describe('Visual Basic routing through the real indexer entry points', () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    closeAllDbs()
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
    tmpDirs = []
  })

  function tmpFile(name: string, content: string | Buffer): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vb-routing-'))
    tmpDirs.push(dir)
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return { dir, file }
  }

  function storedLanguage(dbPath: string, file: string): string | undefined {
    const rows = getDb(dbPath).prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>
    return rows.find((r) => path.basename(r.path).toLowerCase() === path.basename(file).toLowerCase())?.language
  }

  it('indexes a VB6 class module .cls with the VB extractor and stores its language as vb', async () => {
    const { dir, file } = tmpFile('CFileInfo.cls', VB6_CLASS)
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('vb')
    expect(parsed.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual([
      'function GetFullPathName',
      'field m_Path',
      'property FullPathName',
      'property FullPathName',
      'function Refresh',
    ])

    const dbPath = path.join(dir, 'index.db')
    indexFileSync(file, dbPath)
    expect(storedLanguage(dbPath, file)).toBe('vb')
    const refresh = querySymbols({ name: 'Refresh' }, dbPath)
    expect(refresh.map((s) => [s.lineStart, s.lineEnd])).toEqual([[19, 20]])
  })

  it('keeps a real Apex .cls on the Apex extractor, byte-for-byte the same output', async () => {
    const content = fs.readFileSync(APEX_FIXTURE, 'utf8')
    const { dir, file } = tmpFile('SafeNavigationService.cls', content)
    const parsed = await parseFile(file)
    expect(parsed.language).toBe('apex')
    const expected = extractApex(content, file).symbols
    expect(expected.length).toBeGreaterThan(0)
    expect(parsed.symbols).toEqual(expected)

    const dbPath = path.join(dir, 'index.db')
    indexFileSync(file, dbPath)
    expect(storedLanguage(dbPath, file)).toBe('apex')
  })

  it('indexes nothing, and does not throw, for a binary MySQL .frm or a .frm without the VB6 header', async () => {
    // HAND-DERIVED: a MySQL table definition .frm is binary and opens with the bytes 0xFE 0x01; it has no VERSION 5.00 header.
    const binary = tmpFile('orders.frm', Buffer.from([0xfe, 0x01, 0x09, 0x09, 0x00, 0x00, 0x30, 0x00, 0x53, 0x75, 0x62, 0x20, 0x58, 0x28, 0x29]))
    const parsedBinary = await parseFile(binary.file)
    expect(parsedBinary.symbols).toEqual([])
    const dbPath = path.join(binary.dir, 'index.db')
    expect(() => indexFileSync(binary.file, dbPath)).not.toThrow()
    expect(querySymbols({ filePath: binary.file }, dbPath)).toEqual([])

    const plain = tmpFile('notes.frm', 'Sub X()\nEnd Sub\n')
    expect((await parseFile(plain.file)).symbols).toEqual([])
  })
})
