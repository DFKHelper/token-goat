/** Claude Code's PowerShell tool runs a command the way the Bash tool does and got none of token-goat's output handling: the post hook registered for `Bash` alone, so the generated matcher never named PowerShell. CAPTURE (recorded sessions): 372 PowerShell results, 0 compressed, fenced or stored for recall; `doctor` listed "PowerShell (130x)" among tools with no handler. The result shape below is CAPTURE too, read off `toolUseResult` on PowerShell tool results in this machine's transcripts: `{ stdout, stderr, interrupted, isImage }`, with stderr folded into stdout and CRLF line endings. The pre hook's checks for this tool are in tests/powershell_tool_shell_parity.test.ts. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Importing relay registers every hook module for its side effects, so the matcher and runHook below are the production registry's.
import { buildEvent } from '../src/relay.js'
import { runHook, serializeOutput, toolMatcherFor, type HookEvent } from '../src/hook_registry.js'
import { categoryStats } from '../src/hint_stats.js'
import { BUNDLE } from './helpers/bundle.js'
import { withoutFenceNonces } from './helpers/fence_nonce.js'
import { rewrittenBody, rewrittenKeys } from './helpers/updated-tool-output.js'

/** About 10 KB of `Get-ChildItem -Recurse` output: distinct paths, CRLF-terminated, as the PowerShell tool returns it. */
const LISTING = Array.from({ length: 160 }, (_, i) => `C:\\Projects\\shop\\assets\\stickers\\sheet-${String(i).padStart(3, '0')}-washi-pastel-collection.png`).join('\r\n') + '\r\n'

let tmpHome: string
let prevHome: string | undefined
let prevHarness: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  prevHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pwsh-post-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  if (prevHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevHarness
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function powerShellEvent(command: string, stdout: string): HookEvent {
  return buildEvent('post_tool_use', {
    tool_name: 'PowerShell',
    tool_input: { command, description: 'List the sticker sheets' },
    session_id: `pwsh-${Math.random().toString(36).slice(2)}`,
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  })
}

describe("Claude Code's PowerShell tool", () => {
  it('is in the generated PostToolUse matcher', () => {
    expect((toolMatcherFor('post_tool_use') ?? '').split('|')).toContain('^PowerShell$')
  })

  it('gets a large output back compressed, fenced, and in its own result shape', async () => {
    const event = powerShellEvent('Get-ChildItem -Recurse assets | Select-Object -ExpandProperty FullName', LISTING)
    expect(Buffer.byteLength(LISTING)).toBeGreaterThan(10_000)
    const result = await runHook(event)
    expect(result.hookType).toBe('rewriteOutput')
    const wire = JSON.parse(serializeOutput(result, 'post_tool_use', 'claudecode', event)) as { hookSpecificOutput: { updatedToolOutput: unknown } }
    const updated = wire.hookSpecificOutput.updatedToolOutput
    // An object, the tool's own shape with stdout replaced: Claude Code rejects a bare string for a built-in tool.
    expect(rewrittenKeys(updated)).toEqual(['stdout', 'stderr', 'interrupted', 'isImage'])
    const body = withoutFenceNonces(rewrittenBody(updated))
    const close = body.indexOf('</untrusted-tool-output>')
    expect(body.indexOf('<untrusted-tool-output>')).toBeGreaterThanOrEqual(0)
    expect(close).toBeGreaterThan(0)
    expect(body).toContain('sheet-000-washi-pastel-collection.png')
    // token-goat's own lines sit after the fence closes: the marker and the recall pointer.
    expect(body.indexOf('[token-goat: generic filter')).toBeGreaterThan(close)
    expect(body).toMatch(/\[token-goat\] full output: bash-output [0-9a-f]{16} --full$/)
    expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(LISTING))
  })

  it('reads PowerShell names as PowerShell, so `ls` is not handed to the ls filter', async () => {
    const result = await runHook(powerShellEvent('ls -Recurse assets', LISTING))
    expect(result.hookType).toBe('rewriteOutput')
    const body = result.hookType === 'rewriteOutput' ? result.updatedOutput : ''
    expect(body).toContain('[token-goat: generic filter')
    expect(body).not.toContain('ls filter')
  })

  it('passes a small output through', async () => {
    expect((await runHook(powerShellEvent('Get-Date -Format HH:mm', '13:23\r\n'))).hookType).toBe('pass')
  })

  it('points a result the harness persisted at its recall id, and credits a recall run through PowerShell', async () => {
    // Under the generic filter's 2,000-token cap, so nothing compresses it and the advisory is what answers. Persisted, as Claude Code reports a result it did not show inline; the path names no file, so the hook reads `stdout`.
    const listing = LISTING.split('\r\n').slice(0, 70).join('\r\n') + '\r\n'
    const first = powerShellEvent('Get-ChildItem -Recurse assets', listing)
    ;(first.raw['tool_response'] as Record<string, unknown>)['persistedOutputPath'] = 'C:/nowhere/tool-results/pwsh.txt'
    const hint = await runHook(first)
    const id = hint.hookType === 'context' ? /`token-goat bash-output ([0-9a-f]{16})` recalls it\./.exec(hint.context)?.[1] : undefined
    expect(id, JSON.stringify(hint)).toBeDefined()
    expect(hint.hookType === 'context' ? hint.context : '').not.toContain('compress -c')
    const recall = buildEvent('post_tool_use', {
      tool_name: 'PowerShell',
      tool_input: { command: `token-goat bash-output ${id} --full` },
      session_id: first.sessionId,
      tool_response: { stdout: listing, stderr: '', interrupted: false, isImage: false },
    })
    await runHook(recall)
    expect(categoryStats('bash_large_output', first.sessionId)).toMatchObject({ emitted: 1, actedOn: 1 })
  })

  it("honours the opt-out the marker names, in PowerShell's spelling", async () => {
    const result = await runHook(powerShellEvent("$env:TOKEN_GOAT_BASH_COMPRESS = '0'; Get-ChildItem -Recurse assets", LISTING))
    expect(result.hookType).toBe('pass')
  })
})

describe("Claude Code's PowerShell tool (built-bundle e2e)", () => {
  it('reaches the post hook in the shipped artifact', () => {
    const payload = {
      session_id: 'pwsh-bundle',
      hook_event_name: 'PostToolUse',
      cwd: tmpHome,
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-ChildItem -Recurse assets' },
      tool_response: { stdout: LISTING, stderr: '', interrupted: false, isImage: false },
    }
    const env = { ...process.env, TOKEN_GOAT_HOME: tmpHome, LOCALAPPDATA: tmpHome, XDG_DATA_HOME: tmpHome, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '1', TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode' }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf-8', env })
    expect(res.status, res.stderr).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { updatedToolOutput?: unknown } }
    const body = withoutFenceNonces(rewrittenBody(parsed.hookSpecificOutput?.updatedToolOutput))
    expect(body).toContain('</untrusted-tool-output>')
    expect(body).toContain('full output: bash-output')
  })
})
