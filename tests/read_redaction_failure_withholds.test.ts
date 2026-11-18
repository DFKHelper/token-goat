/** A redactor that throws must withhold its text, and a hook that meets it must still answer valid JSON. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SecretRedact from '../src/secret_redact.js'

vi.mock('../src/secret_redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SecretRedact>()
  const fail = (): never => {
    throw new Error('injected redactor failure')
  }
  return { ...actual, redactSecrets: fail, redactCutSecrets: fail, redactSerializedJson: fail }
})

import {
  guardRedactAndFence,
  redactReadJson,
  redactReadLines,
  redactReadText,
  WITHHELD_PLACEHOLDER,
} from '../src/fence_cap.js'
import { escapeHintName } from '../src/hint_target.js'
import { relayInProcess } from '../src/relay.js'
import { guardText } from '../src/read_commands.js'

const RAW = 'RAWMARKER_visible_if_unredacted_0123456789'

let project: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_ENTRYPOINT']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  process.env['CLAUDE_CODE_ENTRYPOINT'] = 'claude-vscode'
  project = mkdtempSync(join(tmpdir(), 'tg-redactor-fails-'))
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(project, { recursive: true, force: true })
})

describe('the read-path redaction chokepoints withhold on a redactor failure', () => {
  it('redactReadText returns the placeholder, never the raw text', () => {
    expect(redactReadText(RAW)).toBe(WITHHELD_PLACEHOLDER)
  })

  it('guardText prints the placeholder, never the raw text', () => {
    const out = guardText(RAW, 'read')
    expect(out).not.toContain(RAW)
    expect(out).toContain(WITHHELD_PLACEHOLDER)
  })

  it('guardRedactAndFence prints the placeholder inside the fence, never the raw text', () => {
    const out = guardRedactAndFence(RAW, 'doc', 'untrusted_file')
    expect(out).not.toContain(RAW)
    expect(out).toContain(WITHHELD_PLACEHOLDER)
  })

  it('redactReadLines and redactReadJson carry no raw text', () => {
    expect(redactReadLines([RAW, RAW]).join('\n')).not.toContain(RAW)
    expect(redactReadJson({ lines: [RAW], text: RAW })).not.toContain(RAW)
  })

  it('a hint that names stored text drops the name instead of failing', () => {
    expect(escapeHintName(RAW)).toBe('')
  })
})

describe('a hook that meets the failure still answers with valid JSON', () => {
  const base = (tool: string): Record<string, unknown> => ({
    session_id: `redactor-fails-${Math.random().toString(36).slice(2, 10)}`,
    cwd: project,
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_use_id: 'toolu_redactor_fails',
  })

  it('a Bash result', async () => {
    const response = { stdout: `${RAW}\n`.repeat(300), stderr: '', interrupted: false }
    const out = await relayInProcess('post_tool_use', {
      ...base('Bash'),
      tool_input: { command: 'ls' },
      tool_response: response,
    })
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).not.toContain(RAW)
  })

  it('a Grep content result', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `src/a.ts:${i + 1}:${RAW}`).join('\n')
    const response = { mode: 'content', content: lines, numLines: 20 }
    const out = await relayInProcess('post_tool_use', {
      ...base('Grep'),
      tool_input: { pattern: 'x', output_mode: 'content' },
      tool_response: response,
    })
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).not.toContain(RAW)
  })
})
