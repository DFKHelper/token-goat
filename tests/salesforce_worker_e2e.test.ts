/**
 * Salesforce DX regression coverage for the two shipping seams:
 *
 * 1. the worker drains dirty.txt with its real default indexer (no injected
 *    callback), and
 * 2. the built CLI indexes and surgically reads the same fixture.
 *
 * Keep this fixture deliberately small but cross-layer: Apex, an LWC bundle,
 * detailed metadata, Flow references, and an otherwise unknown *-meta.xml.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDb } from '../src/db.js'
import { queryRefs, querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

import { BUNDLE } from './helpers/bundle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'salesforce-dx')

const tempDirs = new Set<string>()

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

function copyFixture(): string {
  const repo = tempDir('tg-salesforce-repo-')
  fs.cpSync(FIXTURE, repo, { recursive: true })
  return repo
}

function fixtureFiles(repo: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.name !== 'sfdx-project.json') files.push(normalizePath(absolute))
    }
  }
  visit(repo)
  return files.sort()
}

function writeDirtyQueue(dataDir: string, files: readonly string[]): void {
  const queue = path.join(dataDir, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(queue), { recursive: true })
  fs.writeFileSync(queue, `${files.join('\n')}\n`)
}

function runBundle(
  repo: string,
  dataBase: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    // token-goat follows platformdirs semantics: macOS derives its data dir from HOME,
    // Linux from XDG_DATA_HOME, and Windows from LOCALAPPDATA/USERPROFILE.
    env: {
      ...process.env,
      HOME: dataBase,
      USERPROFILE: dataBase,
      LOCALAPPDATA: dataBase,
      XDG_DATA_HOME: dataBase,
    },
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

describe('Salesforce DX worker default path', () => {
  it('drains Apex, LWC, Flow, and metadata into searchable symbols and refs', async () => {
    const repo = copyFixture()
    const dataDir = tempDir('tg-salesforce-worker-data-')
    const files = fixtureFiles(repo)
    writeDirtyQueue(dataDir, files)

    expect(drainOnce(dataDir)).toBe(files.length)

    // makeIndexer fires embedding fire-and-forget (the drain loop must return instantly), and
    // worker.ts's global concurrency cap (config.worker.max_pool_workers) can defer a queued
    // file's embed call -- including its very first getDb() connection open -- until well after
    // drainOnce() itself returns. Without waiting for that work to actually finish here, the
    // afterEach cleanup's fs.rmSync(dataDir) can race a queued embed call that opens its own DB
    // connection AFTER this test's own closeDb() below already ran, leaking an open handle that
    // Windows then holds a lock on, failing the directory removal with EPERM.
    await pendingEmbeddings()

    const dbPath = path.join(dataDir, 'global.db')
    try {
      expect(querySymbols({ name: 'AccountController' }, dbPath)[0]).toMatchObject({
        kind: 'apex_class',
      })
      expect(querySymbols({ name: 'loadAccount' }, dbPath)[0]).toMatchObject({
        kind: 'apex_method',
      })
      // Safe-navigation is covered on the real worker path, including methods after it. The
      // fixture also contains an apostrophe in a preceding line comment, the historical masker
      // failure that could blank the remainder of an otherwise valid Apex file.
      for (const name of [
        'hasDirectName',
        'hasRelatedName',
        'logRelatedName',
        'finishWork',
        'afterFinish',
        'finalMethod',
      ]) {
        expect(querySymbols({ name }, dbPath)[0], name).toMatchObject({
          kind: 'apex_method',
        })
      }

      // The LWC bundle and its public API are addressable across JS/template/metadata files.
      // Pin the exact deterministic count -- and kind, matching this fixture's own JS/HTML
      // origin for each name -- rather than a bare ">0", so a regression that resolved the
      // name to the wrong file or duplicated/dropped an entry is caught too.
      expect(querySymbols({ name: 'accountCard' }, dbPath)).toMatchObject([{ kind: 'lwc_bundle' }])
      expect(querySymbols({ name: 'recordId' }, dbPath)).toMatchObject([{ kind: 'lwc_api_property' }])
      expect(querySymbols({ name: 'refresh' }, dbPath)).toMatchObject([
        { kind: 'lwc_api_method' },
        { kind: 'method' },
      ])
      expect(querySymbols({ name: 'refreshButton' }, dbPath)).toMatchObject([{ kind: 'lwc_ref' }])
      expect(querySymbols({ name: 'variant' }, dbPath)).toMatchObject([{ kind: 'sf_lwc_property' }])

      // Selected metadata receives qualified symbols, while an unknown metadata type
      // still gets a stable top-level symbol and never stores the whole XML body.
      expect(querySymbols({ name: 'Account.Business' }, dbPath)[0]).toMatchObject({
        kind: 'sf_record_type',
      })
      expect(querySymbols({ name: 'OddThing' }, dbPath)[0]).toMatchObject({
        kind: 'sf_mystery_type',
        body: '',
      })

      // Canonical cross-file names make navigation independent of import aliases. Pin the exact
      // deterministic count of refs per name -- both AccountController.loadAccount and
      // Account.Name are referenced once from the Flow metadata's XML tag and once from the
      // LWC JS import, so a resolver regression that drops (or double-counts) either origin is
      // caught, not just "at least one ref exists somewhere".
      expect(queryRefs({ name: 'AccountController.loadAccount' }, dbPath).length).toBe(2)
      expect(queryRefs({ name: 'Account.Name' }, dbPath).length).toBe(2)
      expect(queryRefs({ name: 'refresh' }, dbPath).length).toBe(1)
      expect(queryRefs({ name: 'c-child-card' }, dbPath).length).toBe(1)
      expect(queryRefs({ name: 'Child_Account_Flow' }, dbPath).length).toBe(1)
    } finally {
      closeDb(dbPath)
    }
  })
})

describe('Salesforce DX built bundle smoke', () => {
  it('indexes the fixture and serves symbol, read, and refs from dist', () => {
    const repo = copyFixture()
    const dataBase = tempDir('tg-salesforce-bundle-data-')
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

    const indexed = runBundle(repo, dataBase, ['index', repo])
    expect(indexed.status, indexed.stderr).toBe(0)
    expect(indexed.stdout).toMatch(/Indexed \d+ files/)

    // Exercise every user-visible read seam against the shipped bundle, not only the adapter.
    const apexFile = 'force-app/main/default/classes/SafeNavigationService.cls'
    const outline = runBundle(repo, dataBase, ['outline', apexFile])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('SafeNavigationService')
    for (const name of [
      'hasDirectName',
      'hasRelatedName',
      'logRelatedName',
      'finishWork',
      'afterFinish',
      'finalMethod',
    ]) {
      expect(outline.stdout, name).toContain(name)
    }

    const safeNavigationSymbol = runBundle(repo, dataBase, ['symbol', 'hasRelatedName'])
    expect(safeNavigationSymbol.status, safeNavigationSymbol.stderr).toBe(0)
    expect(safeNavigationSymbol.stdout).toContain('account?.Parent?.Name')

    const methodAfterSafeNavigation = runBundle(repo, dataBase, [
      'read',
      `${apexFile}::finishWork`,
    ])
    expect(methodAfterSafeNavigation.status, methodAfterSafeNavigation.stderr).toBe(0)
    expect(methodAfterSafeNavigation.stdout).toContain('public void finishWork()')

    const fullClass = runBundle(repo, dataBase, ['read', `${apexFile}::SafeNavigationService`])
    expect(fullClass.status, fullClass.stderr).toBe(0)
    expect(fullClass.stdout).toContain('public void finalMethod()')

    const symbol = runBundle(repo, dataBase, ['symbol', 'accountCard'])
    expect(symbol.status, symbol.stderr).toBe(0)
    expect(symbol.stdout).toContain('accountCard')

    const read = runBundle(repo, dataBase, [
      'read',
      'force-app/main/default/classes/AccountController.cls::loadAccount',
    ])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('public static Account loadAccount')

    const refs = runBundle(repo, dataBase, ['refs', 'AccountController.loadAccount'])
    expect(refs.status, refs.stderr).toBe(0)
    expect(refs.stdout).toContain('accountCard.js')
  }, 60_000)
})
