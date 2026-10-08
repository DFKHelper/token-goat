/** `changed` against a repo too short for its default HEAD~5 used to spend five git spawns on the CLI and six on the MCP tool (the hint walked one `rev-parse` per candidate, and the project root was resolved before the diff was known to have worked); on a loaded machine each spawn costs seconds, so one failed call took 9 s and more. These pin the spawn counts through the built bundle's real entries, with a preload that records every git spawn. */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(repoRoot, 'dist', 'token-goat.mjs')
const probe = path.join(repoRoot, 'tests', 'helpers', 'git-spawn-probe.cjs').replaceAll('\\', '/')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-changed-spawns-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

// HAND-DERIVED: the repos are built by git itself from the commands below; the expected `HEAD~n` is the first-parent depth of the history each one creates (linear: commits - 1; merge repo: 2 trunk commits + 1 merge = 3 first-parent commits, so HEAD~2).
function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
}

function repo(name: string, build: (dir: string) => void): string {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  build(dir)
  return dir
}

function commit(dir: string, file: string): void {
  fs.writeFileSync(path.join(dir, file), `export const ${file.replace(/\W/g, '_')} = 1\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', file)
}

const linear = repo('linear', (d) => {
  for (const f of ['a1.ts', 'a2.ts', 'a3.ts']) commit(d, f)
})

// Two trunk commits, a side branch of six commits, then a --no-ff merge: nine commits in all, three on the first-parent chain.
const merged = repo('merged', (d) => {
  commit(d, 't1.ts')
  commit(d, 't2.ts')
  git(d, 'checkout', '-q', '-b', 'side')
  for (let i = 1; i <= 6; i++) commit(d, `s${String(i)}.ts`)
  git(d, 'checkout', '-q', 'main')
  git(d, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
})

// A rename with an edit, a binary file, a deleted file, a path with a space and a wholly new file, all in one commit on top of a base commit.
function buildMixed(d: string): void {
  const body = (n: number): string => `export function one() {\n  return ${String(n)}\n}\nexport function two() {\n  return 2\n}\n`
  fs.writeFileSync(path.join(d, 'old_name.ts'), body(1))
  fs.writeFileSync(path.join(d, 'deleted.ts'), 'export function gone() { return 0 }\n')
  fs.writeFileSync(path.join(d, 'sp ace.ts'), 'export function sp() { return 1 }\n')
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 1, 2, 98]))
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', 'base')
  git(d, 'mv', 'old_name.ts', 'new_name.ts')
  fs.writeFileSync(path.join(d, 'new_name.ts'), body(11))
  git(d, 'rm', '-q', 'deleted.ts')
  fs.writeFileSync(path.join(d, 'sp ace.ts'), 'export function sp() { return 2 }\n')
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 1, 2, 99, 99]))
  fs.writeFileSync(path.join(d, 'fresh.ts'), 'export function fresh() { return 5 }\n')
  git(d, 'add', '-A')
  git(d, 'commit', '-q', '-m', 'change')
}
const mixed = repo('mixed', buildMixed)
// The same commit in a repo whose config turns rename detection off: `--name-only` then lists the old path too, and the file list `changed` takes has to keep doing so.
const mixedNoRenames = repo('mixed-norenames', (d) => {
  git(d, 'config', 'diff.renames', 'false')
  buildMixed(d)
})

function envFor(name: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: string } {
  const home = path.join(scratch, `home-${name}`)
  fs.mkdirSync(home, { recursive: true })
  const log = path.join(scratch, `spawns-${name}.jsonl`)
  return {
    log,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${probe}"`,
      TOKEN_GOAT_HOME: home,
      XDG_DATA_HOME: path.join(home, 'xdg'),
      LOCALAPPDATA: path.join(home, 'lad'),
      USERPROFILE: home,
      TOKEN_GOAT_BASH_COMPRESS: '0',
      TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      GIT_SPAWN_PROBE_OUT: log,
      ...extra,
    },
  }
}

