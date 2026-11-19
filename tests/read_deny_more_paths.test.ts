// Git history, search notice, ask, scoped Grep, dep-docs, trace and MCP honor the host's Read deny rules.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { createMcpServer } from '../src/mcp_server.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { bundleTg, makeBundleProject, runBundle } from './helpers/bundle.js'
import { ALL_MCP_TOOLS_ENV } from './helpers/mcp_all_tools.js'

process.env['TOKEN_GOAT_MCP_TOOLS'] = ALL_MCP_TOOLS_ENV

const SECRET = 'TOPSECRETBODYVALUE'
const WORD = 'zebrawordq'

let root = ''
let project = ''
let env: NodeJS.ProcessEnv = {}

function put(base: string, rel: string, body: string): void {
  const file = path.join(base, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function git(cwd: string, args: string[]): void {
  const quiet = ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
  const who = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t.t', '-c', 'user.name=t']
  execFileSync('git', [...quiet, ...who, ...args], { cwd, stdio: 'ignore' })
}

// HAND-DERIVED: a python function whose body holds the marker, so any printed body, hunk or log line shows it.
const py = (fn: string, version: number): string => `def ${fn}():\n    return '${SECRET}${version}'\n`

type Run = { status: number | null; stdout: string; stderr: string }
const tg = (args: string[]): Run => bundleTg(project, env, args)
const omittedLines = (stderr: string): string[] => stderr.split('\n').filter((l) => l.includes('omitted:'))

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-readdeny-more-'))
  env = {
    ...env,
    TOKEN_GOAT_NO_WORKER_SPAWN: '1',
    TOKEN_GOAT_HOOK_SERVER: '0',
    TOKEN_GOAT_INLINE_SYMBOL_BODY: '1',
  }
  git(project, ['init', '-q'])
  put(project, 'secrets/hidden.py', py('hidden_fn', 1))
  put(project, 'open/visible.py', py('visible_fn', 1))
  put(project, 'secrets/a.md', `${WORD} one\n${WORD} two\n${WORD} three\n`)
  put(project, 'secrets/b.md', 'nothing of note here\n')
  put(project, 'open/c.md', `${WORD} in the open\n`)
  git(project, ['add', '-A'])
  git(project, ['commit', '-q', '-m', 'first'])
  put(project, 'secrets/hidden.py', py('hidden_fn', 2))
  put(project, 'open/visible.py', py('visible_fn', 2))
  git(project, ['add', '-A'])
  git(project, ['commit', '-q', '-m', 'second'])
  put(project, 'secrets/hidden.py', py('hidden_fn', 3))
  put(project, 'open/visible.py', py('visible_fn', 3))
  const indexed = tg(['index', '.', '--walk'])
  if (indexed.status !== 0) throw new Error(`index failed: ${indexed.stderr.slice(0, 300)}`)
  // Ruling 78: the rule arrives after the index holds the rows, so rows below prove the print-time filter.
  put(project, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
})

afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true })
})

describe('read_git: git history holds the text the rule protects', () => {
  const both = (run: { stdout: string; stderr: string }): string => `${run.stdout}${run.stderr}`
  it.each([
    ['log', ['log', 'secrets/hidden.py::hidden_fn'], ['log', 'open/visible.py::visible_fn']],
    ['diff', ['diff', 'secrets/hidden.py::hidden_fn'], ['diff', 'open/visible.py::visible_fn']],
  ])('%s refuses a denied path with exit 1 and prints no file text', (_n, denied, open) => {
    const refused = tg(denied)
    expect(refused.status).toBe(1)
    expect(both(refused)).not.toContain(SECRET)
    expect(refused.stderr).toContain('[tg] read refused:')
    expect(refused.stderr).toContain(path.join(project, '.claude', 'settings.json'))
    const shown = tg(open)
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain(SECRET)
  })

  it('changed leaves the denied file out of the answer and still prints the allowed one', () => {
    const run = tg(['changed', 'HEAD~1'])
    expect(both(run)).not.toContain(SECRET)
    expect(run.stdout).not.toContain('hidden')
    expect(run.stdout).toContain('visible')
    expect(run.stderr).toContain('omitted:')
  })
})

