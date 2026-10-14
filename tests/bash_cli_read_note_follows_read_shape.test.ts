// The note a `token-goat read` gets when its file was already read with the Read tool must describe the read that happened. CAPTURE (a research session, 2026-10): after a Read of lines 225-254 of the 1,069-line src/tool_filters/helpers.ts, `token-goat read` of that file was told it "was already fully read via the Read tool this session". The fixture is HAND-DERIVED to that shape: a 400-line module read through the real Read pre hook with offset 225 and limit 30, then queried through the real Bash pre hook.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { preBashHandler } from '../src/hooks_bash.js'
import { preReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookOutput } from '../src/types.js'
import { ROOT } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

const FULL_NOTE = 'was already fully read via the Read tool'
let dir: string
let file: string
let session: string
let seq = 0

function read(input: Record<string, unknown>): HookOutput {
  return preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file, ...input }, sessionId: session, raw: { cwd: dir } }))
}

function cliRead(spec: string): HookOutput {
  return preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command: `token-goat read "${spec}"` }, sessionId: session, raw: { cwd: dir } }))
}

function context(out: HookOutput): string {
  return out.hookType === 'context' ? out.context : ''
}

beforeEach(() => {
  clearModuleCaches()
  seq += 1
  session = `cli-read-shape-${process.pid}-${seq}`
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
  dir = normalizePath(fs.mkdtempSync(path.join(ROOT, '.tmp', 'tg-cli-read-shape-')))
  file = `${dir}/helpers.ts`
  const lines = Array.from({ length: 400 }, (_, i) => (i === 230 ? 'export function byteLength(s: string): number { return Buffer.byteLength(s) }' : `export const value${i} = ${i} * 2`))
  fs.writeFileSync(file, lines.join('\n') + '\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearModuleCaches()
})

describe('the Read cross-reference on a token-goat read', () => {
  it('names the lines a ranged Read covered instead of claiming a full read', () => {
    expect(read({ offset: 225, limit: 30 }).hookType).not.toBe('deny')
    const note = context(cliRead(`${file}::byteLength`))
    expect(note).not.toContain(FULL_NOTE)
    expect(note).toContain('was partially read earlier this session (lines 225-254)')
  })

  it('stays quiet when the lines asked for are not ones the ranged Read covered', () => {
    read({ offset: 225, limit: 30 })
    expect(cliRead(`${file}@300-340`).hookType).toBe('pass')
    expect(cliRead(`${file}::360-380`).hookType).toBe('pass')
  })

  it('names the window when the lines asked for overlap it', () => {
    read({ offset: 225, limit: 30 })
    expect(context(cliRead(`${file}@240-260`))).toContain('(lines 225-254)')
  })

  it('keeps the full-read note after a whole-file Read', () => {
    read({})
    expect(context(cliRead(`${file}::byteLength`))).toContain(FULL_NOTE)
  })
})