function spawned(log: string): string[][] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
}

function cliChanged(dir: string, name: string, extra: Record<string, string> = {}): { stderr: string; git: string[][] } {
  const { env, log } = envFor(name, extra)
  const res = spawnSync(process.execPath, [bundle, 'changed'], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 })
  expect(res.status, res.stderr).toBe(1)
  return { stderr: res.stderr, git: spawned(log) }
}

function cliOk(dir: string, name: string, args: string[]): { stdout: string; git: string[][] } {
  const { env, log } = envFor(name)
  const res = spawnSync(process.execPath, [bundle, 'changed', ...args], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 })
  expect(res.status, res.stderr).toBe(0)
  return { stdout: res.stdout, git: spawned(log) }
}

async function mcpChanged(dir: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; git: string[][] }> {
  const { env, log } = envFor(name)
  const child = spawn(process.execPath, [bundle, 'mcp-serve'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] })
  child.stdin.on('error', () => undefined)
  const pending = new Map<number, (m: { result?: { content?: Array<{ text?: string }> } }) => void>()
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i = buf.indexOf('\n')
    while (i >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } }
        if (m.id !== undefined) pending.get(m.id)?.(m)
      } catch {
        // not a JSON-RPC line
      }
      i = buf.indexOf('\n')
    }
  })
  const send = (id: number, method: string, params: unknown): Promise<{ result?: { content?: Array<{ text?: string }> } }> =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'spawn-count', version: '0' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const reply = await send(2, 'tools/call', { name: 'changed', arguments: { projectRoot: dir, ...args } })
    return { text: reply.result?.content?.[0]?.text ?? '', git: spawned(log) }
  } finally {
    child.kill()
  }
}

const subcommands = (rows: string[][]): string[] => rows.map((r) => r[0] ?? '')

