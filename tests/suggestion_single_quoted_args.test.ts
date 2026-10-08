/** A suggested command's argument must reach the command as the value it names. quotedArg always wrapped a value in double quotes, so `symbol '$zzRef'` missed and printed `Try: token-goat semantic "$zzRef"`, which bash and PowerShell both run as `semantic ""` after expanding `$zzRef`; and `answer` refused a question holding a quoted path with `try: token-goat semantic "what does "src dir/x.ts" export"`, quotes nested inside quotes. Provenance: HAND-DERIVED for the values and the argv each shell should hand the command (read off the question and symbol name alone); the two refusal lines were CAPTURED from the 2.9.30 bundle in C:/tgdog-pass2/q1b and C:/tgdog-pass2/q11. Two shells act as the oracle, independent of quotedArg: a POSIX sh and PowerShell each define a `token-goat` function that prints its argv, and run the suggested command through it. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAnswer } from '../src/answer_router.js'
import { bodyFoldNotice } from '../src/fold_delivery.js'
import { docSectionHint, grepLinesHint, quotedArg, quotedArgs, stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { sqlTableHint, surgicalHintFor } from '../src/bash_extractors.js'
import { fileQueryHint, sliceCommand } from '../src/hint_target.js'
import { buildPackageManifestHint } from '../src/hints.js'
import { handleJson, handlePdf, handlePptx, handleSqlite, handleSvg, handleTranscript, handleTxt, handleXlsx, handleYaml } from '../src/hints/file_type_handler.js'
import { extractChangelogVersionHint, extractMarkdownHeadings, formatHeadingTreeParts } from '../src/hints/markdown_hints.js'
import { realSymbolReadHint } from '../src/hooks_read.js'
import { editAnywayHint, truncatedReadDenyMessage } from '../src/hooks_read_slice.js'
import { createMcpServer } from '../src/mcp_server.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_symbol.js'
import { resolveWindowsBash } from '../src/shell.js'
import { captureStdout } from './helpers/capture-stdout.js'
import { powershellForParsing } from './helpers/powershell_parse.js'

/** Values a suggestion carries: a plain path, a spaced path, and the ones a shell would rewrite inside double quotes. */
const ROUND_TRIP_VALUES = ['src/a.ts', 'my dir/big file.ts::Sym', '$zzRef', '$(whoami)', '${HOME}', 'a`b', 'what does "src dir/x.ts" export', 'it"s', 'a\u201Db']

/** The POSIX shell and the PowerShell to run suggestions through, each null when it is not available here (PowerShell throws instead on CI). */
const SH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'
const PWSH = powershellForParsing()

/** The argv each shell hands a `token-goat` function when it runs `command`. */
function shArgv(sh: string, command: string): string[] {
  const res = spawnSync(sh, ['-c', 'token-goat() { for a in "$@"; do printf "%s|" "$a"; done; }; eval "$TG_CMD"'], { encoding: 'utf8', env: { ...process.env, TG_CMD: command }, windowsHide: true })
  if (res.status !== 0) throw new Error(`sh failed: ${res.stderr}`)
  return res.stdout.split('|').slice(0, -1)
}

function powershellArgv(exe: string, command: string): string[] {
  const script = [
    'function token-goat { $j = ConvertTo-Json -InputObject @($args | ForEach-Object { [string]$_ }) -Compress; [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }',
    'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TG_CMD)))',
  ].join('\n')
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, TG_CMD: Buffer.from(command, 'utf8').toString('base64') }, timeout: 60_000, windowsHide: true })
  if (res.status !== 0) throw new Error(`PowerShell failed: ${res.stderr}`)
  return JSON.parse(Buffer.from(res.stdout.trim(), 'base64').toString('utf8')) as string[]
}

