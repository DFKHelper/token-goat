/** The built bundle's `hook post_tool_use` must leave a reconcile request when a branch switch's changed-file list cannot be computed, whichever host sent the payload, and the worker's default drain must then bring the index to the new branch. PROVENANCE: the Codex payload is FORMAT-DERIVED from the "Common input fields" of https://developers.openai.com/codex/hooks.md (fetched 2026-09-25) with tool_name Bash and tool_input.command as in tests/fixtures/harness_hook_payloads.ts; the Copilot payload is the CAPTURE tests/fixtures/copilot_cli_1_0_88/C6-006-postToolUse-powershell.json with its command and cwd replaced, forwarded by the real shim the installer writes; the Claude Code payload is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks.md. The git failure is CAPTURE: with `.git/logs` deleted after a checkout, `git diff --name-only HEAD@{1} HEAD` exits 128. File contents and symbol names are HAND-DERIVED. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { reconcileRequestPathFor } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { forwardCopilotPayload } from './helpers/copilot_shim_forward.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
const scratch: string[] = []

afterAll(() => {
  clearModuleCaches()
  for (const dir of scratch) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory still held by a database handle on Windows is left for the OS temp sweep.
    }
  }
})

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
  return r.stdout.trim()
}

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
}

const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

type Host = { name: string; harness: string | null; payload: (command: string, cwd: string) => Record<string, unknown> }

const HOSTS: Host[] = [
  {
    name: 'Claude Code',
    harness: null,
    payload: (command, cwd) => ({ session_id: 'rc-cc', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' } }),
  },
  {
    name: 'Codex',
    harness: 'codex',
    payload: (command, cwd) => ({ session_id: 'rc-cx', transcript_path: null, cwd, model: 'gpt-5.5', turn_id: 'turn-1', permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command }, tool_response: '' }),
  },
  {
    name: 'Copilot CLI',
    harness: 'copilot_cli',
    payload: (command, cwd) => {
      const sent = copilotCapture('C6-006-postToolUse-powershell', { proj: cwd })
      sent['toolArgs'] = { command, description: 'switch branch' }
      return forwardCopilotPayload('postToolUse', sent, cwd, scratch)
    },
  },
]

describe('a head-moving git command whose diff fails, through the built bundle', () => {
  for (const host of HOSTS) {
    it(`${host.name}: leaves a reconcile request, and the default drain moves the index to the new branch`, async () => {
      const repo = indexableDir()
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-bundle-home-'))
      scratch.push(homeDir)
      const lib = path.join(repo, 'lib.ts')
      fs.writeFileSync(lib, fn('rcAlphaSym'))
      git(repo, 'init', '-q')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'alpha')
      const original = git(repo, 'symbolic-ref', '--short', 'HEAD')
      git(repo, 'checkout', '-qb', 'feature')
      fs.writeFileSync(lib, fn('rcBetaSym'))
      git(repo, 'commit', '-qam', 'beta')
      git(repo, 'checkout', '-q', original)

      const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: repo, encoding: 'utf8', env: isolatedEnv(homeDir) })
      expect(indexed.status, `indexing failed: ${indexed.stderr}`).toBe(0)
      const dbPath = findGlobalDb(homeDir) as string
      const dir = path.dirname(dbPath)
      expect(querySymbols({ name: 'rcAlphaSym' }, dbPath), 'calibration: the original branch is indexed').toHaveLength(1)

      git(repo, 'checkout', '-q', 'feature')
      fs.rmSync(path.join(repo, '.git', 'logs'), { recursive: true, force: true })
      const env = isolatedEnv(homeDir)
      if (host.harness !== null) env['TOKEN_GOAT_HARNESS_OVERRIDE'] = host.harness
      const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { cwd: os.tmpdir(), encoding: 'utf8', input: JSON.stringify(host.payload('git checkout feature', repo)), env, timeout: 60_000 })
      expect(hook.status, `the hook exited ${hook.status}: ${hook.stderr}`).toBe(0)

      const request = reconcileRequestPathFor(dir)
      expect(fs.existsSync(request), 'no reconcile request was left').toBe(true)
      expect(fs.readFileSync(request, 'utf8').split('\n').filter((l) => l !== '').map((l) => normalizePath(JSON.parse(l) as string))).toEqual([normalizePath(repo)])

      clearModuleCaches()
      drainOnce(dir)
      drainOnce(dir)
      await pendingEmbeddings()
      expect(querySymbols({ name: 'rcBetaSym' }, dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(lib)])
      expect(querySymbols({ name: 'rcAlphaSym' }, dbPath)).toEqual([])
    }, 180_000)
  }
})
