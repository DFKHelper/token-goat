/**
 * Copilot CLI on Windows runs shell commands through a tool named `powershell` whose arguments are `{command, description}`. The shim maps that name onto token-goat's `Bash` pathway, so the Bash pre and post handlers must receive the command and the output from the payload Copilot really sends: the command under `tool_input.command`, where extractCommand reads it, and the output where the post-Bash handler's OUTPUT_FIRST_TOOL_RESPONSE_KEYS lookup finds it.
 *
 * PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88/C6-004-preToolUse-powershell.json and C6-006-postToolUse-powershell.json (from %TEMP%/tg-captures/C6/raw/004-preToolUse-powershell.json and 006-postToolUse-powershell.json, Copilot CLI 1.0.88 on Windows). The fake token-goat records the stdin the installed shim hands it, so the assertions are on the bytes a shipped shim sends; the forwarded payload is then shaped into a HookEvent by relay.ts's own buildEvent, the function the hook entry uses.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installCopilotHooksFile, HOOKS_SCRIPT_FILE } from '../src/bridges/copilot_cli_install.js'
import { buildEvent } from '../src/relay.js'
import { extractCommand } from '../src/hooks_bash_commands.js'
import { extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from '../src/hooks_common.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'

const CAPTURED_COMMAND = 'echo TGCAP-C6-ORIG-OUT-a1b2 .'
const CAPTURED_OUTPUT = 'TGCAP-C6-ORIG-OUT-a1b2\n.\n<shellId: 0 completed with exit code 0>'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function mkTemp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Runs the shim the real installer wrote, with a fake `token-goat` first on PATH that records its stdin, and returns what the shim forwarded. The shim is given no bundle path, so it falls back to `token-goat` on PATH. */
function forward(event: string, fixture: string): Record<string, unknown> {
  const proj = mkTemp('tg-copilot-pwsh-ws-')
  const hooksDir = mkTemp('tg-copilot-pwsh-hooks-')
  const binDir = mkTemp('tg-copilot-pwsh-bin-')
  installCopilotHooksFile(hooksDir, 'copilot')
  const capturePath = path.join(binDir, 'captured-stdin.json')
  const scriptPath = path.join(binDir, 'capture.cjs')
  fs.writeFileSync(
    scriptPath,
    `const fs = require('fs')\nlet buf = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { buf += c })\nprocess.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(capturePath)}, buf); process.stdout.write('{}') })\n`,
    'utf8',
  )
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'token-goat.cmd'), `@echo off\r\nnode "${scriptPath}"\r\n`, 'utf8')
  } else {
    const sh = path.join(binDir, 'token-goat')
    fs.writeFileSync(sh, `#!/bin/sh\nexec node '${scriptPath}'\n`, 'utf8')
    fs.chmodSync(sh, 0o755)
  }
  const res = spawnSync(process.execPath, [path.join(hooksDir, HOOKS_SCRIPT_FILE), event], {
    cwd: proj,
    input: JSON.stringify(copilotCapture(fixture, { proj })),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PATH: binDir + path.delimiter + (process.env['PATH'] ?? '') },
  })
  expect(res.status, res.stderr).toBe(0)
  expect(fs.existsSync(capturePath), 'the shim never ran token-goat').toBe(true)
  return JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
}

describe('Copilot CLI powershell tool reaches the Bash pathway (CAPTURE C6)', () => {
  it('forwards the preToolUse call as Bash with the command where extractCommand reads it', () => {
    const payload = forward('preToolUse', 'C6-004-preToolUse-powershell')
    expect(payload['tool_name']).toBe('Bash')
    const event = buildEvent('pre_tool_use', payload)
    expect(event.toolName).toBe('Bash')
    expect(extractCommand(event)).toBe(CAPTURED_COMMAND)
  })

  it('forwards the postToolUse call as Bash with the output where the post-Bash handler reads it', () => {
    const payload = forward('postToolUse', 'C6-006-postToolUse-powershell')
    expect(payload['tool_name']).toBe('Bash')
    const event = buildEvent('post_tool_use', payload)
    expect(extractCommand(event)).toBe(CAPTURED_COMMAND)
    expect(extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe(CAPTURED_OUTPUT)
  })
})
