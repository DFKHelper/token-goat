/** Provenance: the claudecode Read payloads are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (PreToolUse / PostToolUse, tool_name "Read", tool_input.file_path) and shaped like the ones tests/guards/hook_hint_path_injection.test.ts sends. The Codex and Copilot payloads are the cases tests/fixtures/harness_hook_payloads.ts already carries, each citing its own source (Codex: codex-cli 0.155.0 CAPTURE for the tool name plus developers.openai.com/codex/hooks.md; Copilot: schemas/copilot_cli.hooks.json plus the shim's @github/copilot-sdk tool list). The launch count is HAND-DERIVED from src/rewrite_permission.ts: HKLM and HKCU are queried one after the other, plus, only when an exit-1 message is not the English not-found one, one query of a key that cannot exist, so two launches on an English machine with no policy and three otherwise. Nothing is kept between hook processes, so every hinted Read pays them again. The counter below is a --require preload that wraps child_process.spawnSync in the real built bundle, so it counts what the shipped hook does and not what a unit seam supplies. Windows only: the registry is read nowhere else. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HARNESS_HOOK_PAYLOADS } from './fixtures/harness_hook_payloads.js'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
const COUNTER = "const cp = require('node:child_process'); const fs = require('node:fs'); const real = cp.spawnSync; cp.spawnSync = function (cmd) { if (/reg(\\.exe)?$/i.test(String(cmd))) fs.appendFileSync(process.env.TG_REG_LOG, String(cmd) + '\\n'); return real.apply(this, arguments) }"

let root: string
let project: string
let regLog: string

function hook(event: string, input: string, harness: string): { status: number; stdout: string; stderr: string; reg: string[] } {
  fs.writeFileSync(regLog, '')
  const res = spawnSync(process.execPath, ['--require', path.join(root, 'count_reg.cjs'), BUNDLE, 'hook', event], {
    cwd: project,
    encoding: 'utf-8',
    timeout: 20000,
    input,
    env: {
      ...process.env,
      TG_REG_LOG: regLog,
      // This test counts the real registry reads, so the shared preload that hides registry sources from spawned bundles stays off.
      TG_TEST_PERMISSION_ROOT: '',
      TOKEN_GOAT_HOME: path.join(root, 'tg'),
      LOCALAPPDATA: path.join(root, 'local'),
      XDG_DATA_HOME: path.join(root, 'xdg'),
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      TOKEN_GOAT_HARNESS_OVERRIDE: harness,
      TOKEN_GOAT_HOOK_SERVER: '0',
      TOKEN_GOAT_NATIVE_HOOKS: '0',
      TOKEN_GOAT_NO_WORKER_SPAWN: '1',
    },
  })
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', reg: fs.readFileSync(regLog, 'utf8').split('\n').filter((l) => l !== '') }
}

const claudecode = (tool: 'pre_tool_use' | 'post_tool_use', file: string): string =>
  JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file }, session_id: 'regspawn-1', ...(tool === 'post_tool_use' ? { tool_response: { file: { content: 'x' } } } : {}) })

function payload(harness: string, name: string): { event: string; input: string } {
  const c = HARNESS_HOOK_PAYLOADS.find((p) => p.harness === harness && p.name === name)
  if (c === undefined || c.payload === undefined) throw new Error(`no ${harness} case named ${name}`)
  return { event: c.event, input: JSON.stringify(c.payload).replaceAll('{{PROJ}}', project.replaceAll(path.sep, '/')).replaceAll('{{SID}}', 'regspawn-2') }
}

describe.skipIf(process.platform !== 'win32')('a hook process and the Windows registry policy', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-regspawn-'))
    project = path.join(root, 'proj')
    regLog = path.join(root, 'reg.log')
    for (const d of ['proj', 'tg', 'local', 'xdg', 'home', 'claude']) fs.mkdirSync(path.join(root, d), { recursive: true })
    fs.writeFileSync(path.join(root, 'count_reg.cjs'), COUNTER)
    fs.writeFileSync(path.join(project, 'ordinary.ts'), 'export const ordinary = 1\n')
    fs.writeFileSync(path.join(project, 'notes.md'), '# Title\n\n' + 'intro line\n'.repeat(400))
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('Claude Code: each hinting hook reads the registry live by absolute path, in at most three serial launches, and the hint still arrives', () => {
    const file = path.join(project, 'ordinary.ts')
    expect(hook('pre_tool_use', claudecode('pre_tool_use', file), 'claudecode').status).toBe(0)
    expect(hook('post_tool_use', claudecode('post_tool_use', file), 'claudecode').status).toBe(0)
    const second = hook('pre_tool_use', claudecode('pre_tool_use', file), 'claudecode')
    const third = hook('pre_tool_use', claudecode('pre_tool_use', file), 'claudecode')
    for (const r of [second, third]) {
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout, 'no hint was emitted, so the registry check proves nothing').toContain('ordinary.ts')
    }
    for (const r of [second, third]) {
      expect(r.reg.length, 'a hook skipped the live read, so something kept the policy between processes').toBeGreaterThanOrEqual(2)
      expect(r.reg.length, 'the lookup is two keys and at most one sentinel').toBeLessThanOrEqual(3)
      for (const cmd of r.reg) expect(cmd.replaceAll('\\', '/'), 'reg must be run by absolute path').toMatch(/\/System32\/reg\.exe$/i)
    }
  })

  it('Codex CLI: a shell read hook never reads the registry', () => {
    const { event, input } = payload('codex', 'Bash reading a whole markdown file')
    const r = hook(event, input, 'codex')
    expect(r.status, r.stderr).toBe(0)
    expect(r.reg).toEqual([])
  })

  it('Copilot CLI: a view hook never reads the registry', () => {
    const { event, input } = payload('copilot_cli', 'view, remapped to Read with path to file_path')
    const r = hook(event, input, 'copilot_cli')
    expect(r.status, r.stderr).toBe(0)
    expect(r.reg).toEqual([])
  })
})
