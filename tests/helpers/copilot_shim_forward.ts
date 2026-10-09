// Runs the Copilot CLI hooks shim the real installer writes, with a fake `token-goat` first on PATH that records its stdin, and returns what the shim forwarded to token-goat for a Copilot-sent payload. The forwarded bytes are the payload the hook entry receives under TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli, so a test can drive the real hook with the shape a shipped shim produces rather than one written from the hook's own reader.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect } from 'vitest'

import { installCopilotHooksFile, HOOKS_SCRIPT_FILE } from '../../src/bridges/copilot_cli_install.js'

/** The shim's forwarded payload for `event` (a Copilot hook event name such as `postToolUse`) and the Copilot-sent `copilotPayload`, run from `proj`. The shim is given no bundle path, so it falls back to `token-goat` on PATH, which is the recording fake. Scratch directories are created under the OS temp dir and returned in `scratch` for the caller to remove. */
export function forwardCopilotPayload(event: string, copilotPayload: Record<string, unknown>, proj: string, scratch: string[]): Record<string, unknown> {
  const mk = (prefix: string): string => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    scratch.push(dir)
    return dir
  }
  const hooksDir = mk('tg-copilot-fwd-hooks-')
  const binDir = mk('tg-copilot-fwd-bin-')
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
    input: JSON.stringify(copilotPayload),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PATH: binDir + path.delimiter + (process.env['PATH'] ?? '') },
  })
  expect(res.status, res.stderr).toBe(0)
  expect(fs.existsSync(capturePath), 'the shim never ran token-goat').toBe(true)
  return JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
}
