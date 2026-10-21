import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject, runBundle } from './helpers/bundle.js'

// The inlined-symbol Grep deny through the shipped dist/token-goat.mjs: a real `index --walk`, then the built `hook pre_tool_use` entry, with the isolated env makeBundleProject builds (every data dir under a scratch root).

// HAND-DERIVED: a synthetic Python module with one function that is the only definition of its name.
const SOURCE = 'def bundle_unique_loader(path):\n    """Load one thing."""\n    return open(path).read()\n\ndef other():\n    return 2\n'

// FORMAT-DERIVED: the Claude Code PreToolUse payload keys (hook_event_name, session_id, cwd, tool_name, tool_input) and the {decision:'block', reason} reply, as src/hook_registry.ts reads and writes them.
function grepPayload(project: string, file: string, pattern: string, sessionId: string): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Grep', tool_input: { pattern, path: file } })
}

let root: string
let project: string
let env: NodeJS.ProcessEnv
let file: string

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-inline-bundle-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
  file = path.join(project, 'mod.py')
  fs.writeFileSync(file, SOURCE, 'utf8')
  const idx = bundleTg(project, env, ['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function hook(extraEnv: NodeJS.ProcessEnv, pattern: string, sessionId: string): { status: number | null; stdout: string; stderr: string } {
  return runBundle(['hook', 'pre_tool_use'], { cwd: project, env: { ...env, ...extraEnv }, input: grepPayload(project, file, pattern, sessionId), timeout: 60000 })
}

describe('built bundle: inline symbol body in the Grep deny', () => {
  it('with the config on, blocks the Grep with the exact text read prints, fenced', () => {
    const printed = bundleTg(project, env, ['read', file + '::bundle_unique_loader'])
    expect(printed.status, printed.stderr).toBe(0)
    const run = hook({ TOKEN_GOAT_INLINE_SYMBOL_BODY: '1' }, 'def bundle_unique_loader', 'inline-bundle-on')
    expect(run.status, run.stderr).toBe(0)
    const reply = JSON.parse(run.stdout) as { decision?: string; reason?: string }
    expect(reply.decision).toBe('block')
    const reason = reply.reason ?? ''
    expect(reason).toContain('<untrusted-file-content>')
    expect(reason).toContain(printed.stdout.trimEnd())
    expect(reason).toMatch(/symbol body \(\d+ bytes\) is inlined below/)
  })

  it('with the config off, does not block', () => {
    const run = hook({ TOKEN_GOAT_INLINE_SYMBOL_BODY: '0' }, 'def bundle_unique_loader', 'inline-bundle-off')
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).not.toContain('is inlined below')
    expect(run.stdout).not.toContain('"decision":"block"')
  })
})