describe('quotedArg', () => {
  it('double-quotes a value no shell rewrites, so every existing suggestion keeps its form', () => {
    expect(quotedArg('src/a.ts')).toBe('"src/a.ts"')
    expect(quotedArg('my dir/big file.ts::Sym')).toBe('"my dir/big file.ts::Sym"')
  })

  it('single-quotes a value holding $, a backtick or a double quote', () => {
    expect(quotedArg('$zzRef')).toBe("'$zzRef'")
    expect(quotedArg('a`b')).toBe("'a`b'")
    expect(quotedArg('what does "src dir/x.ts" export')).toBe(`'what does "src dir/x.ts" export'`)
  })

  it('quotes a symbol name holding $ in the folded-body notice a read prints', () => {
    expect(bodyFoldNotice('$zzFolded', 4, 9, 'src/a.ts', 3)).toBe("... 6 more lines of $zzFolded (4-9) folded -- token-goat read 'src/a.ts::$zzFolded@3'")
    expect(bodyFoldNotice('zzPlain', 4, 9, 'src/a.ts', 3)).toBe('... 6 more lines of zzPlain (4-9) folded -- token-goat read "src/a.ts::zzPlain@3"')
  })

  it('writes the placeholder when neither quote mark could hold the value, since double quotes would substitute the $', () => {
    expect(quotedArg("it's $5")).toBe('"<a value no quote mark can hold>"')
    expect(quotedArg('a\u2019$b')).toBe('"<a value no quote mark can hold>"')
    expect(quotedArg('a\n$b')).toBe('"<a value no quote mark can hold>"')
  })

  it.skipIf(SH === null)('a POSIX shell hands the command every value unchanged', () => {
    for (const value of ROUND_TRIP_VALUES) expect(shArgv(SH!, `token-goat semantic ${quotedArg(value)}`)).toEqual(['semantic', value])
  })

  it.skipIf(PWSH === null)('PowerShell hands the command every value unchanged', () => {
    for (const value of ROUND_TRIP_VALUES) expect(powershellArgv(PWSH!, `token-goat semantic ${quotedArg(value)}`)).toEqual(['semantic', value])
  })
})

// HAND-DERIVED: the paths name what a shell rewrites inside double quotes; the placeholders and key names are the ones the templates print. A `$name` path keeps its command single-quoted; a backtick closes the fence around the command and `$(` runs a command if a retyped suggestion loses its quotes, so those two lose the command and keep the sentence.
const METACHAR_PATHS = ['src/a$b.ts']
const FENCE_BREAKING_PATHS = ['src/a`b.ts', 'src/a$(id).ts']

/** `text` as relay.ts passes it on, checked to have lost its command but kept the sentence before it. */
function expectCommandDropped(text: string, name: string, p: string): void {
  const out = stripUnsafeSuggestions(text)
  const payload = p.slice('src/a'.length, p.indexOf('.ts'))
  expect.soft(out, name).toContain('token-goat (command omitted: the path contains shell metacharacters)')
  expect.soft(out, name).not.toContain(payload)
  expect.soft(out, name).toContain(text.slice(0, text.indexOf('token-goat ')))
}

describe('stripUnsafeSuggestions on single-quoted arguments', () => {
  it('drops a fenced command whose backtick path closed the fence inside its quotes', () => {
    expect(stripUnsafeSuggestions("Run `token-goat outline 'a`id`.ts'` to list it.")).toBe('Run `token-goat (command omitted: the path contains shell metacharacters)` to list it.')
  })

  it('drops a command holding $( however it is quoted, and keeps a $name', () => {
    expect(stripUnsafeSuggestions("Run `token-goat outline 'a$(id).ts'` to list it.")).toBe('Run `token-goat (command omitted: the path contains shell metacharacters)` to list it.')
    expect(stripUnsafeSuggestions("Run `token-goat outline 'a$b.ts'` to list it.")).toBe("Run `token-goat outline 'a$b.ts'` to list it.")
  })

  it('leaves no tail of the path behind when the dropped command was not fenced', () => {
    expect(stripUnsafeSuggestions("Then extract relevant pages: token-goat pdf-extract 'src/a`b.pdf' --pages '<range>'")).toBe('Then extract relevant pages: token-goat (command omitted: the path contains shell metacharacters)')
    expect(stripUnsafeSuggestions('Then: token-goat pdf-extract "src/a`b.pdf" --pages "<range>"')).toBe('Then: token-goat (command omitted: the path contains shell metacharacters)')
  })

  it("leaves prose holding an apostrophe alone, as the double-quote rule does (token-goat OCR'd)", () => {
    const text = "token-goat OCR'd shot.png instead of shrinking it: `text-heavy`"
    expect(stripUnsafeSuggestions(text)).toBe(text)
  })

  it('leaves the closing quote of a string in code alone (src/bridges/claudecode.ts)', () => {
    const text = "const out = spawnSync('token-goat hook ' + eventName, { input: `x` })"
    expect(stripUnsafeSuggestions(text)).toBe(text)
  })
})

