/** A carriage return in the middle of a line is either a terminal redraw (a progress bar writing over itself) or a CRLF file that a `tr '\n' ','`, `paste -sd` or `print(end='')` turned into one line, where each `\r` is the leftover half of a line ending. stripProgress used to treat every one as a redraw and keep only the text after the last `\r`. CAPTURE (recorded session 62fb4509, seq 372): `tr '\n' ',' < cb_emails.txt | sed 's/,$//'` over a 168-address CRLF file reached the model as the single address `,zperdue01@gmail.com` under `generic filter -99%`, and the next call had to switch compression off and recall the output in full. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { normalise, stripProgress } from '../src/tool_filters/helpers.js'
import { BUNDLE } from './helpers/bundle.js'

const addresses = (n: number): string[] => Array.from({ length: n }, (_, i) => `user${i}@example.com`)

describe('stripProgress keeps CR-separated data', () => {
  it('keeps every entry of a list joined across CRLF line endings', () => {
    expect(stripProgress('a@x.com\r,b@y.com\r,c@z.com')).toBe('a@x.com,b@y.com,c@z.com')
  })

  it('keeps all 168 entries of the recorded BCC-list shape, through the whole normalise pipeline', () => {
    const list = addresses(168)
    // `tr '\n' ','` over a CRLF file, then `sed 's/,$//'`: each entry keeps its `\r`, the last one included.
    const out = normalise(list.map((a) => a + '\r').join(','))
    expect(out).toBe(list.join(','))
  })

  it('keeps entries that carry a percentage or a number, which only look like progress one at a time', () => {
    expect(stripProgress('mug,10%\r,tote,20%\r,card,5%')).toBe('mug,10%,tote,20%,card,5%')
    expect(stripProgress('#1001\r,#1002\r,#1003')).toBe('#1001,#1002,#1003')
  })

  it('keeps entries that share only a short or digit-free prefix', () => {
    expect(stripProgress('alice@x.com\rbob@y.com\rcarol@z.com')).toBe('alice@x.com' + 'bob@y.com' + 'carol@z.com')
    expect(stripProgress('https://a.example/one\rhttps://a.example/two')).toBe('https://a.example/one' + 'https://a.example/two')
  })
})

describe('stripProgress still collapses a terminal redraw', () => {
  it('collapses a bare percentage redraw to its final state', () => {
    expect(stripProgress('10%\r50%\r100%')).toBe('100%')
    expect(stripProgress('10%\r50%\r100%\r')).toBe('100%')
  })

  it('collapses a redraw of one line whose only change is its numbers', () => {
    expect(stripProgress('step1\rstep2')).toBe('step2')
    expect(stripProgress('\rProcessed 100 rows\rProcessed 2000 rows')).toBe('Processed 2000 rows')
  })

  // HAND-DERIVED from the renderers' own formats: npm's braille spinner, pip's legacy block bar with rate and ETA, curl's progress meter.
  it('collapses an npm spinner line', () => {
    const line = '\u280b idealTree: timing idealTree:#root\r\u2819 idealTree: timing idealTree:#root\r\u2839 reify: timing reify:audit Completed in 1ms'
    expect(stripProgress(line)).toBe('\u2839 reify: timing reify:audit Completed in 1ms')
  })

  it('collapses a pip download bar', () => {
    const bar = (n: number): string => '\u2588'.repeat(n) + ' '.repeat(32 - n)
    const line = `\r     |${bar(4)}| 10 kB 1.2 MB/s eta 0:00:01\r     |${bar(20)}| 30 kB 2.4 MB/s eta 0:00:01\r     |${bar(32)}| 40 kB 3.4 MB/s`
    expect(stripProgress(line)).toBe(`     |${bar(32)}| 40 kB 3.4 MB/s`)
  })

  it('collapses a curl progress meter and leaves its header lines alone', () => {
    const header = '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed'
    const meter =
      '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r100  1256  100  1256    0     0   3420      0 --:--:-- --:--:-- --:--:--  3426'
    expect(stripProgress(header + '\n' + meter)).toBe(header + '\n100  1256  100  1256    0     0   3420      0 --:--:-- --:--:-- --:--:--  3426')
  })
})

describe('compress -f generic over CR-separated data (built-bundle e2e)', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cr-list-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('delivers every entry of a CRLF fixture joined onto one line', () => {
    // 40 entries keep the joined line under LONG_LINE_MAX_CHARS, so the only thing that can drop an entry is the CR handling under test.
    const list = addresses(40)
    const fixture = path.join(dir, 'emails.txt')
    fs.writeFileSync(fixture, list.map((a) => a + '\r\n').join(''))
    // The `tr '\n' ',' < emails.txt | sed 's/,$//'` of the recorded session, done in node so the command runs the same under every shell.
    const script = path.join(dir, 'join.js')
    fs.writeFileSync(script, `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8').split('\\n').join(',').replace(/,$/, ''))\n`)
    const res = spawnSync(process.execPath, [BUNDLE, 'compress', '-f', 'generic', '--cmd', `"${process.execPath}" "${script}"`], {
      env: { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir },
      encoding: 'utf8',
    })
    expect(res.status, res.stderr).toBe(0)
    for (const a of list) expect(res.stdout).toContain(a)
    expect(res.stdout).not.toContain('generic filter')
  })
})
