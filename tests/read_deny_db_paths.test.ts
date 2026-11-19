// Commands that return file text out of the index honor the host's Read deny rules; rows run the built CLI.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const SECRET = 'TOPSECRETBODYVALUE'

let proj = ''

function put(rel: string, body: string): void {
  const file = path.join(proj, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function cli(args: string[], cwd = proj): Run {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['CLAUDE_PROJECT_DIR']
  const opts = { cwd, env, encoding: 'utf8' as const, timeout: 120_000 }
  const run = spawnSync(process.execPath, [BUNDLE, ...args], opts)
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

// HAND-DERIVED: a function whose body holds the marker, plus a caller so refs has a row to show.
const code = (name: string): string =>
  `export function ${name}() {\n  return '${SECRET}'\n}\n\n` +
  `export function use_${name}() {\n  return ${name}()\n}\n`

beforeAll(() => {
  proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-readdeny-db-')))
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  put('secrets/hidden.ts', code('hiddenFn'))
  put('open/visible.ts', code('visibleFn'))
  put('secrets/notes.md', `# Hidden Notes\n\n${SECRET} vault\n`)
  put('open/notes.md', `# Visible Notes\n\n${SECRET} ledger\n`)
  put('secrets/log.txt', `${SECRET} captured\n`)
  put('open/log.txt', `${SECRET} captured\n`)
  const indexed = cli(['index', '--walk', proj])
  if (indexed.status !== 0) throw new Error(`index failed: ${indexed.stderr.slice(0, 300)}`)
})

afterAll(() => {
  if (proj !== '') fs.rmSync(proj, { recursive: true, force: true })
})

interface Row {
  name: string
  denied: string[]
  open: string[]
  /** What the open run prints. */
  shows: string
  /** True when the denied run refuses with exit 1; false when it omits the path and still succeeds. */
  refuses: boolean
}

/** `H` and `V` stand for the hidden and the visible symbol, so a row names one pair. */
function row(name: string, denied: string[], open: string[], shows: string, refuses: boolean): Row {
  const swap = (args: string[], to: string): string[] => args.map((a) => (a === 'H' || a === 'V' ? to : a))
  return { name, denied: swap(denied, 'hiddenFn'), open: swap(open, 'visibleFn'), shows, refuses }
}

const ROWS: Row[] = [
  row('symbol text', ['symbol', 'H'], ['symbol', 'V'], SECRET, false),
  row('symbol --json', ['symbol', 'H', '--json'], ['symbol', 'V', '--json'], SECRET, false),
  row('semantic', ['semantic', 'H'], ['semantic', 'V'], 'visibleFn', false),
  row('refs context', ['refs', 'H', '-C', '1'], ['refs', 'V', '-C', '1'], 'visibleFn', false),
  row('search', ['search', 'H'], ['search', 'V'], 'visibleFn', false),
  row('search text channel', ['search', 'vault'], ['search', 'ledger'], 'open', false),
  row('outline', ['outline', 'secrets/hidden.ts'], ['outline', 'open/visible.ts'], 'visibleFn', true),
  row('skeleton', ['skeleton', 'secrets/hidden.ts'], ['skeleton', 'open/visible.ts'], 'visibleFn', true),
  row(
    'bash-output --file',
    ['bash-output', '--file', 'secrets/log.txt'],
    ['bash-output', '--file', 'open/log.txt'],
    SECRET,
    true,
  ),
]

describe.each(ROWS)('$name', (row) => {
  it('never prints the denied text and says so in one [tg] line naming the rule source', () => {
    const run = cli(row.denied)
    expect(`${run.stdout}${run.stderr}`).not.toContain(SECRET)
    expect(run.stderr).toContain('[tg] ')
    expect(run.stderr).toContain('secrets')
    expect(run.stderr).toContain(path.join(proj, '.claude', 'settings.json'))
    if (row.refuses) expect(run.status).toBe(1)
  })

  it('leaves an allowed file alone', () => {
    const run = cli(row.open)
    expect(run.stderr).not.toContain('read refused')
    // A whole-index search may still omit the other directory's hits; it never names the allowed one.
    expect(run.stderr).not.toMatch(/omitted:.*[/\\]open[/\\]/)
    expect(run.stdout).toContain(row.shows)
  })
})

describe('mixed results', () => {
  it('search prints the allowed hit and omits the denied one', () => {
    const run = cli(['search', 'Fn'])
    expect(run.stdout).toContain('visibleFn')
    expect(run.stdout).not.toContain('hiddenFn')
    expect(run.stderr).toContain('omitted:')
  })
})

describe('in-process emitters', () => {
  it('resolveBody refuses an indented stored body of a denied file without a disk read', async () => {
    const { resolveBody } = await import('../src/read_commands.js')
    const { resetReadDenyCache, ReadDeniedError } = await import('../src/read_deny.js')
    const here = process.cwd()
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    try {
      process.chdir(proj)
      resetReadDenyCache()
      const filePath = path.join(proj, 'secrets', 'hidden.ts')
      const entry = { filePath, body: `  ${SECRET}`, lineStart: 1, lineEnd: 1 }
      let thrown: unknown = null
      try {
        resolveBody(entry as never)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ReadDeniedError)
      expect(String((thrown as Error).message)).not.toContain(SECRET)
    } finally {
      process.chdir(here)
      if (saved !== undefined) process.env['CLAUDE_PROJECT_DIR'] = saved
      resetReadDenyCache()
    }
  })

  it('dropDeniedRows keeps allowed rows and names each denied path once', async () => {
    const { dropDeniedRows, resetReadDenyCache } = await import('../src/read_deny.js')
    const here = process.cwd()
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    try {
      process.chdir(proj)
      resetReadDenyCache()
      const rows = [
        { filePath: path.join(proj, 'secrets', 'hidden.ts') },
        { filePath: path.join(proj, 'secrets', 'hidden.ts') },
        { filePath: path.join(proj, 'open', 'visible.ts') },
      ]
      const kept = dropDeniedRows(rows, (r) => r.filePath)
      expect(kept.map((r) => r.filePath)).toEqual([path.join(proj, 'open', 'visible.ts')])
    } finally {
      process.chdir(here)
      if (saved !== undefined) process.env['CLAUDE_PROJECT_DIR'] = saved
      resetReadDenyCache()
    }
  })
})
