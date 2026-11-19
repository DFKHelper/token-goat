// Read-deny round 2: readers that printed a denied file's text by another road. Provenance: HAND-DERIVED.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { run } from '../src/cli.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { preReadImageHandler } from '../src/image_shrink.js'
import { setSkillOutputsDirForTesting, storeOutput } from '../src/skill_cache.js'
import Database from '../src/sqlite_driver.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const MARKER = 'denied-round2-marker-text'
const OPEN_MARKER = 'open-round2-marker-text'
let outputsDir: string
let proj: string
let prevCwd: string
let prevProjectDir: string | undefined
let prevConfigDir: string | undefined
let prevHarness: string | undefined
let stdout: string[]
let stderr: string[]
let outSpy: WriteSpy
let errSpy: WriteSpy

beforeEach(() => {
  prevCwd = process.cwd()
  prevProjectDir = process.env['CLAUDE_PROJECT_DIR']
  prevConfigDir = process.env['CLAUDE_CONFIG_DIR']
  prevHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  outputsDir = mkdtempSync(join(tmpdir(), 'tg-rd2-out-'))
  setSkillOutputsDirForTesting(outputsDir)
  proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-rd2-')))
  mkdirSync(join(proj, '.claude'))
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(locked/**)'] } }))
  for (const dir of ['locked', 'open']) mkdirSync(join(proj, dir))
  process.chdir(proj)
  process.env['CLAUDE_PROJECT_DIR'] = proj
  process.env['CLAUDE_CONFIG_DIR'] = join(proj, 'open', 'cfg')
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
  resetReadDenyCache()
  stdout = []
  stderr = []
  outSpy = spyOnWrite(process.stdout, stdout)
  errSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  process.chdir(prevCwd)
  for (const [key, prev] of [['CLAUDE_PROJECT_DIR', prevProjectDir], ['CLAUDE_CONFIG_DIR', prevConfigDir], ['TOKEN_GOAT_HARNESS_OVERRIDE', prevHarness]] as const) {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
  resetReadDenyCache()
  setSkillOutputsDirForTesting(null)
  rmSync(outputsDir, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
})

/** Runs one command and returns what it printed and its exit code; the buffers restart for the next call. */
async function runCli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...args])
    return { out: stdout.join(''), err: stderr.join(''), code: Number(process.exitCode ?? 0) }
  } finally {
    process.exitCode = prev
    stdout.length = 0
    stderr.length = 0
  }
}

