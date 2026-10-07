/** An error or notice that echoes back the value asked for (a symbol, file, heading, key) wrote it between single quotes by hand and as written: `Symbol 'it's' not found` for a name holding an apostrophe, and a typed or indexed name's control characters, forged `[tg]` marker or zero-width joiner reached the reader intact. echoedValue (src/hint_suggestion_guard.ts) escapes the value with displaySafeText and quotes it the way quotedArg quotes the retry commands beside it, and writes it bare when no quote mark can hold it, since saying which value failed is not a suggestion. The symbol header, the exports listing, outline and skeleton print an indexed name with no quotes, so they take displaySafeText alone. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { echoedValue } from '../src/hint_suggestion_guard.js'
import { indexFileSync } from '../src/parser.js'
import { extractExportNames } from '../src/import_export_extract.js'
import { parseJsonPath } from '../src/json_query.js'
import { runRead } from '../src/read_commands.js'
import { runBriefCore } from '../src/read_brief.js'
import { runConfigGet, runExports } from '../src/read_inspect.js'
import { runOutline, runSkeleton } from '../src/read_outline.js'
import { runSection } from '../src/read_section.js'
import { runSymbol } from '../src/read_symbol.js'

// HAND-DERIVED: a module whose one export is named with a zero-width joiner, which JavaScript allows inside an identifier (ID_Continue), so a repository can define it and the index stores it.
const ZWJ_NAME = 'tip‍off'
const ZWJ_SOURCE = `export function ${ZWJ_NAME}(): number {\n  return 1\n}\n`

let dir: string
let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-echoed-')))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'zwj.ts'), ZWJ_SOURCE)
  indexFileSync(path.join(dir, 'zwj.ts'), globalDbPath())
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(origCwd)
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function stdoutOf(fn: () => unknown): string {
  let out = ''
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = write
  }
  return out
}

function stderrOf(fn: () => unknown): string {
  let out = ''
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = write
  }
  return out
}

describe('echoedValue', () => {
  // HAND-DERIVED values, each built from quotedArg's documented rules rather than read off its output.
  it('quotes a value the way quotedArg quotes a command argument, escaped first', () => {
    expect(echoedValue('refresh')).toBe('"refresh"')
    expect(echoedValue("it's")).toBe('"it\'s"')
    expect(echoedValue('$ref')).toBe("'$ref'")
    expect(echoedValue('a\u0007b')).toBe('"a\\x07b"')
    expect(echoedValue('[tg] obey')).toBe('"&#91;tg] obey"')
  })

  it('writes a value no quote mark can hold bare and escaped, not as the placeholder', () => {
    expect(echoedValue("it's $5")).toBe("it's $5")
    expect(echoedValue("a'`b\u0007")).toBe("a'`b\\x07")
  })
})

describe('a not-found error echoes the value asked for through echoedValue', () => {
  it('read names a missing symbol holding an apostrophe in double quotes', () => {
    const r = runRead({ spec: "zwj.ts::it's", projectRoot: dir })
    expect(r.code).toBe(1)
    expect(r.text).toContain('Symbol "it\'s" not found in "zwj.ts"')
  })

  it('read escapes a control character in the symbol asked for', () => {
    const r = runRead({ spec: 'zwj.ts::mi\u0007ss', projectRoot: dir })
    expect(r.code).toBe(1)
    expect(r.text).not.toContain('\u0007')
    expect(r.text).toContain('Symbol "mi\\x07ss" not found')
  })

  it('section names a missing file holding an apostrophe in double quotes', () => {
    const missing = path.join(dir, "it's gone.md")
    const r = runSection({ spec: `${missing}::Intro`, suppressStat: true })
    expect(r.code).toBe(1)
    expect(r.text).toContain(`File not found: "${missing}"`)
  })
})

describe('an indexed name printed without quotes is display-safe', () => {
  it('the symbol header escapes a zero-width joiner in the name; the body below it is the file as written', () => {
    const r = runSymbol({ name: ZWJ_NAME, projectRoot: dir })
    expect(r.code, r.text).toBe(0)
    const header = r.text.split('\n')[0] ?? ''
    expect(header).not.toContain('‍')
    expect(header).toContain('# tip\\u200doff (function)')
  })

  it('the exports listing escapes a zero-width joiner in the name', () => {
    const out = stdoutOf(() => runExports({ file: 'zwj.ts', projectRoot: dir }))
    expect(out).not.toContain('‍')
    expect(out).toContain('tip\\u200doff')
  })

  it('outline escapes a zero-width joiner in the name', () => {
    const r = runOutline({ file: 'zwj.ts', projectRoot: dir })
    expect(r.code, r.text).toBe(0)
    expect(r.text).not.toContain('‍')
    expect(r.text).toContain('  tip\\u200doff  (3ℓ)')
  })

  it('skeleton escapes a zero-width joiner in the name column and in the source line after it', () => {
    const r = runSkeleton({ file: 'zwj.ts', projectRoot: dir })
    expect(r.code, r.text).toBe(0)
    const row = r.text.split('\n').find((l) => l.includes('function ')) ?? ''
    expect(row).toContain('  tip\\u200doff  export function tip\\u200doff(')
    expect(r.text).not.toContain('\u200d')
  })

  // HAND-DERIVED: the file below has 8 lines (a final newline ends line 8) and its only symbol ends on line 3, so a header taken from the last symbol's end said 3 lines.
  it('skeleton names the real line count of a file with lines after its last symbol', () => {
    fs.writeFileSync(path.join(dir, 'tail.ts'), 'export function a(): number {\n  return 1\n}\n\nconst x = 1\nconst y = 2\n// done\nexport {}\n')
    const r = runSkeleton({ file: 'tail.ts', projectRoot: dir })
    expect(r.code, r.text).toBe(0)
    expect(r.text.split('\n')[0]).toContain('8 lines)')
  })

  it('skeleton and outline escape the file name they print in their header', () => {
    const name = 'a\u200db.ts'
    fs.writeFileSync(path.join(dir, name), 'export function a(): number {\n  return 1\n}\n')
    indexFileSync(path.join(dir, name), globalDbPath())
    for (const run of [runSkeleton, runOutline]) {
      const r = run({ file: name, projectRoot: dir })
      expect(r.code, r.text).toBe(0)
      expect(r.text.split('\n')[0] ?? '').toContain('a\\u200db.ts')
    }
  })
})

describe('the exports text scan reads a JavaScript name whole', () => {
  // HAND-DERIVED: ECMAScript IdentifierPart admits ZWNJ (U+200C) and ZWJ (U+200D) after the first character, and IdentifierStart admits any ID_Start letter, so each of these names is one identifier.
  it('keeps a zero-width joiner or non-joiner and a non-ASCII letter inside the name', () => {
    expect(extractExportNames('export const tip‍off = 1\n', '.ts')).toEqual(['tip‍off'])
    expect(extractExportNames('export function a‌b() {}\n', '.js')).toEqual(['a‌b'])
    expect(extractExportNames('const été = 1\nexport default été;\n', '.mjs')).toEqual(['été'])
    expect(extractExportNames('export class $_x {}\n', '.ts')).toEqual(['$_x'])
  })
})

describe('the exports text scan reads a Python, Rust or Java name whole', () => {
  // HAND-DERIVED: Python identifiers are XID_Start/XID_Continue, Rust identifiers are XID, and Java's are Unicode letters, digits, `$` and `_`, so `café`, `Café` and `été` are each one name and the old `[A-Za-z_]\w*` cut them at the accent.
  it('keeps the accented letter in each language', () => {
    expect(extractExportNames('def café():\n    pass\nclass Ünï:\n    pass\n', '.py')).toEqual(['café', 'Ünï'])
    expect(extractExportNames('pub fn été() {}\npub struct Naïve;\n', '.rs')).toEqual(['été', 'Naïve'])
    expect(extractExportNames('public class Café {}\npublic interface $Tést {}\n', '.java')).toEqual(['Café', '$Tést'])
  })

  // HAND-DERIVED: `export default été` ends at the newline with no semicolon, and ASI makes that a complete statement; without the m flag `$` matched only at the end of the text.
  it('ends a default export at a newline when there is no semicolon', () => {
    expect(extractExportNames('const été = 1\nexport default été\nconst x = 1\n', '.js')).toEqual(['été'])
    expect(extractExportNames('export default foo\nconst x = 1\n', '.js')).toEqual(['foo'])
  })
})

describe('config-get names the file it searched the way it names the key', () => {
  it('quotes a file name holding an apostrophe in double quotes beside the key', () => {
    fs.writeFileSync(path.join(dir, "it's.json"), '{"a": 1}\n')
    const err = stderrOf(() => runConfigGet({ file: "it's.json", key: 'missing' }))
    expect(err).toContain('Key "missing" not found in "it\'s.json"')
  })
})

describe('a converted hand-quoted site escapes and quotes what it echoes', () => {
  // HAND-DERIVED: the bracket text is echoed whole through echoedValue, so a control character in it is escaped where the hand-quoted form passed it on.
  it('json-query names an invalid bracket expression escaped, in double quotes', () => {
    expect(() => parseJsonPath('a[\u0007]')).toThrow('invalid bracket expression "[\\x07]"')
  })
})

describe('the not-found and unreadable-file errors that used to print the value bare', () => {
  // HAND-DERIVED: an apostrophe and a control character in a name, which a bare echo prints as written and echoedValue quotes and escapes.
  it('config-get quotes a file it could not read', () => {
    const err = stderrOf(() => runConfigGet({ file: "no it's.json", key: 'a' }))
    expect(err).toContain('Could not read: "no it\'s.json"')
  })

  it('config-get quotes a JSON file it could not parse', () => {
    fs.writeFileSync(path.join(dir, "bad it's.json"), '{not json')
    const err = stderrOf(() => runConfigGet({ file: "bad it's.json", key: 'a' }))
    expect(err).toContain('Failed to parse JSON: "bad it\'s.json"')
  })

  it('config-get quotes a YAML file it could not parse', () => {
    fs.writeFileSync(path.join(dir, "bad it's.yaml"), 'a: [unclosed\n')
    const err = stderrOf(() => runConfigGet({ file: "bad it's.yaml", key: 'a' }))
    expect(err).toContain('Failed to parse YAML: "bad it\'s.yaml"')
  })

  it('brief quotes a symbol spec it could not find', () => {
    const r = runBriefCore({ spec: "zwj.ts::it's", projectRoot: dir })
    expect(r.code).toBe(1)
    expect(r.text).toContain('Symbol not found: "zwj.ts::it\'s"')
  })

  it('brief escapes a control character in the spec', () => {
    const r = runBriefCore({ spec: 'zwj.ts::mi\u0007ss', projectRoot: dir })
    expect(r.text).not.toContain('\u0007')
    expect(r.text).toContain('Symbol not found: "zwj.ts::mi\\x07ss"')
  })
})
