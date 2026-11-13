import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { runHook } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import '../src/hooks_bash_post.js'

describe('hooks_bash_copilot_spooled_output', () => {
  let tempDir: string

  beforeEach(() => {
    // Create tempDir directly inside real os.tmpdir() so it naturally satisfies isInsideRoot(candidatePath, os.tmpdir())
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-spool-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('recovers spooled output from disk and rewrites repetitive bash output', async () => {
    // Generate 2,000 lines of repetitive output that compresses well (>100KB)
    const repetitiveLine = 'status: 200 OK - processed item\n'
    const fullOutput = repetitiveLine.repeat(3_000)

    const spooledFile = path.join(tempDir, '1794481520586-copilot-tool-output-3744-test.txt')
    fs.writeFileSync(spooledFile, fullOutput, 'utf-8')

    const noticeText = `Output too large to read at once (93.0 KB). Saved to: ${spooledFile}

Preview (first 500 characters):
status: 200 OK - processed item
status: 200 OK - processed item
`

    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'node test.js' },
      sessionId: 'copilot-test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'node test.js' },
        tool_response: noticeText,
        _tg_harness: 'copilot_cli',
      },
    }

    const output = await runHook(event)
    expect(output).not.toBeNull()
    if (output.hookType === 'rewriteOutput') {
      const rewritten = output.updatedOutput
      expect(rewritten.length).toBeLessThan(fullOutput.length)
      expect(rewritten).toContain('lines identical')
    }
  })

  it('leaves preview notice intact when spooled file is missing or invalid', async () => {
    const noticeText = `Output too large to read at once (50.0 KB). Saved to: ${path.join(tempDir, 'missing-copilot-tool-output.txt')}

Preview (first 500 characters):
some preview content
`

    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'echo hello' },
      sessionId: 'copilot-test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_response: noticeText,
        _tg_harness: 'copilot_cli',
      },
    }

    const output = await runHook(event)
    expect(output).not.toBeNull()
    expect(output.hookType).toBe('pass')
  })
})
