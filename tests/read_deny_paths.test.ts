// Every token-goat command printing file text honors the host's Read deny rules; each row runs the built CLI.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const SECRET = 'TOPSECRETBODYVALUE'
// 1x1 transparent PNG (HAND-DERIVED: the standard minimal PNG, any valid image works for image-meta)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let proj = ''

function put(rel: string, body: string | Buffer): void {
  const file = path.join(proj, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function cli(args: string[], cwd = proj): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['CLAUDE_PROJECT_DIR']
  const run = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const code = (name: string): string => `export function ${name}() {\n  return '${SECRET}'\n}\n`
const md = `# Title\n\nintro\n\n## Hidden Part\n\n${SECRET} lives here\n`

beforeAll(() => {
  proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-paths-')))
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  for (const dir of ['secrets', 'open']) {
    put(`${dir}/a.ts`, code('alpha'))
    put(`${dir}/doc.md`, md)
    put(`${dir}/data.json`, JSON.stringify({ key: SECRET }))
    put(`${dir}/data.yaml`, `key: ${SECRET}\n`)
    put(`${dir}/pic.png`, Buffer.from(PNG_B64, 'base64'))
  }
})

afterAll(() => {
  if (proj !== '') fs.rmSync(proj, { recursive: true, force: true })
})

interface Row {
  name: string
  args: (dir: string) => string[]
  /** What an allowed run prints, or undefined when the command may fail for an unrelated reason. */
  shows?: string
}

const ROWS: Row[] = [
  { name: 'read whole file', args: (d) => ['read', `${d}/a.ts`], shows: SECRET },
  { name: 'read line range', args: (d) => ['read', `${d}/a.ts@1-3`], shows: SECRET },
  { name: 'read symbol', args: (d) => ['read', `${d}/a.ts::alpha`], shows: SECRET },
  { name: 'section', args: (d) => ['section', `${d}/doc.md::Hidden Part`], shows: SECRET },
  { name: 'grep file', args: (d) => ['grep', SECRET, `${d}/a.ts`], shows: SECRET },
  { name: 'json-query', args: (d) => ['json-query', `${d}/data.json`, 'key'], shows: SECRET },
  { name: 'yaml-query', args: (d) => ['yaml-query', `${d}/data.yaml`, 'key'], shows: SECRET },
  { name: 'read --sig', args: (d) => ['read', `${d}/a.ts::alpha`, '--sig'], shows: 'alpha' },
  { name: 'brief', args: (d) => ['brief', `${d}/a.ts::alpha`], shows: SECRET },
  { name: 'image-meta', args: (d) => ['image-meta', `${d}/pic.png`] },
  { name: 'image-text', args: (d) => ['image-text', `${d}/pic.png`] },
]

describe.each(ROWS)('$name', (row) => {
  it('refuses a denied path without printing its text, naming the settings file and rule', () => {
    const run = cli(row.args('secrets'))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('[tg] read refused:')
    expect(run.stderr).toContain(path.join(proj, '.claude', 'settings.json'))
    expect(run.stderr).toContain('Read(secrets/**)')
    expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET)
  })

  it('leaves an allowed path alone', () => {
    const run = cli(row.args('open'))
    expect(run.stderr).not.toContain('read refused')
    if (row.shows !== undefined) {
      expect(run.status).toBe(0)
      expect(run.stdout).toContain(row.shows)
    }
  })
})

describe('--json', () => {
  it('keeps a document on stdout with an error field when a read is refused', () => {
    const run = cli(['read', 'secrets/a.ts', '--json'])
    expect(run.status).toBe(1)
    const doc = JSON.parse(run.stdout) as { error?: string }
    expect(doc.error).toContain('read refused')
    expect(run.stdout).not.toContain(SECRET)
  })

  it('is unchanged for an allowed path', () => {
    const run = cli(['read', 'open/a.ts', '--json'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(SECRET)
  })
})

describe('grep over a directory', () => {
  it('skips denied files with one stderr note and still searches the rest', () => {
    const run = cli(['grep', SECRET, '.'])
    expect(run.stdout).toMatch(/open.a\.ts/)
    expect(run.stdout).not.toContain('secrets')
    expect(run.stderr).toContain('skipped: denied by the host')
    expect(run.stderr).not.toContain(SECRET)
  })
})

describe('failure policy', () => {
  it('a settings file that is not valid JSON refuses reads and names the file', () => {
    const bad = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-bad-')))
    try {
      fs.mkdirSync(path.join(bad, '.claude'))
      fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ nope')
      fs.writeFileSync(path.join(bad, 'a.ts'), code('beta'))
      const run = cli(['read', 'a.ts'], bad)
      expect(run.status).toBe(1)
      expect(run.stderr).toContain(path.join(bad, '.claude', 'settings.json'))
      expect(run.stdout).not.toContain(SECRET)
    } finally {
      fs.rmSync(bad, { recursive: true, force: true })
    }
  })

  it('TOKEN_GOAT_READS_HONOR_HOST_DENY=0 turns the check off', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_READS_HONOR_HOST_DENY: '0' }
    delete env['CLAUDE_PROJECT_DIR']
    const args = [BUNDLE, 'read', 'secrets/a.ts']
    const run = spawnSync(process.execPath, args, { cwd: proj, env, encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(SECRET)
  })
})

describe('hook paths never fail', () => {
  it('the served-extent hook yields no extent for a denied file and for unreadable settings', async () => {
    const { servedExtents } = await import('../src/served_extent.js')
    const { resetReadDenyCache } = await import('../src/read_deny.js')
    const here = process.cwd()
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    const bad = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-hook-')))
    try {
      process.chdir(proj)
      resetReadDenyCache()
      const spec = path.join(proj, 'secrets', 'doc.md::Hidden Part')
      expect(await servedExtents('section', spec, `token-goat section "${spec}"`, null)).toEqual([])
      const allowed = path.join(proj, 'open', 'doc.md::Hidden Part')
      const ok = await servedExtents('section', allowed, `token-goat section "${allowed}"`, null)
      expect(ok.length).toBe(1)

      fs.mkdirSync(path.join(bad, '.claude'))
      fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ nope')
      fs.writeFileSync(path.join(bad, 'doc.md'), md)
      process.chdir(bad)
      resetReadDenyCache()
      const broken = path.join(bad, 'doc.md::Hidden Part')
      expect(await servedExtents('section', broken, `token-goat section "${broken}"`, null)).toEqual([])
    } finally {
      process.chdir(here)
      if (saved !== undefined) process.env['CLAUDE_PROJECT_DIR'] = saved
      resetReadDenyCache()
      fs.rmSync(bad, { recursive: true, force: true })
    }
  })

  it('the context window yields no lines for a denied file and for unreadable settings', async () => {
    const { buildContextWindow } = await import('../src/util_context.js')
    const { resetReadDenyCache } = await import('../src/read_deny.js')
    const here = process.cwd()
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    const bad = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-ctx-')))
    try {
      process.chdir(proj)
      resetReadDenyCache()
      expect(buildContextWindow(path.join(proj, 'secrets', 'a.ts'), 2, 1)).toBeNull()
      const ok = buildContextWindow(path.join(proj, 'open', 'a.ts'), 2, 1)
      expect(ok?.map((l) => l.text).join('\n')).toContain(SECRET)

      fs.mkdirSync(path.join(bad, '.claude'))
      fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ nope')
      fs.writeFileSync(path.join(bad, 'a.ts'), code('alpha'))
      process.chdir(bad)
      resetReadDenyCache()
      expect(buildContextWindow(path.join(bad, 'a.ts'), 2, 1)).toBeNull()
    } finally {
      process.chdir(here)
      if (saved !== undefined) process.env['CLAUDE_PROJECT_DIR'] = saved
      resetReadDenyCache()
      fs.rmSync(bad, { recursive: true, force: true })
    }
  })
})
