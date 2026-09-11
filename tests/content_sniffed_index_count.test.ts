/**
 * A file whose language is decided by content (an ABL `.p`, an Objective-C `.m`) must be indexed and counted by every
 * path that feeds the indexer: `index --walk`, the git-tracked `index`, and the worker draining its dirty queue through
 * the real default indexer. `index . --walk` once printed "Indexed 5 files" for 6 files, because the walk read each
 * file's head to admit it while the index loop checked the path alone and dropped the `.p`.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

let TMP: string
let dbPath: string

/** The indexable files: two found by content, one by path. */
function seed(): string[] {
  const files = [
    ['Sample.p', 'orders.p'],
    ['Sample.m', 'AFSecurityPolicy.m'],
    ['Sample.sol', 'Ownable.sol'],
  ].map(([src, dst]) => {
    const target = path.join(TMP, dst!)
    fs.copyFileSync(path.join(FIXTURES, src!), target)
    return target
  })
  // Same-extension files of the other language: neither indexed nor counted.
  fs.copyFileSync(path.join(FIXTURES, 'mathematica_package.m'), path.join(TMP, 'Collatz.m'))
  fs.copyFileSync(path.join(FIXTURES, 'prolog_pairs.pl'), path.join(TMP, 'pairs.pl'))
  return files
}

async function captureIndex(opts: Parameters<typeof cmdIndex>[1]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await cmdIndex(TMP, opts)
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

function expectIndexed(db: string): void {
  expect(querySymbols({ name: 'calcTotal', limit: 10 }, db).length, 'ABL .p').toBe(1)
  expect(querySymbols({ name: 'AFServerTrustIsValid', limit: 10 }, db).length, 'Objective-C .m').toBe(1)
  expect(querySymbols({ name: 'onlyOwner', limit: 10 }, db).length, 'Solidity').toBe(1)
}

beforeEach(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sniffed-count-')))
  dbPath = path.join(TMP, 'index.db')
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('content-sniffed extensions are indexed and counted on every path', () => {
  it('index --walk counts and indexes every file it admits', async () => {
    seed()
    const out = await captureIndex({ dbPath, walk: true })
    expect(out).toContain('Indexed 3 files into the symbol index.')
    expectIndexed(dbPath)
  })

  it('the git-tracked index counts and indexes them too', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: TMP, stdio: 'ignore' })
    }
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    seed()
    git('add', '-A')
    git('commit', '-qm', 'seed')
    const out = await captureIndex({ dbPath })
    expect(out).toContain('Indexed 3 files into the symbol index.')
    expectIndexed(dbPath)
  })

  it('the worker drains them through the real default indexer', async () => {
    const files = seed()
    const dataDir = path.join(TMP, 'data')
    const queue = path.join(dataDir, 'queue', 'dirty.txt')
    fs.mkdirSync(path.dirname(queue), { recursive: true })
    fs.writeFileSync(queue, `${files.join('\n')}\n`)
    expect(drainOnce(dataDir)).toBe(files.length)
    await pendingEmbeddings()
    expectIndexed(path.join(dataDir, 'global.db'))
  })
})