describe('quotedArgs', () => {
  it('double-quotes every argument when none needs single quotes', () => {
    expect(quotedArgs('src/a.ts', '<base64>')).toEqual(['"src/a.ts"', '"<base64>"'])
  })

  it('single-quotes every argument when one needs it, so no double quote sits beside the $ or backtick', () => {
    expect(quotedArgs('src/a$b.ts', '<base64>')).toEqual(["'src/a$b.ts'", "'<base64>'"])
  })

  it('keeps double quotes for all when one argument cannot hold single quotes, writing the placeholder for a $ argument', () => {
    expect(quotedArgs('src/a$b.json', "['a.b']")).toEqual(['"<a value no quote mark can hold>"', `"['a.b']"`])
  })

  it.skipIf(SH === null)('a POSIX shell hands the edit-anyway replace command its path and placeholders unchanged', () => {
    const command = /`(token-goat replace [^\n]*?)` \(preferred/.exec(editAnywayHint('src/a$b.ts'))?.[1] ?? ''
    expect(shArgv(SH!, command)).toEqual(['replace', 'src/a$b.ts', '--old-b64', '<base64>', '--new-b64', '<base64>'])
  })

  it.skipIf(PWSH === null)('PowerShell hands the edit-anyway replace command its path and placeholders unchanged', () => {
    const command = /`(token-goat replace [^\n]*?)` \(preferred/.exec(editAnywayHint('src/a$b.ts'))?.[1] ?? ''
    expect(powershellArgv(PWSH!, command)).toEqual(['replace', 'src/a$b.ts', '--old-b64', '<base64>', '--new-b64', '<base64>'])
  })
})

describe('deny and hint templates around a path holding $ or a backtick, as relay.ts passes them on', () => {
  const templates = (p: string): Array<[string, string]> => [
    ['editAnywayHint', editAnywayHint(p)],
    ['truncatedReadDenyMessage', truncatedReadDenyMessage(p)],
    ['sliceCommand section', sliceCommand(p, { name: 'Install', real: true, slice: 'section' })],
    ['sliceCommand symbol', sliceCommand(p, { name: 'parseFile', real: true, slice: 'symbol' })],
    ['sliceCommand json key', sliceCommand(p + '.json', { name: 'version', real: true, slice: 'key' })],
    ['sliceCommand config key', sliceCommand(p + '.env', { name: 'API_URL', real: true, slice: 'key' })],
    ['grepLinesHint', grepLinesHint('<pattern>', p, 'Read loads the whole file.')],
    ['docSectionHint', docSectionHint(p + '.md', 'Install', 'Read loads the whole file.')],
  ]

  it.each(METACHAR_PATHS)('keeps every command for %s', (p) => {
    for (const [name, text] of templates(p)) {
      expect.soft(stripUnsafeSuggestions(text), name).toBe(text)
      expect.soft(text, name).not.toContain('"')
    }
  })

  it.each(FENCE_BREAKING_PATHS)('drops every command and keeps the sentence for %s', (p) => {
    for (const [name, text] of templates(p)) expectCommandDropped(text, name, p)
  })

  it('names every edit route for a $ path, the placeholders quoted like the path', () => {
    expect(stripUnsafeSuggestions(editAnywayHint('src/a$b.ts'))).toBe(
      "To edit it anyway, use `token-goat replace 'src/a$b.ts' --old-b64 '<base64>' --new-b64 '<base64>'` (preferred — no temp files needed) or `--old-from '<oldfile>' --new-from '<newfile>'` for a snippet edit, or `token-goat write-file 'src/a$b.ts' --b64 '<base64>'` (or `--from '<newfile>'`) to rewrite the whole file — Read/Edit's own precondition can't be satisfied after this deny.",
    )
  })

  it('still drops a command whose arguments single quotes cannot all hold', () => {
    const text = sliceCommand('src/a$b.json', { name: 'a.b', real: true, slice: 'key' })
    expect(stripUnsafeSuggestions(text)).toBe('token-goat (command omitted: the path contains shell metacharacters)')
  })
})

// HAND-DERIVED: the paths are the METACHAR_PATHS and FENCE_BREAKING_PATHS above, and the expected shapes (a single-quoted path the relay guard keeps, or a dropped command with its sentence kept) follow from the quoting rule, not from the templates' output.
describe('file-type, shell-read, grep and markdown hints around a path holding $ or a backtick', () => {
  const BIG = 10_000_000
  const templates = (p: string): Array<[string, string]> => {
    const base = p.replace(/\.ts$/, '')
    return [
      ['handlePdf', handlePdf(base + '.pdf', 1000).message],
      ['handleXlsx', handleXlsx(base + '.xlsx').message],
      ['handlePptx', handlePptx(base + '.pptx').message],
      ['handleSqlite', handleSqlite(base + '.db').message],
      ['handleJson spill', handleJson(base + '/content.json', '', BIG).message],
      ['handleYaml', handleYaml(base + '.yaml', '', BIG).message],
      ['handleTxt log', handleTxt(base + '.log', '', BIG).message],
      ['handleSvg', handleSvg(base + '.svg', '', BIG).message],
      ['handleTranscript', handleTranscript(base + '.vtt', '', BIG).message],
      ['surgicalHintFor json key', surgicalHintFor(base + '.json', false, true, false, false, { name: 'version', real: true, slice: 'key' })],
      ['surgicalHintFor xml', surgicalHintFor(base + '.xml', false, false, false, true, { name: 'root', real: true, slice: 'symbol' })],
      ['surgicalHintFor source', surgicalHintFor(p, false, false, false, false, { name: 'parseFile', real: true, slice: 'symbol' })],
      ['sqlTableHint', sqlTableHint(base + '.sql', { name: 'users', real: true, slice: 'symbol' })],
      ['fileQueryHint json', fileQueryHint(base + '.json')],
      ['fileQueryHint xml', fileQueryHint(base + '.xml')],
      ['buildPackageManifestHint', buildPackageManifestHint({ file_path: base + '/package.json', shown: base + '/package.json' })?.text ?? ''],
      ['extractChangelogVersionHint', extractChangelogVersionHint('## [Unreleased]\n\n## [1.2.3]\n', base + '/CHANGELOG.md')],
      ['formatHeadingTreeParts', formatHeadingTreeParts(extractMarkdownHeadings('# Intro\n\n## Usage\n'), base + '.md').guidance],
      ['realSymbolReadHint', realSymbolReadHint(p, p)],
      ['realSymbolReadHint range', realSymbolReadHint(p, p, { start: 3, end: 9 })],
    ]
  }

  it.each(METACHAR_PATHS)('keeps every command, the path single-quoted, for %s', (p) => {
    const lead = p.slice(0, 5)
    for (const [name, text] of templates(p)) {
      expect.soft(text, name).toContain("'" + lead)
      expect.soft(text, name).not.toContain('"' + lead)
      expect.soft(stripUnsafeSuggestions(text), name).toBe(text)
    }
  })

  it.each(FENCE_BREAKING_PATHS)('drops every command and keeps the sentence for %s', (p) => {
    for (const [name, text] of templates(p)) expectCommandDropped(text, name, p)
  })

  it('leaves a plain path double-quoted, as before', () => {
    for (const [name, text] of templates('src/plain.ts')) {
      expect.soft(text, name).toContain('"src/plain')
      expect.soft(text, name).not.toContain("'src/plain")
    }
  })
})

describe('suggestions built from the caller text', () => {
  let project: string
  let previousCwd: string

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'tg-single-quoted-'))
    writeFileSync(join(project, 'package.json'), '{"name":"single-quoted"}\n')
    mkdirSync(join(project, 'src'))
    const file = join(project, 'src', 'present.ts')
    writeFileSync(file, 'export function zzPresentOne(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(file))
    previousCwd = process.cwd()
    process.chdir(project)
  })

  afterAll(() => {
    process.chdir(previousCwd)
    rmSync(project, { recursive: true, force: true })
  })

  it('a symbol miss for a name holding $ suggests semantic with the name single-quoted', () => {
    const r = runSymbol({ name: '$zzRefNope' })
    expect(r.code).toBe(1)
    expect(r.text).toContain("Try: token-goat semantic '$zzRefNope'")
    expect(r.text).not.toContain('"$zzRefNope"')
  })

  it('an answer refusal over a question holding a quoted path suggests semantic with no nested quotes', () => {
    let err = ''
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      if (typeof chunk === 'string') err += chunk
      return true
    }) as typeof process.stderr.write
    let code = -1
    captureStdout(() => {
      try {
        code = runAnswer({ question: 'what does "src dir/none here.ts" export' })
      } finally {
        process.stderr.write = origErr
      }
    })
    expect(code).toBe(1)
    expect(err).toContain(`try: token-goat semantic 'what does "src dir/none here.ts" export'`)
  })

  it('an MCP client is told to retry with the single-quoted name as a tool parameter', async () => {
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({ name: 'symbol', arguments: { name: '$zzMcpNope', projectRoot: project } })
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
      expect(text).toContain('the "semantic" tool again with a more specific query (e.g. "$zzMcpNope")')
      expect(text).not.toContain("semantic '$zzMcpNope'")
    } finally {
      await client.close()
      await server.close()
    }
  })
})