describe('text-channel search notice: one line per denied file that had a match', () => {
  it('prints no line for a denied file with no match', () => {
    const run = tg(['search', WORD])
    expect(omittedLines(run.stderr).some((l) => l.includes('b.md'))).toBe(false)
  })

  it('prints exactly one line for a denied file with three matches', () => {
    const run = tg(['search', WORD])
    expect(omittedLines(run.stderr).filter((l) => l.includes('a.md'))).toHaveLength(1)
    expect(run.stdout).not.toContain('one')
  })

  it('prints an undenied match as before and never names it in an omission', () => {
    const run = tg(['search', WORD])
    expect(run.stdout).toContain('c.md')
    expect(omittedLines(run.stderr).some((l) => l.includes('c.md'))).toBe(false)
  })
})

describe('ask', () => {
  it('leaves a denied hit out of the grounding and keeps an allowed one', () => {
    const denied = tg(['ask', 'hidden_fn'])
    expect(`${denied.stdout}${denied.stderr}`).not.toContain(SECRET)
    expect(denied.stdout).not.toContain('secrets')
    expect(denied.stderr).toContain('omitted:')
    const open = tg(['ask', 'visible_fn'])
    expect(open.stdout).toContain('open')
    expect(open.stderr).not.toContain('read refused')
  })
})

describe('trace', () => {
  const head = 'Traceback (most recent call last):\n  File "FILE", line 2, in boom\n    return 1\n'
  const trace = `${head}ValueError: ${WORD}\n`
  it('refuses a denied source file and reads an allowed one', () => {
    const denied = tg(['trace', 'secrets/a.md'])
    expect(denied.status).toBe(1)
    expect(`${denied.stdout}${denied.stderr}`).not.toContain(WORD + ' one')
    expect(denied.stderr).toContain('[tg] read refused:')
    put(project, 'open/tb.md', trace)
    const open = tg(['trace', 'open/tb.md'])
    expect(open.stderr).not.toContain('read refused')
    expect(open.stdout + open.stderr).toContain('ValueError')
  })
})

