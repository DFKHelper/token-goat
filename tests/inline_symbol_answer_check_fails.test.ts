// A Read-rule check that fails for a reason other than a denial must not throw out of the inlined Grep hook.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ScanModule from '../src/inline_grep_scan.js'
import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { inlineSymbolAnswer } from '../src/inline_symbol_answer.js'
import { indexFileSync } from '../src/parser.js'
import type * as ReadCommands from '../src/read_commands.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { indexableDir } from './helpers/temp-config.js'

// The scope read runs under steadyScopeDeps as in inline_symbol_answer_scope.test.ts: a git deadline is timing.
vi.mock('../src/inline_grep_scan.js', async (importOriginal) => {
  const { withSteadyScopeDeps } = await import('./helpers/steady_scope_git.js')
  return withSteadyScopeDeps((await importOriginal()) as typeof ScanModule)
})

// The check's failure is injected where the hook reaches it: runRead, whose first act is the Read-rule check.
const failing = { on: false }
vi.mock('../src/read_commands.js', async (importOriginal) => {
  const real = (await importOriginal()) as typeof ReadCommands
  return {
    ...real,
    runRead: (...args: Parameters<typeof real.runRead>) => {
      if (failing.on) throw new Error('the host settings could not be loaded')
      return real.runRead(...args)
    },
  }
})

// HAND-DERIVED: one declaration of a unique name, so the hook can answer it when the Read check passes.
const MODULE = [
  'def unique_loader(path):',
  '    """Load one thing."""',
  '    return open(path).read()',
  '',
].join('\n')
const LOADER = String.raw`def unique_loader\b`

let templateRoot = ''
function gitDirTemplate(): string {
  if (templateRoot === '') {
    templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chkfail-gitdir-'))
    const gitInit = ['-c', 'init.defaultBranch=main', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
    gitInit.push('init', '-q')
    execFileSync('git', gitInit, {
      cwd: templateRoot,
      stdio: 'ignore',
    })
  }
  return path.join(templateRoot, '.git')
}

function project(): string {
  const dir = indexableDir()
  fs.cpSync(gitDirTemplate(), path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mod.py'), MODULE, 'utf8')
  indexFileSync(path.join(dir, 'mod.py'), globalDbPath())
  return dir
}

const answer = (cwd: string) =>
  inlineSymbolAnswer({
    enabled: true,
    pattern: LOADER,
    grepPath: cwd,
    cwd,
    event: makeHookEvent({ toolName: 'Grep', toolInput: { pattern: LOADER, path: cwd }, raw: { cwd } }),
    isBarred: () => false,
  })

beforeEach(() => {
  clearModuleCaches()
  vi.stubEnv('TOKEN_GOAT_INLINE_SYMBOL_BODY', '1')
  invalidateConfigCache()
  failing.on = false
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
})

afterAll(() => {
  if (templateRoot !== '') fs.rmSync(templateRoot, { recursive: true, force: true })
})

describe('the inline answer when the Read-rule check fails', () => {
  it('answers when the check passes (control)', async () => {
    const dir = project()
    const out = await answer(dir)
    expect('inline' in out).toBe(true)
  })

  it('gives no inline answer, no file text and does not reject when the check fails', async () => {
    const dir = project()
    failing.on = true
    const out = await answer(dir)
    expect('inline' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('open(path)')
  })
})
