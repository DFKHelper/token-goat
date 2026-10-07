// The qualified retry forms printed for an ambiguous heading (`bash-output`/`web-output --section`, `insert-section --after`) wrote the heading in double quotes by hand, so a heading holding `$` was expanded by the shell the retry ran in and the retry named a heading that does not exist. They go through quotedArg now, which single-quotes such a value. Provenance: HAND-DERIVED. The documents are written out below, and each expected retry is the heading as written plus its `#N`, in single quotes because it holds `$`.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { clearModuleCaches } from '../src/reset.js'
import { resolveWindowsBash } from '../src/shell.js'
import { storeWebOutput } from '../src/web_cache.js'
import { unfence } from './helpers/unfence.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const SH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'

/** The arguments a POSIX shell hands a command for the argument text `args`, `|`-separated. */
function shArgs(sh: string, args: string): string[] {
  const res = spawnSync(sh, ['-c', 'tg() { for a in "$@"; do printf "%s|" "$a"; done; }; eval "tg $TG_ARGS"'], { encoding: 'utf8', env: { ...process.env, TG_ARGS: args }, windowsHide: true })
  return res.stdout.split('|').slice(0, -1)
}

let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  clearModuleCaches()
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  clearModuleCaches()
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

const HEADING = 'Use $HOME'
const BODY = ['# Doc', '', `## ${HEADING}`, 'first body', '', `## ${HEADING}`, 'second body', ''].join('\n')

describe('the retry form for an ambiguous heading holding $', () => {
  it('single-quotes the --section value of a cached output, and the shell hands it back as written', async () => {
    const id = storeWebOutput('https://example.com/dollar-dup', BODY)
    expect(await runCli(['web-output', id, '--section', HEADING])).toBe(1)
    const err = stderr.join('')
    expect(err).toContain(`--section '${HEADING}#1'`)
    expect(err).toContain(`--section '${HEADING}#2'`)
    expect(err).not.toContain(`--section "${HEADING}`)
    const retry = /--section ('[^']*#2')/.exec(err)?.[1] ?? ''
    if (SH !== null) expect(shArgs(SH, retry)).toEqual([`${HEADING}#2`])

    stdout.length = 0
    expect(await runCli(['web-output', id, '--section', `${HEADING}#2`])).toBe(0)
    expect(unfence(stdout.join(''))).toContain('second body')
  })

  it('keeps double quotes for a heading without $', async () => {
    const id = storeWebOutput('https://example.com/plain-dup', BODY.replaceAll(HEADING, 'Install'))
    expect(await runCli(['web-output', id, '--section', 'Install'])).toBe(1)
    expect(stderr.join('')).toContain('--section "Install#2"')
  })

  it('single-quotes the --after value of insert-section and leaves the file unchanged', async () => {
    const tmp = path.join(os.tmpdir(), `tg-retry-after-${process.pid}-${Date.now()}.md`)
    fs.writeFileSync(tmp, BODY, 'utf8')
    try {
      expect(await runCli(['insert-section', tmp, '--after', HEADING, '--content-b64', Buffer.from('## New\nx\n').toString('base64')])).toBe(1)
      const err = stderr.join('')
      expect(err).toContain(`--after '${HEADING}#1'`)
      expect(err).toContain(`--after '${HEADING}#2'`)
      expect(fs.readFileSync(tmp, 'utf8')).toBe(BODY)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })
})