describe('file readers that print or summarize the text they read', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', dependencies: { lockmarkpkg: '1.0.0' } },
      'node_modules/lockmarkpkg': { version: '1.0.0' },
    },
  })
  const text = (r: { stdout: string; stderr: string }): string => `${r.stdout}${r.stderr}`

  it('logfold refuses a denied file and folds an allowed one', () => {
    const denied = tg(['logfold', 'secrets/a.md'])
    expect(denied.status).toBe(1)
    expect(text(denied)).not.toContain(WORD)
    expect(denied.stderr).toContain('read refused:')
    expect(tg(['logfold', 'open/c.md']).stdout).toContain(WORD)
  })

  it('todo leaves a denied file out with one omission line and still lists an allowed one', () => {
    put(project, 'secrets/todo.py', '# TODO: SECRETTODOX\n')
    put(project, 'open/todo.py', '# TODO: OPENTODOY\n')
    const run = tg(['todo'])
    expect(text(run)).not.toContain('SECRETTODOX')
    expect(run.stdout).toContain('OPENTODOY')
    expect(omittedLines(run.stderr).some((l) => l.includes('secrets'))).toBe(true)
  })

  it('todo says a denied file once, only when it had a marker (Ruling 74)', () => {
    put(project, 'secrets/two.py', '# TODO: FIRSTMARKERX\n# FIXME: SECONDMARKERX\n')
    put(project, 'secrets/none.py', 'x = 1  # nothing to flag NOMARKERX\n')
    const run = tg(['todo'])
    expect(text(run)).not.toContain('MARKERX')
    const lines = omittedLines(run.stderr)
    expect(lines.filter((l) => l.includes('two.py'))).toHaveLength(1)
    expect(lines.some((l) => l.includes('none.py'))).toBe(false)
  })

  it('baseline --suggest-mem skips a denied CLAUDE.md and counts an allowed one', () => {
    put(project, 'secrets/CLAUDE.md', '- prefer SECRETBULLETX always\n- also SECRETBULLETX\n')
    put(project, 'CLAUDE.md', '- prefer tabs\n- prefer OPENBULLETY\n')
    const run = runBundle(['baseline', '--suggest-mem', '--json'], {
      cwd: path.join(project, 'secrets'),
      env: { ...env, CLAUDE_PROJECT_DIR: project },
      timeout: 60000,
    })
    expect(text(run)).not.toContain('SECRETBULLETX')
    const parsed = JSON.parse(run.stdout) as { memSuggestions: { path: string; count: number }[] }
    const suggestions = parsed.memSuggestions
    const expected = [normalizePath(path.join(project, 'CLAUDE.md'))]
    expect(suggestions.map((s) => normalizePath(s.path))).toEqual(expected)
    expect(omittedLines(run.stderr).some((l) => l.includes('secrets'))).toBe(true)
  })

  it('deps refuses a denied file and reads an allowed one', () => {
    const denied = tg(['deps', 'secrets/hidden.py'])
    expect(denied.status).toBe(1)
    expect(denied.stderr).toContain('read refused:')
    expect(tg(['deps', 'open/visible.py']).stderr).not.toContain('read refused')
  })

  it('compress-text --file refuses a denied file and compresses an allowed one', () => {
    const denied = tg(['compress-text', '--file', 'secrets/a.md'])
    expect(denied.status).toBe(1)
    expect(text(denied)).not.toContain(WORD)
    expect(denied.stderr).toContain('read refused:')
    expect(tg(['compress-text', '--file', 'open/c.md']).stderr).not.toContain('read refused')
  })

  it('compact-doc refuses a denied document and builds one for an allowed document', () => {
    const denied = tg(['compact-doc', 'secrets/a.md', '--show'])
    expect(text(denied)).not.toContain(WORD)
    expect(text(denied)).toContain('read refused:')
    expect(tg(['compact-doc', 'open/c.md', '--show']).stderr).not.toContain('read refused')
  })

  it('manifest-sweep refuses a denied manifest and reads an allowed one', () => {
    const manifest = JSON.stringify({ name: 'sweepmark', version: '1.0.0' })
    put(project, 'secrets/pkg/package.json', manifest)
    put(project, 'open/pkg/package.json', manifest)
    const denied = tg(['manifest-sweep', 'secrets/pkg'])
    expect(text(denied)).not.toContain('sweepmark')
    expect(tg(['manifest-sweep', 'open/pkg']).stdout).toContain('sweepmark')
  })

  it('lockdeps refuses a denied lockfile and reads an allowed one', () => {
    put(project, 'secrets/lock/package-lock.json', lock)
    put(project, 'open/lock/package-lock.json', lock)
    const denied = tg(['lockdeps', 'secrets/lock'])
    expect(text(denied)).not.toContain('lockmarkpkg')
    expect(text(denied)).toContain('read refused:')
    expect(tg(['lockdeps', 'open/lock']).stdout).toContain('lockmarkpkg')
  })
})

describe('dep-docs package.json', () => {
  it('refuses a package whose package.json is denied and answers an allowed one', () => {
    const pkg = (name: string): string => JSON.stringify({ name, version: '1.0.0', description: SECRET })
    put(project, 'node_modules/denied-pkg/package.json', pkg('denied-pkg'))
    put(project, 'node_modules/open-pkg/package.json', pkg('open-pkg'))
    const deny = ['Read(secrets/**)', 'Read(node_modules/denied-pkg/**)']
    put(project, '.claude/settings.json', JSON.stringify({ permissions: { deny } }))
    const denied = tg(['dep-docs', 'denied-pkg'])
    expect(denied.status).toBe(1)
    expect(`${denied.stdout}${denied.stderr}`).not.toContain(SECRET)
    expect(`${denied.stdout}${denied.stderr}`).toContain('read refused:')
    const open = tg(['dep-docs', 'open-pkg'])
    expect(open.status).toBe(0)
    expect(open.stdout).not.toContain('read refused')
  })
})

