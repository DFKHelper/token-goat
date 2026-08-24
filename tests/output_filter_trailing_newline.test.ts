/**
 * Cached-output recall counted a line that does not exist.
 *
 * Almost every captured blob ends in a newline, and `content.split(/\r?\n/)` turns that final
 * newline into a trailing empty string. The narrowing paths in `_applyFiltersAndPrint` all
 * measured from `lines.length`, so that phantom entry cost one real line every time: `--tail N`
 * returned N-1 lines, `--tail 1` returned nothing at all, and the default 30/80 elision silently
 * dropped the last line of every long capture -- the line most likely to hold the exit status or
 * the error a caller came back for.
 *
 * `bash-output --file` is the driver here because it runs the exact shared filter code that
 * `bash-output <id>`, `web-output`, `mcp-output`, and `retrieve` all reach, without needing a
 * seeded blob store.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

let home: string
let envRoot: string
const saved: Record<string, string | undefined> = {}
const VARS = ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME']

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-tail-nl-'))
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v] as string
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Writes `text` to a scratch file and recalls it through the shared output filters. */
function recall(text: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(home, 'captured.txt')
  fs.writeFileSync(file, text)
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, 'bash-output', '--file', file, ...args], {
    env,
    encoding: 'utf8',
    cwd: home,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** N numbered lines with the trailing newline a real captured blob ends with. */
function blob(n: number): string {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) lines.push(`line ${i}`)
  return lines.join('\n') + '\n'
}

/** Non-empty output lines, so a trailing blank from the print itself is not counted as content. */
function bodyLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((l) => l !== '')
}

describe('output filters on content that ends in a newline', () => {
  it('--tail N returns N real lines, not N-1', () => {
    const r = recall(blob(10), ['--tail', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(bodyLines(r.stdout), '--tail 3 must return three real lines, not two plus a phantom').toEqual([
      'line 8',
      'line 9',
      'line 10',
    ])
  })

  it('--tail 1 returns the last line instead of nothing', () => {
    const r = recall(blob(10), ['--tail', '1'])
    expect(r.status, r.stderr).toBe(0)
    expect(bodyLines(r.stdout), '--tail 1 returned an empty phantom line and no content at all').toEqual(['line 10'])
  })

  it('shows a full 80-line tail window under the default elision', () => {
    // No narrowing flag at all: the 30/80 head/tail window applies. The phantom entry occupied
    // one of the 80 tail slots, so the window opened one line late -- the oldest line of the
    // tail, not the newest, was the one silently lost.
    const r = recall(blob(200), [])
    expect(r.status, r.stderr).toBe(0)
    const lines = bodyLines(r.stdout)
    expect(r.stdout, 'fixture must be long enough to elide').toContain('...(elided)...')
    expect(lines[lines.length - 1]).toBe('line 200')
    expect(lines, 'the 80-line tail window must start at line 121, not 122').toContain('line 121')
    expect(lines.filter((l) => /^line \d+$/.test(l)), 'a 30-line head plus an 80-line tail is 110 lines').toHaveLength(
      110,
    )
  })

  it('--head N is unaffected and still returns the first N lines', () => {
    const r = recall(blob(10), ['--head', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(bodyLines(r.stdout)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('--full still returns the blob verbatim, trailing newline and all', () => {
    // --full deliberately keeps the raw split: it is the lossless escape hatch other commands
    // point recovery instructions at, so trimming anything there would be its own regression.
    const text = blob(200)
    const r = recall(text, ['--full'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('line 200')
    expect(r.stdout).not.toContain('...(elided)...')
    expect(r.stdout.replace(/\r\n/g, '\n')).toBe(text)
  })

  it('content with no trailing newline is unchanged', () => {
    const r = recall('alpha\nbeta\ngamma', ['--tail', '2'])
    expect(r.status, r.stderr).toBe(0)
    expect(bodyLines(r.stdout)).toEqual(['beta', 'gamma'])
  })
})