describe('changed on a repo shorter than HEAD~5: git spawn counts through the built bundle', () => {
  it('CLI, linear history: diff, one rev-list count, one batched ref check, and nothing else', () => {
    const { stderr, git: rows } = cliChanged(linear, 'cli-linear')
    expect(stderr).toContain('Try: token-goat changed --since HEAD~2')
    expect(subcommands(rows)).toEqual(['diff', 'rev-list', 'cat-file'])
  }, 120_000)

  it('CLI, merge-heavy history: the candidates are answered by the same one batch, not one spawn each', () => {
    const { stderr, git: rows } = cliChanged(merged, 'cli-merged')
    expect(stderr).toContain('this repo has only 9 commits')
    expect(stderr).toContain('Try: token-goat changed --since HEAD~2')
    expect(subcommands(rows)).toEqual(['diff', 'rev-list', 'cat-file'])
  }, 120_000)

  it('CLI, cat-file refused: falls back to one rev-parse per name and still gives the same suggestion', () => {
    const { stderr, git: rows } = cliChanged(linear, 'cli-fallback', { GIT_SPAWN_PROBE_FAIL_CATFILE: '1' })
    expect(stderr).toContain('Try: token-goat changed --since HEAD~2')
    expect(subcommands(rows)).toEqual(['diff', 'rev-list', 'cat-file', 'rev-parse', 'rev-parse'])
  }, 120_000)

  it('MCP tool: the root is resolved once up front and not again after the failed diff', async () => {
    const { text, git: rows } = await mcpChanged(linear, 'mcp-linear')
    expect(text).toContain('Try: token-goat changed --since HEAD~2')
    expect(subcommands(rows)).toEqual(['rev-parse', 'diff', 'rev-list', 'cat-file'])
  }, 120_000)

  // CAPTURE: the text and the (before) five-spawn sequence come from the built bundle run on this repo shape before the change: `{"content":[{"type":"text","text":"a3.ts\n"}],"isError":false}` with rev-parse, rev-parse, diff, diff, diff.
  it('MCP tool, a ref that exists: the root the tool already resolved is not resolved a second time', async () => {
    const { text, git: rows } = await mcpChanged(linear, 'mcp-success', { ref: 'HEAD~1' })
    expect(text).toBe('a3.ts\n')
    expect(subcommands(rows)).toEqual(['rev-parse', 'diff', 'diff'])
  }, 120_000)

  // CAPTURE: the stdout is what the built bundle printed for this commit before the file list and the rename lookup were folded into one `--name-status` call.
  it('CLI, a commit with a rename, a binary, a delete and a spaced path: same listing, the root lookup and one extra diff for the rename are the only other calls', () => {
    const { stdout, git: rows } = cliOk(mixed, 'cli-mixed', ['--since', 'HEAD~1'])
    expect(stdout).toBe('bin.dat\ndeleted.ts\nfresh.ts\nnew_name.ts\nsp ace.ts\n')
    expect(rows[0]).toEqual(expect.arrayContaining(['HEAD~1', '--name-status']))
    expect(rows[0]).not.toContain('-M')
    expect(subcommands(rows)).toEqual(['diff', 'rev-parse', 'diff', 'diff'])
    expect(rows[3]?.join(' ')).toContain('old_name.ts')
  }, 120_000)

  it('CLI, a plain success: the file list, the root lookup and the one zero-context diff', () => {
    const { stdout, git: rows } = cliOk(linear, 'cli-success', ['--since', 'HEAD~1'])
    expect(stdout).toBe('a3.ts\n')
    expect(subcommands(rows)).toEqual(['diff', 'rev-parse', 'diff'])
  }, 120_000)

  it('MCP tool, the same mixed commit: same listing, one extra diff for the rename', async () => {
    const { text, git: rows } = await mcpChanged(mixed, 'mcp-mixed', { ref: 'HEAD~1' })
    expect(text).toBe('bin.dat\ndeleted.ts\nfresh.ts\nnew_name.ts\nsp ace.ts\n')
    expect(subcommands(rows)).toEqual(['rev-parse', 'diff', 'diff', 'diff'])
  }, 120_000)

  // CAPTURE: the expected listing is what the old file-list call, `git diff HEAD~1 --name-only`, prints in each repo, read from git itself here rather than typed in, so the config-dependent shape (old path listed too when renames are off) cannot drift from it.
  it.each([
    ['rename detection on', () => mixed],
    ['diff.renames = false', () => mixedNoRenames],
  ])('CLI and MCP list exactly what --name-only listed with %s', async (_label, pick) => {
    const dir = pick()
    const old = spawnSync('git', ['diff', 'HEAD~1', '--name-only'], { cwd: dir, encoding: 'utf8' }).stdout
    expect(old).toContain('new_name.ts')
    const cli = cliOk(dir, `cli-oldlist-${_label.length}`, ['--since', 'HEAD~1'])
    expect(cli.stdout).toBe(old)
    const mcp = await mcpChanged(dir, `mcp-oldlist-${_label.length}`, { ref: 'HEAD~1' })
    expect(mcp.text).toBe(old)
  }, 120_000)

  it('diff.renames = false: the old path is listed too and no extra diff is spent looking for a rename', () => {
    const { stdout, git: rows } = cliOk(mixedNoRenames, 'cli-norenames', ['--since', 'HEAD~1'])
    expect(stdout.split('\n')).toContain('old_name.ts')
    expect(subcommands(rows)).toEqual(['diff', 'rev-parse', 'diff'])
  }, 120_000)

  // CAPTURE: `token-goat: git diff failed: not a git repository` is what the built bundle returned for a directory outside any repo before the change.
  it('MCP tool, a directory outside any repo: the same error text as before', async () => {
    const outside = path.join(scratch, 'not-a-repo')
    fs.mkdirSync(outside)
    const { text, git: rows } = await mcpChanged(outside, 'mcp-outside', { ref: 'HEAD~1' })
    expect(text).toBe('token-goat: git diff failed: not a git repository\n')
    expect(subcommands(rows)).toEqual(['rev-parse', 'diff', 'rev-list'])
  }, 120_000)
})
