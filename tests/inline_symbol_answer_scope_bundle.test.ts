import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject, ROOT, runBundle } from './helpers/bundle.js'

// The directory-scoped and bare-name inlined Grep answers through the shipped dist/token-goat.mjs: a real git work tree, a real `index --walk`, then the built `hook pre_tool_use` entry, with the isolated env makeBundleProject builds (every data dir under a scratch root).

// HAND-DERIVED: synthetic Python modules; scope_loader is declared once, called twice in use.py, and mentioned in a comment in an ignored directory (an index walk still indexes that file, so a second declaration there would make the name ambiguous instead).
const MODULE = 'def scope_loader(path):\n    """Load one thing."""\n    return open(path).read()\n'
const MENTION = '# def scope_loader is documented in mod.py\n'
// HAND-DERIVED: a JavaScript function whose name starts with a dollar sign, and the files a real repo keeps beside its code. The second set is written after the index walk, so the index holds no row for any of them.
const DOLLAR = 'function $dollar_fn(a) {\n  return a + 1\n}\n'
const UNINDEXED = { '.gitignore': 'node_modules/\n', LICENSE: 'MIT License\n', 'notes.txt': 'nothing to see here\n' }
const CALLER = 'from mod import scope_loader\n\na = scope_loader("a")\nb = scope_loader("b")\n'

// FORMAT-DERIVED: the Claude Code PreToolUse payload keys (hook_event_name, session_id, cwd, tool_name, tool_input) and the {decision:'block', reason} reply, as src/hook_registry.ts reads and writes them.
function grepPayload(project: string, pattern: string, grepPath: string | undefined, sessionId: string): string {
  const toolInput: Record<string, unknown> = { pattern, output_mode: 'content' }
  if (grepPath !== undefined) toolInput['path'] = grepPath
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Grep', tool_input: toolInput })
}

// The preload that decides whether the answer's git calls finish, so no row here depends on how fast git ran (see its header).
const SCOPE_GIT_CONTROL = path.join(ROOT, 'tests', 'helpers', 'scope_git_control.cjs').replaceAll(String.fromCharCode(92), '/')

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
  fs.writeFileSync(path.join(project, 'dollar.js'), DOLLAR, 'utf8')
  fs.writeFileSync(path.join(project, 'skipped', 'copy.py'), MENTION, 'utf8')
  const idx = bundleTg(project, env, ['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
  for (const [name, text] of Object.entries(UNINDEXED)) fs.writeFileSync(path.join(project, name), text, 'utf8')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function hook(pattern: string, grepPath: string | undefined, sessionId: string, scopeGit: 'finishes' | 'unfinished' = 'finishes'): { reason: string | null; stderr: string } {
  const hookEnv = { ...env, TG_SCOPE_GIT: scopeGit, NODE_OPTIONS: [env['NODE_OPTIONS'], '--require', JSON.stringify(SCOPE_GIT_CONTROL)].filter((p) => p !== undefined && p !== '').join(' ') }
  const run = runBundle(['hook', 'pre_tool_use'], { cwd: project, env: hookEnv, input: grepPayload(project, pattern, grepPath, sessionId), timeout: 60000 })
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

  it('lets a Grep of the directory run when git did not finish, and answers the same Grep when it did', () => {
    const bare = String.raw`\bscope_loader\b`
    expect(hook(bare, project, 'scope-bundle-unknown', 'unfinished').reason).toBeNull()
    expect(hook(String.raw`def scope_loader\b`, project, 'scope-bundle-unknown-decl', 'unfinished').reason).toBeNull()
    expect(hook(bare, project, 'scope-bundle-known', 'finishes').reason).not.toBeNull()
  })

  it('answers a declaration Grep that names no path', () => {
    expect(hook(String.raw`def scope_loader\b`, undefined, 'scope-bundle-root').reason).not.toBeNull()
  })

  it('lists every call site of a bare name before the body', () => {
    const { reason } = hook(String.raw`\bscope_loader\b`, project, 'scope-bundle-bare')
    expect(reason).not.toBeNull()
    for (const line of ['mod.py:1:def scope_loader(path):', 'use.py:1:from mod import scope_loader', 'use.py:3:a = scope_loader("a")', 'use.py:4:b = scope_loader("b")']) expect(reason).toContain(line)
  })

  it('answers a Grep for a symbol whose name holds a dollar sign, spelled with the escaped dollar', () => {
    for (const [pattern, session] of [[String.raw`function \$dollar_fn\b`, 'scope-bundle-dollar-decl'], [String.raw`\$dollar_fn`, 'scope-bundle-dollar-bare']] as const) {
      const { reason } = hook(pattern, project, session)
      expect(reason, pattern).not.toBeNull()
      expect(reason, pattern).toContain('function $dollar_fn(a) {')
    }
  })

  it('lets a Grep with an unescaped dollar run, since ripgrep reads it as an end anchor that matches nothing', () => {
    expect(hook(String.raw`function $dollar_fn\b`, project, 'scope-bundle-dollar-anchor').reason).toBeNull()
    expect(hook('$dollar_fn', project, 'scope-bundle-dollar-anchor-bare').reason).toBeNull()
  })

  it('answers the directory although it holds files the index never saw, which hold no match', () => {
    for (const name of Object.keys(UNINDEXED)) expect(fs.existsSync(path.join(project, name)), name).toBe(true)
    const { reason } = hook(String.raw`def scope_loader\b`, project, 'scope-bundle-unindexed-clean')
    expect(reason).not.toBeNull()
    expect(reason).toContain('mod.py:1:def scope_loader(path):')
  })

  it('lets the Grep run when a file the index never saw holds a match', () => {
    const note = path.join(project, 'notes.txt')
    fs.writeFileSync(note, 'see def scope_loader in mod.py\n', 'utf8')
    try {
      expect(hook(String.raw`def scope_loader\b`, project, 'scope-bundle-unindexed-match').reason).toBeNull()
    } finally {
      fs.writeFileSync(note, UNINDEXED['notes.txt'], 'utf8')
    }
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