const transcript = (marker: string): string =>
  [
    { type: 'user', message: { role: 'user', content: `please look at ${marker}` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `done with ${marker}` }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'

function expectRefused(r: { out: string; err: string; code: number }, marker: string): void {
  expect(r.out).not.toContain(marker)
  expect(r.err).not.toContain(marker)
  expect(r.err).toContain('[tg]')
  expect(r.code).toBe(1)
}

describe('N1: session transcript commands honor host Read deny rules', () => {
  beforeEach(() => {
    writeFileSync(join(proj, 'locked', 's.jsonl'), transcript(MARKER))
    writeFileSync(join(proj, 'open', 's.jsonl'), transcript(OPEN_MARKER))
  })

  it('session-outline refuses a denied transcript path and prints an open one', async () => {
    expectRefused(await runCli(['session-outline', join(proj, 'locked', 's.jsonl')]), MARKER)
    const open = await runCli(['session-outline', join(proj, 'open', 's.jsonl')])
    expect(open.code).toBe(0)
    expect(open.out).toContain(OPEN_MARKER)
  })

  it('session-slice refuses a denied transcript path and prints an open one', async () => {
    expectRefused(await runCli(['session-slice', join(proj, 'locked', 's.jsonl'), '--range', '1-2']), MARKER)
    const open = await runCli(['session-slice', join(proj, 'open', 's.jsonl'), '--range', '1-2'])
    expect(open.code).toBe(0)
    expect(open.out).toContain(OPEN_MARKER)
  })

  it('listing-size refuses a denied transcript path', async () => {
    expectRefused(await runCli(['listing-size', join(proj, 'locked', 's.jsonl')]), MARKER)
    expect((await runCli(['listing-size', join(proj, 'open', 's.jsonl')])).code).toBe(0)
  })

  it('a transcript resolved from a session id under a denied directory is refused too', async () => {
    const slug = proj.replace(/[^A-Za-z0-9]/g, '-')
    const lockedDir = join(proj, 'locked', 'cfg', 'projects', slug)
    const openDir = join(proj, 'open', 'cfg', 'projects', slug)
    mkdirSync(lockedDir, { recursive: true })
    mkdirSync(openDir, { recursive: true })
    writeFileSync(join(lockedDir, 'sid1.jsonl'), transcript(MARKER))
    writeFileSync(join(openDir, 'sid1.jsonl'), transcript(OPEN_MARKER))
    process.env['CLAUDE_CONFIG_DIR'] = join(proj, 'locked', 'cfg')
    expectRefused(await runCli(['session-outline', 'sid1']), MARKER)
    process.env['CLAUDE_CONFIG_DIR'] = join(proj, 'open', 'cfg')
    const open = await runCli(['session-outline', 'sid1'])
    expect(open.code).toBe(0)
    expect(open.out).toContain(OPEN_MARKER)
  })
})

describe('N2: waste, audit and session-audit honor host Read deny rules', () => {
  const usageRow = (marker: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `/x/${marker}.ts` } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }) + '\n'

  beforeEach(() => {
    writeFileSync(join(proj, 'locked', 'w.jsonl'), usageRow(MARKER))
    writeFileSync(join(proj, 'open', 'w.jsonl'), usageRow(OPEN_MARKER))
  })

  it('waste --transcript refuses a denied transcript and reports an open one', async () => {
    expectRefused(await runCli(['waste', '--transcript', join(proj, 'locked', 'w.jsonl')]), MARKER)
    const open = await runCli(['waste', '--transcript', join(proj, 'open', 'w.jsonl')])
    expect(open.code).toBe(0)
    expect(open.out.length).toBeGreaterThan(0)
  })

  it('audit --transcript refuses a denied transcript and reports an open one', async () => {
    expectRefused(await runCli(['audit', '--transcript', join(proj, 'locked', 'w.jsonl')]), MARKER)
    const open = await runCli(['audit', '--transcript', join(proj, 'open', 'w.jsonl')])
    expect(open.code).toBe(0)
    expect(open.out.length).toBeGreaterThan(0)
  })

  it('session-audit --dir skips each denied file with one omitted line and scans the open one', async () => {
    const r = await runCli(['session-audit', '--dir', proj, '--json'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(MARKER)
    expect((JSON.parse(r.out) as { filesScanned: number }).filesScanned).toBe(1)
    const omitted = r.err.split('\n').filter((l) => l.startsWith('[tg] omitted:'))
    expect(omitted).toHaveLength(1)
    expect(omitted[0]).toContain('locked')
  })
})

describe('N10: memory skips a denied CLAUDE.md before the read and never fixes it', () => {
  const claudeMd = (marker: string): string => `# Rules\n${marker} line one\n${marker} line one\n`

  it('reports the open CLAUDE.md, omits the denied one, and leaves it byte-identical under --fix', async () => {
    mkdirSync(join(proj, 'locked', 'p'))
    const lockedFile = join(proj, 'locked', 'p', 'CLAUDE.md')
    const openFile = join(proj, 'CLAUDE.md')
    writeFileSync(lockedFile, claudeMd(MARKER))
    writeFileSync(openFile, claudeMd(OPEN_MARKER))
    const before = readFileSync(lockedFile, 'utf-8')
    const r = await runCli(['memory', '--project', join(proj, 'locked', 'p')])
    expect(r.out).not.toContain(MARKER)
    expect(r.err).not.toContain(MARKER)
    expect(r.out).toContain(OPEN_MARKER)
    expect(r.err).toContain('[tg] omitted:')
    const fixed = await runCli(['memory', '--project', join(proj, 'locked', 'p'), '--fix', '--yes'])
    expect(fixed.out).not.toContain(MARKER)
    expect(readFileSync(lockedFile, 'utf-8')).toBe(before)
    expect(readFileSync(openFile, 'utf-8')).toBe(`# Rules\n${OPEN_MARKER} line one\n`)
  })
})

describe('N11: sqlite commands refuse a denied database before opening it', () => {
  function makeDb(file: string, marker: string): void {
    const db = new Database(file)
    db.exec(`CREATE TABLE ${marker.replace(/-/g, '_')}_t (body TEXT)`)
    db.exec(`INSERT INTO ${marker.replace(/-/g, '_')}_t VALUES ('${marker}')`)
    db.close()
  }

  beforeEach(() => {
    makeDb(join(proj, 'locked', 'x.db'), MARKER)
    makeDb(join(proj, 'open', 'x.db'), OPEN_MARKER)
  })

  it('sqlite-tables, sqlite-schema, sqlite-query and describe refuse a denied database', async () => {
    const file = join(proj, 'locked', 'x.db')
    const table = `${MARKER.replace(/-/g, '_')}_t`
    expectRefused(await runCli(['sqlite-tables', file]), MARKER.replace(/-/g, '_'))
    expectRefused(await runCli(['sqlite-schema', file]), MARKER.replace(/-/g, '_'))
    expectRefused(await runCli(['sqlite-query', file, `SELECT body FROM ${table}`]), MARKER)
    const described = await runCli(['describe', file])
    expect(described.out).not.toContain(MARKER.replace(/-/g, '_'))
    expect(described.code).toBe(1)
  })

  it('the same three commands show an open database', async () => {
    const file = join(proj, 'open', 'x.db')
    const table = `${OPEN_MARKER.replace(/-/g, '_')}_t`
    const tables = await runCli(['sqlite-tables', file])
    expect(tables.code).toBe(0)
    expect(tables.out).toContain(table)
    expect((await runCli(['sqlite-schema', file])).out).toContain(table)
    expect((await runCli(['sqlite-query', file, `SELECT body FROM ${table}`])).out).toContain(OPEN_MARKER)
  })
})

describe('N12: skill-diff checks the stored source path at print time', () => {
  it('prints nothing of a version whose source file is now denied, and diffs an open one', async () => {
    for (const dir of ['locked', 'open']) {
      const marker = dir === 'locked' ? MARKER : OPEN_MARKER
      const sourcePath = join(proj, dir, 'SKILL.md')
      writeFileSync(sourcePath, 'x')
      await storeOutput('s1', `${dir}skill`, `# D\nold ${marker}\n`, { sourcePath })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await storeOutput('s1', `${dir}skill`, `# D\nnew ${marker}\n`, { sourcePath })
    }
    const denied = await runCli(['skill-diff', 'lockedskill'])
    expect(denied.out).not.toContain(MARKER)
    expect(denied.err).not.toContain(MARKER)
    expect(denied.err).toContain('[tg] omitted:')
    expect((await runCli(['skill-diff', 'openskill'])).out).toContain(OPEN_MARKER)
  })
})

describe('the pre-read image hook passes through a denied image', () => {
  it('returns no image bytes for a denied image and shrinks an open one', async () => {
    // A solid-colour image over the 1568px edge qualifies for a shrink on size of its dimensions alone.
    const png = await sharp({ create: { width: 2200, height: 1700, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer()
    for (const dir of ['locked', 'open']) writeFileSync(join(proj, dir, 'big.png'), png)
    const event = (file: string) => makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, raw: { cwd: proj } })
    const denied = await preReadImageHandler(event(join(proj, 'locked', 'big.png')))
    expect(denied.hookType).toBe('pass')
    expect(JSON.stringify(denied)).not.toContain('data:image')
    const open = await preReadImageHandler(event(join(proj, 'open', 'big.png')))
    expect(open.hookType).toBe('context')
    expect(existsSync(join(proj, 'open', 'big.png'))).toBe(true)
  })
})
