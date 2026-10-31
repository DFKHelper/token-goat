/** A cut Bash result names the exact lines it left out as `bash-output <id> --lines A-B`, checked against the stored copy, so the model gets back the missing run in one call instead of paying for the whole output again with `--full`. Provenance: the helper rows are HAND-DERIVED (line counts and spans computed by hand from the inputs written here, independent of the code); the hook and bundle rows run the real filter and the real `bash-output` command, and their expectations are the lines the generated output holds, read off the input. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getBashOutput } from '../src/bash_output_cache.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { elidedLineRange } from '../src/tool_filters/helpers.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

const POINTER = /lines not shown: bash-output (\S+) --lines (\d+)-(\d+)/

function numberedLines(n: number, label: string): string[] {
  return Array.from({ length: n }, (_, i) => `${label} ${i + 1}: compiled module-${i + 1}.ts`)
}

describe('elidedLineRange', () => {
  const stored = numberedLines(10, 'line').join('\n')
  const lines = stored.split('\n')

  it('names the run between the kept head and tail', () => {
    const shown = [...lines.slice(0, 3), '... [4 more lines elided by token-goat]', ...lines.slice(7)].join('\n')
    expect(elidedLineRange(() => stored, shown), 'lines 4-7 are the four not shown').toEqual({ from: 4, to: 7 })
  })

  it('allows the trailing token-cap notice and a final newline on the stored copy', () => {
    const shown = [...lines.slice(0, 2), '... [1 more line elided by token-goat]', ...lines.slice(3), '[token-goat: output capped at ~20 tokens]'].join('\n')
    expect(elidedLineRange(() => stored + '\n', shown), 'line 3 alone was cut').toEqual({ from: 3, to: 3 })
  })

  it('compares the stored copy with its ANSI colour stripped, as the cap measures', () => {
    const coloured = ['\u001b[32mline 1\u001b[0m', 'line 2', 'line 3', 'line 4'].join('\n')
    expect(elidedLineRange(() => coloured, ['line 1', '... [2 more lines elided by token-goat]', 'line 4'].join('\n'))).toEqual({ from: 2, to: 3 })
  })

  it('refuses when the count does not add up to the stored copy (near miss: one too many, one too few)', () => {
    const tooMany = [...lines.slice(0, 3), '... [5 more lines elided by token-goat]', ...lines.slice(7)].join('\n')
    const tooFew = [...lines.slice(0, 3), '... [3 more lines elided by token-goat]', ...lines.slice(7)].join('\n')
    expect(elidedLineRange(() => stored, tooMany), 'a marker counting one line too many').toBeNull()
    expect(elidedLineRange(() => stored, tooFew), 'a marker counting one line too few').toBeNull()
  })

  it('refuses when a kept line differs from the stored copy, before or after the marker', () => {
    const headChanged = ['line 1: rewritten by a filter', ...lines.slice(1, 3), '... [4 more lines elided by token-goat]', ...lines.slice(7)].join('\n')
    const tailChanged = [...lines.slice(0, 3), '... [4 more lines elided by token-goat]', ...lines.slice(7, 9), '[REDACTED]'].join('\n')
    expect(elidedLineRange(() => stored, headChanged), 'a head line the filter rewrote').toBeNull()
    expect(elidedLineRange(() => stored, tailChanged), 'a tail line a redaction changed').toBeNull()
  })

  it('refuses when there is no marker or more than one', () => {
    let calls = 0
    const counted = (): string => {
      calls++
      return stored
    }
    expect(elidedLineRange(counted, lines.join('\n')), 'nothing elided').toBeNull()
    const two = [lines[0], '... [2 more lines elided by token-goat]', lines[3], '... [5 more lines elided by token-goat]', lines[9]].join('\n')
    expect(elidedLineRange(counted, two), 'two elided runs are not one span').toBeNull()
    expect(calls, 'the stored copy is not read when the shown text has no single marker').toBe(0)
  })
})

describe('the Bash post hook names the lines its generic filter left out', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = saved
  })

  it('points at exactly the lines missing from the rewrite, and the stored copy holds them at those numbers', async () => {
    const all = numberedLines(900, 'build step')
    const output = all.join('\n') + '\n'
    const event: HookEvent = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command: 'grep step build.log | sort' }, sessionId: `cut-lines-${Math.random().toString(36).slice(2)}`, agentId: undefined, raw: { tool_name: 'Bash', tool_input: { command: 'grep step build.log | sort' }, tool_response: output } })
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('rewriteOutput')
    const text = result.hookType === 'rewriteOutput' ? result.updatedOutput : ''
    const m = POINTER.exec(text)
    expect(m, 'a cut rewrite names the lines it left out').not.toBeNull()
    const [from, to] = [Number(m![2]), Number(m![3])]
    const missing = all.filter((l) => !text.includes(l + '\n') && !text.endsWith(l))
    expect(missing.length, 'the span covers every line the rewrite left out').toBe(to - from + 1)
    expect(all.slice(from - 1, to), 'and only those').toEqual(missing)
    expect(getBashOutput(m![1] as string)!.output.split('\n').slice(from - 1, to)).toEqual(missing)
  })
})

describe('compress, then the printed bash-output command (built bundle)', () => {
  let dataBase: string
  let scriptDir: string
  beforeAll(() => {
    dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cut-lines-data-'))
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cut-lines-scripts-'))
  })
  afterAll(() => {
    for (const dir of [dataBase, scriptDir]) fs.rmSync(dir, { recursive: true, force: true })
  })

  function bundle(args: string[]): { status: number | null; stdout: string } {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], { env: { ...process.env, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }, encoding: 'utf8' })
    return { status: res.status, stdout: res.stdout ?? '' }
  }

  it('prints a --lines pointer that, run as printed, returns exactly the lines the cap cut', () => {
    const s = path.join(scriptDir, 'cut.js')
    fs.writeFileSync(s, "for (let i = 1; i <= 200; i++) console.log('projection-line-' + i)\n")
    const r = bundle(['compress', '--filter', 'passthrough', '--max-tokens', '200', '--cmd', `"${process.execPath}" "${s}"`])
    expect(r.status).toBe(0)
    const m = POINTER.exec(r.stdout)
    expect(m, `a capped run names the cut lines: ${r.stdout.slice(-300)}`).not.toBeNull()
    const [from, to] = [Number(m![2]), Number(m![3])]
    const shown = new Set(r.stdout.split(/\r?\n/))
    const missing = Array.from({ length: 200 }, (_, i) => `projection-line-${i + 1}`).filter((l) => !shown.has(l))
    expect(missing.length, 'the span covers every line the cap cut').toBe(to - from + 1)
    const recalled = bundle(['bash-output', m![1] as string, '--lines', `${from}-${to}`])
    expect(recalled.status).toBe(0)
    expect(recalled.stdout.split(/\r?\n/).filter((l) => l.startsWith('projection-line-')), 'bash-output --lines returns exactly the cut lines').toEqual(missing)
  })
})
