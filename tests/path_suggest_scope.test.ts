/** What suggestPaths (src/path_suggest.ts) may reach and name: only the project (or the working directory when nothing marks one), never a credential file name, never a vendored, configured-skip or excluded tree. Every expectation is HAND-DERIVED from the tree built below: the spelling asked for is one edit from a file that exists, so each [] is a candidate the rule removed, and each control case beside it shows the same lookup answering when the rule has nothing to remove. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as Config from '../src/config.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({ skip: [] as string[], blocked: [] as string[] }))

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof Config>()
  return {
    ...real,
    loadConfig: () => {
      const cfg = real.loadConfig()
      return { ...cfg, indexing: { ...cfg.indexing, skip_dirs: scope.skip }, worker: { ...cfg.worker, blocked_roots: scope.blocked } }
    },
  }
})

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { suggestPaths } from '../src/path_suggest.js'

let base: string
let project: string
let outside: string
let plain: string

function put(root: string, rel: string, body = 'export const marker = 1\n'): string {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body, 'utf8')
  return file
}

const ask = (missing: string, root: string | null = project, cwd: string = project): string[] => suggestPaths(missing, cwd, root)

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-ps-scope-')))
  project = join(base, 'project')
  outside = join(base, 'outside')
  plain = join(base, 'plain')
  put(project, 'package.json', '{"name":"scope"}\n')
  put(project, 'src/config.ts')
  put(project, 'src/app.ts')
  put(project, '.env.local', 'TOKEN=abc\n')
  put(project, '.env.example', 'TOKEN=\n')
  put(project, 'certs/server.pem', 'pem\n')
  put(project, 'id_rsa', 'key\n')
  put(project, '.npmrc', 'token\n')
  put(project, 'credentials.json', '{}\n')
  put(project, 'node_modules/pkg/index.ts')
  put(project, 'vendor_custom/helper.ts')
  put(project, 'blocked/thing.ts')
  indexFileSync(normalizePath(put(project, 'deploy/credentials.ts')))
  indexFileSync(normalizePath(put(project, 'deploy/release_notes.ts')))
  put(outside, 'config.ts')
  put(outside, 'notes.txt', 'private\n')
  symlinkSync(outside, join(project, 'link'), 'junction')
  indexFileSync(normalizePath(put(plain, 'proj/config.ts')))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('confined to the project', () => {
  it('names a file inside the project (the control for the rest)', () => {
    expect(ask('src/confg.ts')).toEqual(['src/config.ts'])
  })

  it('offers nothing for an absolute path in a directory outside the project', () => {
    expect(ask(join(outside, 'confg.ts'))).toEqual([])
  })

  it('offers nothing for a relative path that climbs out of the project', () => {
    expect(ask('../outside/confg.ts')).toEqual([])
  })

  it('does not confirm an outside file through a spelling variant', () => {
    expect(ask('@../outside/config.ts')).toEqual([])
  })

  it('does not follow a link inside the project to a directory outside it', () => {
    expect(ask('link/confg.ts')).toEqual([])
  })

  it('offers nothing for a case-only mismatch outside the project', () => {
    expect(ask(join(outside, 'CONFIG.ts'))).toEqual([])
  })
})

describe('credential file names are never offered', () => {
  it.each([
    ['.env.local', '.env.locl'],
    ['certs/server.pem', 'certs/server.pen'],
    ['id_rsa', 'id_rsb'],
    ['.npmrc', '.npmr'],
    ['credentials.json', 'credential.json'],
  ])('leaves out %s for %s', (_name, typed) => {
    expect(ask(typed)).toEqual([])
  })

  it('does not name a credential file by correcting only its letter case', () => {
    expect(ask('.ENV.LOCAL')).toEqual([])
  })

  it('leaves out an indexed file of that name found by its bare name', () => {
    expect(ask('credentials.ts')).toEqual([])
  })

  it('still names the template of an env file', () => {
    expect(ask('.env.exampl')).toEqual(['.env.example'])
  })

  it('still names an indexed file of an ordinary name found by its bare name', () => {
    expect(ask('release_notes.ts')).toEqual(['deploy/release_notes.ts'])
  })
})

describe('excluded trees are never offered', () => {
  it('leaves out a name beside the missing path inside a vendored tree', () => {
    expect(ask('node_modules/pkg/inde.ts')).toEqual([])
  })

  it('leaves out a configured skip_dirs directory, and names its file once it is not configured', () => {
    scope.skip = ['vendor_custom']
    try {
      expect(ask('vendor_custom/helpr.ts')).toEqual([])
    } finally {
      scope.skip = []
    }
    expect(ask('vendor_custom/helpr.ts')).toEqual(['vendor_custom/helper.ts'])
  })

  it('leaves out an excluded project root, and names its file once it is not excluded', () => {
    scope.blocked = [join(project, 'blocked')]
    try {
      expect(ask('blocked/thng.ts')).toEqual([])
    } finally {
      scope.blocked = []
    }
    expect(ask('blocked/thng.ts')).toEqual(['blocked/thing.ts'])
  })
})

describe('where no project is marked', () => {
  it('reads no index: a directory that merely contains projects is not one', () => {
    expect(ask('confg.ts', plain, plain)).toEqual([])
  })

  it('answers from the index once a marker makes it a project (the control)', () => {
    put(plain, 'package.json', '{"name":"plain"}\n')
    expect(ask('confg.ts', plain, plain)).toEqual(['proj/config.ts'])
  })

  it('lists no directory above the working directory', () => {
    expect(ask('confg.ts', null, join(project, 'src'))).toEqual(['config.ts'])
    expect(ask('../package.jsn', null, join(project, 'src'))).toEqual([])
  })
})
