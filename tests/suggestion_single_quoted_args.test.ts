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
import { quotedArg } from '../src/hint_suggestion_guard.js'
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

  it('keeps double quotes when single quotes could not hold the value either', () => {
    expect(quotedArg("it's $5")).toBe(`"it's $5"`)
    expect(quotedArg('a\u2019$b')).toBe('"a\u2019$b"')
    expect(quotedArg('a\n$b')).toBe('"a\n$b"')
  })

  it.skipIf(SH === null)('a POSIX shell hands the command every value unchanged', () => {
    for (const value of ROUND_TRIP_VALUES) expect(shArgv(SH!, `token-goat semantic ${quotedArg(value)}`)).toEqual(['semantic', value])
  })

  it.skipIf(PWSH === null)('PowerShell hands the command every value unchanged', () => {
    for (const value of ROUND_TRIP_VALUES) expect(powershellArgv(PWSH!, `token-goat semantic ${quotedArg(value)}`)).toEqual(['semantic', value])
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
      expect(text).toContain('the "semantic" tool again with a more specific parameter (e.g. "$zzMcpNope")')
      expect(text).not.toContain("semantic '$zzMcpNope'")
    } finally {
      await client.close()
      await server.close()
    }
  })
})
