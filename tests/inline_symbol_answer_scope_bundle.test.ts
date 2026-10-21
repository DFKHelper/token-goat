import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject, runBundle } from './helpers/bundle.js'

// The directory-scoped and bare-name inlined Grep answers through the shipped dist/token-goat.mjs: a real git work tree, a real `index --walk`, then the built `hook pre_tool_use` entry, with the isolated env makeBundleProject builds (every data dir under a scratch root).

// HAND-DERIVED: synthetic Python modules; scope_loader is declared once, called twice in use.py, and mentioned in a comment in an ignored directory (an index walk still indexes that file, so a second declaration there would make the name ambiguous instead).
const MODULE = 'def scope_loader(path):\n    """Load one thing."""\n    return open(path).read()\n'
const MENTION = '# def scope_loader is documented in mod.py\n'
const CALLER = 'from mod import scope_loader\n\na = scope_loader("a")\nb = scope_loader("b")\n'

// FORMAT-DERIVED: the Claude Code PreToolUse payload keys (hook_event_name, session_id, cwd, tool_name, tool_input) and the {decision:'block', reason} reply, as src/hook_registry.ts reads and writes them.
function grepPayload(project: string, pattern: string, grepPath: string | undefined, sessionId: string): string {
  const toolInput: Record<string, unknown> = { pattern, output_mode: 'content' }
  if (grepPath !== undefined) toolInput['path'] = grepPath
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Grep', tool_input: toolInput })
}

let root: string
let project: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-inline-scope-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_INLINE_SYMBOL_BODY: '1', TOKEN_GOAT_HOOK_SERVER: '0' }
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'init', '-q'], { cwd: project, stdio: 'ignore' })
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), 'skipped/\n', 'utf8')
  fs.mkdirSync(path.join(project, 'skipped'))
  fs.writeFileSync(path.join(project, 'mod.py'), MODULE, 'utf8')
  fs.writeFileSync(path.join(project, 'use.py'), CALLER, 'utf8')
  fs.writeFileSync(path.join(project, 'skipped', 'copy.py'), MENTION, 'utf8')
  const idx = bundleTg(project, env, ['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function hook(pattern: string, grepPath: string | undefined, sessionId: string): { reason: string | null; stderr: string } {
  const run = runBundle(['hook', 'pre_tool_use'], { cwd: project, env, input: grepPayload(project, pattern, grepPath, sessionId), timeout: 60000 })
  expect(run.status, run.stderr).toBe(0)
  const reply = run.stdout.trim() === '' ? {} : (JSON.parse(run.stdout) as { decision?: string; reason?: string })
  return { reason: reply.decision === 'block' ? (reply.reason ?? '') : null, stderr: run.stderr }
}

describe('built bundle: inline symbol body for a directory or a bare name', () => {
  it('answers a declaration Grep of the directory, skipping the ignored copy', () => {
    const { reason } = hook(String.raw`def scope_loader\b`, project, 'scope-bundle-dir')
    expect(reason).not.toBeNull()
    expect(reason).toContain('mod.py:1:def scope_loader(path):')
    expect(reason).toContain('return open(path).read()')
  })

  it('answers a declaration Grep that names no path', () => {
    expect(hook(String.raw`def scope_loader\b`, undefined, 'scope-bundle-root').reason).not.toBeNull()
  })

  it('lists every call site of a bare name before the body', () => {
    const { reason } = hook(String.raw`\bscope_loader\b`, project, 'scope-bundle-bare')
    expect(reason).not.toBeNull()
    for (const line of ['mod.py:1:def scope_loader(path):', 'use.py:1:from mod import scope_loader', 'use.py:3:a = scope_loader("a")', 'use.py:4:b = scope_loader("b")']) expect(reason).toContain(line)
  })

  it('lets the Grep run once the ignore rule is gone, since ripgrep would then also see the copy', () => {
    const excludeFile = path.join(project, '.git', 'info', 'exclude')
    const original = fs.readFileSync(excludeFile, 'utf8')
    fs.writeFileSync(excludeFile, '', 'utf8')
    try {
      expect(hook(String.raw`def scope_loader\b`, project, 'scope-bundle-unignored').reason).toBeNull()
    } finally {
      fs.writeFileSync(excludeFile, original, 'utf8')
    }
  })
})