describe('dep-docs README', () => {
  it('leaves a denied README out of the answer and still prints an allowed one', () => {
    const readme = `# pkg\n\n${SECRET} readme text\n`
    const deniedManifest = JSON.stringify({ name: 'readme-denied', version: '1.0.0' })
    put(project, 'node_modules/readme-denied/package.json', deniedManifest)
    put(project, 'node_modules/readme-denied/README.md', readme)
    const openManifest = JSON.stringify({ name: 'readme-open', version: '1.0.0' })
    put(project, 'node_modules/readme-open/package.json', openManifest)
    put(project, 'node_modules/readme-open/README.md', readme)
    const rule = 'Read(node_modules/readme-denied/README.md)'
    put(project, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)', rule] } }))
    const denied = tg(['dep-docs', 'readme-denied'])
    expect(`${denied.stdout}${denied.stderr}`).not.toContain(SECRET)
    const open = tg(['dep-docs', 'readme-open'])
    expect(open.stdout).toContain(SECRET)
  })
})

describe('scoped Grep hook', () => {
  function hook(pattern: string, file: string): { status: number | null; reply: string; stderr: string } {
    put(project, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: `deny-${path.basename(root)}`,
      cwd: project,
      tool_name: 'Grep',
      tool_input: { pattern, output_mode: 'content', path: path.join(project, file) },
    })
    const run = runBundle(['hook', 'pre_tool_use'], { cwd: project, env, input, timeout: 60000 })
    return { status: run.status, reply: run.stdout, stderr: run.stderr }
  }

  it('lets the Grep run for a denied file: exit 0, no answer, no denied text', () => {
    const run = hook(String.raw`def hidden_fn\b`, 'secrets/hidden.py')
    expect(run.status).toBe(0)
    expect(run.reply + run.stderr).not.toContain(SECRET)
    expect(run.reply).not.toContain('"decision":"block"')
  })

  it('still answers the same Grep for an allowed file', () => {
    const run = hook(String.raw`def visible_fn\b`, 'open/visible.py')
    expect(run.status).toBe(0)
    expect(run.reply).toContain(SECRET)
  })

  it('lets a directory Grep run when a listed file is denied: exit 0, no answer, no denied text', () => {
    const denied = hook(String.raw`def hidden_fn\b`, '.')
    expect(denied.status).toBe(0)
    expect(denied.reply + denied.stderr).not.toContain(SECRET)
    expect(denied.reply).not.toContain('"decision":"block"')
  })
})

describe('MCP read path', () => {
  let base = ''
  const here = process.cwd()

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({ name, arguments: args })
      return JSON.stringify(result)
    } finally {
      await client.close()
      await server.close()
    }
  }

  beforeAll(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-mcp-')))
    put(base, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
    put(base, 'secrets/hidden.py', py('hidden_fn', 1))
    put(base, 'open/visible.py', py('visible_fn', 1))
    for (const rel of ['secrets/hidden.py', 'open/visible.py']) {
      indexFileSync(normalizePath(path.join(base, rel)), globalDbPath())
    }
    delete process.env['CLAUDE_PROJECT_DIR']
    process.chdir(base)
    resetReadDenyCache()
  })

  afterAll(() => {
    process.chdir(here)
    resetReadDenyCache()
    closeAllDbs()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it.each([
    ['symbol', { name: 'hidden_fn' }, { name: 'visible_fn' }],
    ['read', { spec: 'secrets/hidden.py::hidden_fn' }, { spec: 'open/visible.py::visible_fn' }],
  ])('%s keeps the denied text out of the whole envelope, error text included', async (tool, denied, open) => {
    const refused = await call(tool, denied)
    expect(refused).not.toContain(SECRET)
    const shown = await call(tool, open)
    expect(shown).toContain(SECRET)
  })
})
