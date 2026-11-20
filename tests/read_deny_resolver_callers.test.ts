/** Each resolver caller honours the Read rules in its ambiguity and its miss lead. */
// Provenance: HAND-DERIVED. Rules use the documented Read(...) syntax; index rows and git history are by hand.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { runBlame, runSimilar } from '../src/graph_analysis.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { runDiff, runLog } from '../src/read_git.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

let root: string
let cfg: string
let cwdSpy: ReturnType<typeof vi.spyOn>
const saved: Record<string, string | undefined> = {}

function writeRules(deny: string[]): void {
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny } }))
  resetReadDenyCache()
  resetPermissionSourceCache()
}

function addSym(file: string, name: string, lines: [number, number] = [1, 1]): void {
  getDb(globalDbPath())
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`${normalizePath(root)}/${file}`, name, 'function', lines[0], lines[1], `function ${name}() {}`, '')
}

type Captured = { value: number | undefined; thrown: unknown; out: string; err: string }

function capture(fn: () => number): Captured {
  let out = ''
  let err = ''
  const o = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: unknown) => { out += String(c); return true }) as typeof process.stdout.write
  process.stderr.write = ((c: unknown) => { err += String(c); return true }) as typeof process.stderr.write
  try {
    try {
      return { value: fn(), thrown: undefined, out, err }
    } catch (thrown) {
      return { value: undefined, thrown, out, err }
    }
  } finally {
    process.stdout.write = o
    process.stderr.write = e
  }
}

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, stdio: 'ignore' },
  )
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18r-')))
  cfg = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fx18r-cfg-')))
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']) saved[k] = process.env[k]
  process.env['CLAUDE_CONFIG_DIR'] = cfg
  process.env['CLAUDE_PROJECT_DIR'] = root
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  for (const dir of ['vault', 'src', 'lib']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  for (const dir of ['vault', 'src', 'lib']) {
    fs.writeFileSync(path.join(root, dir, 'util.ts'), 'export function Dup() {}\n')
    fs.writeFileSync(path.join(root, dir, 'other.ts'), 'export function Elsewhere() {}\n')
  }
  git('init')
  git('add', 'vault', 'src', 'lib')
  git('commit', '-m', 'seed')
  fs.appendFileSync(path.join(root, 'src', 'util.ts'), '// changed\n')
  writeRules(['Read(vault/**)'])
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  // Rows an earlier row left under its own temp root are candidates of this one too: start from an empty index.
  getDb(globalDbPath()).prepare('DELETE FROM symbols').run()
})

afterEach(() => {
  cwdSpy.mockRestore()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetReadDenyCache()
  resetPermissionSourceCache()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(cfg, { recursive: true, force: true })
})

// `similar` lists its own full-text hits on stdout, which this row does not judge: it reads stderr and the exit code.
const callers: Array<{ name: string; stdoutIsResolverOnly: boolean; run: (spec: string) => Captured }> = [
  { name: 'diff', stdoutIsResolverOnly: true, run: (spec) => capture(() => runDiff({ spec, projectRoot: root })) },
  { name: 'log', stdoutIsResolverOnly: true, run: (spec) => capture(() => runLog({ spec, projectRoot: root })) },
  { name: 'similar', stdoutIsResolverOnly: false, run: (spec) => capture(() => runSimilar({ spec })) },
  { name: 'blame', stdoutIsResolverOnly: true, run: (spec) => capture(() => runBlame({ spec, cwd: root })) },
]

describe.each(callers)('$name resolves its spec through the Read-aware resolver', ({ run, stdoutIsResolverOnly }) => {
  it('resolves an ambiguity between an allowed and a denied file to the allowed one', () => {
    addSym('src/util.ts', 'Dup')
    addSym('vault/util.ts', 'Dup')
    const r = run('util.ts::Dup')
    expect(r.value, 'the ambiguity was not resolved to the allowed file').toBe(0)
    expect(r.err).not.toContain('vault')
    expect(r.err).not.toMatch(/ambiguous/i)
    if (stdoutIsResolverOnly) expect(r.out).not.toContain('vault')
  })

  it('names the allowed candidate and omits the denied one in the lead of a miss', () => {
    addSym('src/util.ts', 'Dup')
    addSym('lib/other.ts', 'Elsewhere')
    addSym('vault/other.ts', 'Elsewhere')
    const r = run('src/util.ts::Elsewhere')

    expect(r.out + r.err, 'the lead dropped the allowed candidate').toContain('lib/other.ts')
    expect(r.out + r.err).not.toContain('vault')
  })
})

describe('similar lists only hits from files the Read rules allow', () => {
  it('prints the allowed hit alone and counts one when an allowed and a denied hit match', () => {
    addSym('src/util.ts', 'Dup')
    addSym('lib/util.ts', 'Dup')
    addSym('vault/util.ts', 'Dup')
    const r = capture(() => runSimilar({ spec: 'src/util.ts::Dup', top: 1 }))
    expect(r.value).toBe(0)
    expect(r.out, 'the denied hit was printed').not.toContain('vault')
    expect(r.err, 'the denied hit was counted or named').not.toContain('vault')
    expect(r.out, 'the allowed hit was dropped').toContain('lib/util.ts')
    expect(r.err, 'the denied hit was counted').toBe('')
    const json = capture(() => runSimilar({ spec: 'src/util.ts::Dup', json: true }))
    expect(json.out, 'the denied hit reached the json output').not.toContain('vault')
    expect(JSON.parse(json.out), 'the json lost the allowed hit or kept the denied one').toHaveLength(1)
  })

  it('counts the allowed hits only in the truncation notice', () => {
    addSym('src/util.ts', 'Dup')
    addSym('lib/util.ts', 'Dup')
    addSym('lib/other.ts', 'Dup')
    addSym('vault/util.ts', 'Dup')
    addSym('vault/other.ts', 'Dup')
    const r = capture(() => runSimilar({ spec: 'src/util.ts::Dup', top: 1 }))
    expect(r.err, 'the notice counted a denied hit').toContain('Showing top 1 of 2 similar')
  })

  it('prints the ordinary none-found text when only a denied file matches', () => {
    addSym('src/util.ts', 'Dup')
    addSym('vault/util.ts', 'Dup')
    const denied = capture(() => runSimilar({ spec: 'src/util.ts::Dup' }))
    expect(denied.out + denied.err).not.toContain('vault')
    expect(denied.out, 'a denied-only match printed a row').toBe('')
    const deniedJson = capture(() => runSimilar({ spec: 'src/util.ts::Dup', json: true }))
    expect(JSON.parse(deniedJson.out), 'a denied-only match listed a row in json').toEqual([])
    writeRules([])
    const open = capture(() => runSimilar({ spec: 'src/util.ts::Dup' }))
    expect(open.out, 'with no rules the hit must still print').toContain('vault/util.ts')
  })
})
