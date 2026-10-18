// What this file proves about content a handoff only names in its text: handoff-create and the MCP handoff_create tool say, per id, that it is already gone or when it expires, and that a handoff keeps only its own text; retrieve of an id the cache has dropped names the handoff that mentioned it. Nothing here keeps a blob past its age limit.

// HAND-DERIVED: every age is set with utimes (an integer number of seconds, so the expected time is exact), never by waiting; the expected times are the file mtime plus the 24 h age limit written out in UTC (the child runs with TZ=UTC, so its local time is UTC) and are computed with toISOString, which is independent of the code's local-time formatter. The id shapes (tg_ plus 16 lower-case hex digits) are the ones the store mints; CAPTURE: tg_32d586e05da51fb5 is a real id an old handoff named in its text, the incident that started this work.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { compressText, createHandoff, namedContentNotes } from '../src/content_store.js'
import { createMcpServer } from '../src/mcp_server.js'
import { clearModuleCaches } from '../src/reset.js'
import { BUNDLE } from './helpers/bundle.js'
import { runTeardown } from './helpers/strict_teardown.js'

const isWin = process.platform === 'win32'
const DAY_MS = 24 * 3600 * 1000

let home: string
let envRoot: string
let projectDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_MCP_TOOLS', 'TZ']) saved[key] = process.env[key]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-named-'))
  const dataRoot = dataDirForHome(home)
  envRoot = isWin ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  process.env['TOKEN_GOAT_MCP_TOOLS'] = 'handoff_create,retrieve_text'
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-named-project-'))
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  runTeardown([() => fs.rmSync(home, { recursive: true, force: true }), () => fs.rmSync(projectDir, { recursive: true, force: true })])
})

function runCli(args: string[], cwd: string = projectDir): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot, TZ: 'UTC' }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function blobFile(id: string): string {
  return path.join(home, 'content', `${id}.json`)
}

// An integer number of seconds, so the expected time has no fraction to round.
function setAge(id: string, ageMs: number): number {
  const when = Math.floor((Date.now() - ageMs) / 1000) * 1000
  fs.utimesSync(blobFile(id), new Date(when), new Date(when))
  return when
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

// The gap a note states, in seconds (negative for after), read back from its words; null when the phrase is absent.
function statedGapSeconds(text: string, id: string): number | null {
  const match = new RegExp(`names content ${id}, which expires at [^,]+ [(]local time[)], (?:(\\d+) h)? ?(?:(\\d+) min)? ?(?:(\\d+) s)? ?(before|after) this handoff [(]this handoff lasts until`).exec(text)
  if (match === null) return null
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return match[4] === 'before' ? seconds : -seconds
}

function storeViaCli(text: string): string {
  const stored = runCli(['compress-text', text])
  expect(stored.status, stored.stderr).toBe(0)
  return /tg_[0-9a-f]{16}/.exec(stored.stdout)?.[0] as string
}

async function createViaMcp(name: string, text: string): Promise<{ isError: boolean; texts: string[] }> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: 'handoff_create', arguments: { name, text, projectRoot: projectDir } })
    return { isError: result.isError === true, texts: (result.content as Array<{ text: string }>).map((block) => block.text) }
  } finally {
    await client.close()
    await server.close()
  }
}

describe('handoff-create says what becomes of the content ids its text names', () => {
  it('says an id aged past the limit is already gone, exits 0, and keeps stdout the record alone', () => {
    const id = storeViaCli('table of results the handoff points at')
    setAge(id, 2 * DAY_MS)

    const created = runCli(['handoff-create', 'refs', `see ${id} for the table`])

    expect(created.status, created.stderr).toBe(0)
    expect(created.stderr).toContain(`names content ${id}, which is already gone`)
    expect(created.stderr).toContain('A handoff keeps only its own text')
    expect(Object.keys(JSON.parse(created.stdout) as object)).toEqual(['id', 'name', 'contentId', 'projectRoot', 'recovery'])
  })

  it('says when a live id expires and until when this handoff lasts', () => {
    const id = storeViaCli('table of results the handoff points at')
    const blobMtime = setAge(id, 3600 * 1000)

    const created = runCli(['handoff-create', 'refs', `see ${id} for the table`])

    expect(created.status, created.stderr).toBe(0)
    const handoffId = (JSON.parse(created.stdout) as { id: string }).id
    const handoffMtime = fs.statSync(blobFile(handoffId)).mtimeMs
    const lastsUntil = utc(Math.floor(handoffMtime / 1000) * 1000 + DAY_MS)
    expect(created.stderr).toContain(`names content ${id}, which expires at ${utc(blobMtime + DAY_MS)} (local time), `)
    expect(created.stderr).toContain(` before this handoff (this handoff lasts until ${lastsUntil}).`)
    expect(statedGapSeconds(created.stderr, id)).toBe(Math.floor(handoffMtime / 1000) - blobMtime / 1000)
    expect(created.stderr).toContain('A handoff keeps only its own text')
  })

  it('prints no note for a handoff that names no id, and its stdout is the record alone', () => {
    const created = runCli(['handoff-create', 'plain', 'a plan that names nothing'])

    expect(created.status, created.stderr).toBe(0)
    expect(created.stderr).toBe('')
    expect(Object.keys(JSON.parse(created.stdout) as object)).toEqual(['id', 'name', 'contentId', 'projectRoot', 'recovery'])
  })

  it('prints one note per distinct id, wherever in the text it appears, and none for a longer run of hex digits', () => {
    const first = storeViaCli('first referenced content')
    const second = storeViaCli('second referenced content')
    setAge(first, 2 * DAY_MS)
    setAge(second, 2 * DAY_MS)
    const longer = 'tg_0123456789abcdef0'
    const text = `(${first}) and ${second}; again ${first}, and a longer run ${longer}`

    const created = runCli(['handoff-create', 'refs', text])

    expect(created.status, created.stderr).toBe(0)
    const notes = created.stderr.split('\n').filter((line) => line.startsWith('note:'))
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain(first)
    expect(notes[1]).toContain(second)
    expect(created.stderr).not.toContain(longer)
  })

  // HAND-DERIVED: ids are tg_ plus 16 hex digits; a letter, digit or underscore touching either end makes the run a longer word, not an id. The id names no stored content, so a match would print an "already gone" note.
  it.each([
    ['a letter before it', 'see xtg_0123456789abcdef here'],
    ['an underscore-joined word before it', 'see my_tg_0123456789abcdef here'],
    ['a hex digit after it', 'see tg_0123456789abcdef0 here'],
    ['an underscore-joined word after it', 'see tg_0123456789abcdef_x here'],
  ])('prints no note for an id with %s', (_label, text) => {
    const created = runCli(['handoff-create', 'refs', text])

    expect(created.status, created.stderr).toBe(0)
    expect(created.stderr).not.toContain('note:')
  })

  it('prints a note for an id set off by punctuation or whitespace on both sides', () => {
    const id = 'tg_0123456789abcdef'

    for (const text of [`(${id}).`, `see ${id} here`, `${id}`]) {
      const created = runCli(['handoff-create', 'refs', text])

      expect(created.status, created.stderr).toBe(0)
      expect(created.stderr, text).toContain(`names content ${id}, which is already gone`)
    }
  })

  it('treats an id whose record cannot be read as present, not gone', () => {
    const id = storeViaCli('content with a damaged record')
    fs.writeFileSync(blobFile(id), '{not json', 'utf8')

    const created = runCli(['handoff-create', 'refs', `see ${id}`])

    expect(created.status, created.stderr).toBe(0)
    expect(created.stderr).toContain(`names content ${id} could not be read (SyntaxError)`)
    expect(created.stderr).not.toContain('already gone')
  })
})

// HAND-DERIVED: the content and the handoff blobs get exact mtimes with utimes (whole seconds, four hours back so the content is live), the handoff is created in-process, and the expected text is the mtime plus the 24 h limit written out in UTC with the process zone pinned to UTC; no clock is waited on.
describe('the note states how long before the handoff the content expires', () => {
  function noteFor(gapSeconds: number): { id: string; notes: string[]; contentMtime: number } {
    process.env['TZ'] = 'UTC'
    const contentMtime = Math.floor((Date.now() - 4 * 3600 * 1000) / 1000) * 1000
    const stored = compressText('table of results the handoff points at')
    fs.utimesSync(blobFile(stored.id), new Date(contentMtime), new Date(contentMtime))
    const created = createHandoff('refs', `see ${stored.id} for the table`, projectDir)
    const handoffMtime = contentMtime + gapSeconds * 1000
    fs.utimesSync(blobFile(created.id), new Date(handoffMtime), new Date(handoffMtime))
    return { id: stored.id, notes: namedContentNotes(created), contentMtime }
  }

  it('says 1 s before this handoff, not a pair of times that look equal, for a one second gap', () => {
    const { id, notes, contentMtime } = noteFor(1)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`names content ${id}, which expires at ${utc(contentMtime + DAY_MS)} (local time), 1 s before this handoff (this handoff lasts until ${utc(contentMtime + 1000 + DAY_MS)}).`)
  })

  it('says every unit of a larger gap', () => {
    const { id, notes, contentMtime } = noteFor(3725)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`names content ${id}, which expires at ${utc(contentMtime + DAY_MS)} (local time), 1 h 2 min 5 s before this handoff (this handoff lasts until ${utc(contentMtime + 3725 * 1000 + DAY_MS)}).`)
  })

  it('still prints the note when both expire in the same second', () => {
    const { id, notes, contentMtime } = noteFor(0)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`names content ${id}, which expires at ${utc(contentMtime + DAY_MS)} (local time), at the same second as this handoff (this handoff lasts until ${utc(contentMtime + DAY_MS)}).`)
  })

  it('says after when the content outlasts the handoff', () => {
    const { id, notes, contentMtime } = noteFor(-90)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`names content ${id}, which expires at ${utc(contentMtime + DAY_MS)} (local time), 1 min 30 s after this handoff (this handoff lasts until ${utc(contentMtime - 90 * 1000 + DAY_MS)}).`)
  })
})

describe('the handoff_create tool carries the same notes', () => {
  it('adds a second block stating the gap in the same words for live content', async () => {
    const stored = compressText('table of results the handoff points at')
    const blobMtime = setAge(stored.id, 3600 * 1000)

    const answer = await createViaMcp('refs', `see ${stored.id} for the table`)

    expect(answer.texts).toHaveLength(2)
    const handoffId = (JSON.parse(answer.texts[0] as string) as { id: string }).id
    const handoffMtime = fs.statSync(blobFile(handoffId)).mtimeMs
    expect(answer.texts[1]).toContain(`names content ${stored.id}, which expires at ${utc(blobMtime + DAY_MS)} (local time), `)
    expect(answer.texts[1]).toContain(` before this handoff (this handoff lasts until ${utc(Math.floor(handoffMtime / 1000) * 1000 + DAY_MS)}).`)
    expect(statedGapSeconds(answer.texts[1] as string, stored.id)).toBe(Math.floor(handoffMtime / 1000) - blobMtime / 1000)
  })

  it('adds a second block saying an aged id is already gone, after the record', async () => {
    const stored = compressText('table of results the handoff points at')
    setAge(stored.id, 2 * DAY_MS)

    const answer = await createViaMcp('refs', `see ${stored.id} for the table`)

    expect(answer.isError).toBe(false)
    expect(answer.texts).toHaveLength(2)
    expect(Object.keys(JSON.parse(answer.texts[0] as string) as object)).toEqual(['id', 'name', 'contentId', 'projectRoot', 'recovery'])
    expect(answer.texts[1]).toContain(`names content ${stored.id}, which is already gone`)
  })

  it('adds no block for a handoff that names no id', async () => {
    const answer = await createViaMcp('plain', 'a plan that names nothing')

    expect(answer.texts).toHaveLength(1)
  })
})

// A blob past the age limit is removed by the next write to the content store (storeBlob prunes), so the row ages it and then stores something else.
function pruneAfterAging(id: string): void {
  setAge(id, 2 * DAY_MS)
  expect(runCli(['compress-text', 'a later write that runs the prune']).status).toBe(0)
  expect(fs.existsSync(blobFile(id))).toBe(false)
}

const OLD_MESSAGE = (id: string): string => `no token-goat content for id: ${id}. The local cache may have expired.`

describe('retrieve says which handoff named an id the cache has dropped', () => {
  it('names the handoff, and the content limit, once a prune has removed the blob', () => {
    const id = storeViaCli('table of results the handoff points at')
    expect(runCli(['handoff-create', 'refs', `see ${id} for the table`]).status).toBe(0)
    pruneAfterAging(id)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.status).not.toBe(0)
    expect(retrieved.stderr).toContain(`content ${id} expired under the 24 h content limit`)
    expect(retrieved.stderr).toContain('handoff "refs" named it in the text')
    expect(retrieved.stderr).not.toContain('may have expired')
  })

  it('names every handoff that names it, newest first, and counts the ones it does not show', () => {
    const id = storeViaCli('table of results the handoff points at')
    // Each spawn finishes before the next starts, so the stored createdAt order is the creation order.
    for (const name of ['first', 'second', 'third', 'fourth', 'fifth']) expect(runCli(['handoff-create', name, `see ${id} (${name})`]).status).toBe(0)
    pruneAfterAging(id)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.stderr).toContain('handoffs "fifth", "fourth", "third" and 2 more named it in the text')
  })

  it('keeps the old message for an id no handoff names', () => {
    const id = 'tg_0000000000000000'

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.status).not.toBe(0)
    expect(retrieved.stderr).toContain(OLD_MESSAGE(id))
  })

  it('keeps the old message for an id only another project handoff names', () => {
    const id = storeViaCli('table of results the handoff points at')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-named-other-'))
    try {
      expect(runCli(['handoff-create', 'refs', `see ${id} for the table`], other).status).toBe(0)
      pruneAfterAging(id)

      const here = runCli(['retrieve', id])
      expect(here.stderr).toContain(OLD_MESSAGE(id))
      const there = runCli(['retrieve', id], other)
      expect(there.stderr).toContain('handoff "refs" named it in the text')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  // HAND-DERIVED: a junction on Windows, a directory symlink elsewhere. CAPTURE: with the built bundle, a handoff made through a link was not found by handoff-resolve from the link's target and the reverse, so the link and its target are two project roots; retrieve uses the same root key.
  it('treats a link and its target as two projects, as handoff-resolve does', () => {
    const real = path.join(projectDir, 'real-root')
    const link = path.join(projectDir, 'link-root')
    fs.mkdirSync(real)
    fs.symlinkSync(real, link, isWin ? 'junction' : 'dir')
    try {
      const id = storeViaCli('table of results the handoff points at')
      expect(runCli(['handoff-create', 'refs', `see ${id} for the table`], link).status).toBe(0)
      pruneAfterAging(id)

      expect(runCli(['retrieve', id], link).stderr).toContain('handoff "refs" named it in the text')
      expect(runCli(['retrieve', id], real).stderr).toContain(OLD_MESSAGE(id))
    } finally {
      fs.rmdirSync(link)
    }
  })

  it('does not count a handoff that is itself past the age limit', () => {
    const id = storeViaCli('table of results the handoff points at')
    const created = JSON.parse(runCli(['handoff-create', 'refs', `see ${id} for the table`]).stdout) as { id: string }
    setAge(created.id, 2 * DAY_MS)
    pruneAfterAging(id)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.stderr).toContain(OLD_MESSAGE(id))
  })

  it('does not read a longer run of hex digits as the id', () => {
    const id = storeViaCli('table of results the handoff points at')
    expect(runCli(['handoff-create', 'refs', `see ${id}0 for the table`]).status).toBe(0)
    pruneAfterAging(id)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.stderr).toContain(OLD_MESSAGE(id))
  })

  // HAND-DERIVED: the handoff texts hold the id only as part of a longer word, so none of them names it; the id itself was never stored.
  it.each([
    ['a letter before it', 'see xtg_0123456789abcdef here'],
    ['an underscore-joined word before it', 'see my_tg_0123456789abcdef here'],
    ['a hex digit after it', 'see tg_0123456789abcdef0 here'],
    ['an underscore-joined word after it', 'see tg_0123456789abcdef_x here'],
  ])('does not name a handoff whose text holds the id with %s', (_label, text) => {
    const id = 'tg_0123456789abcdef'
    expect(runCli(['handoff-create', 'refs', text]).status).toBe(0)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.stderr).toContain(OLD_MESSAGE(id))
  })

  it('names a handoff whose text sets the id off by punctuation or whitespace', () => {
    const id = storeViaCli('table of results the handoff points at')
    expect(runCli(['handoff-create', 'paren', `(${id}).`]).status).toBe(0)
    pruneAfterAging(id)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.stderr).toContain('handoff "paren" named it in the text')
  })

  it('keeps the existing expired wording for a blob still on disk past the limit that no handoff names', () => {
    const id = storeViaCli('table of results the handoff points at')
    setAge(id, 2 * DAY_MS)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.status).not.toBe(0)
    expect(retrieved.stderr).toContain(`content ${id} expired: it is older than the local cache's age limit.`)
    expect(retrieved.stderr).not.toContain('named it')
  })

  it('names the handoff for a blob still on disk past the limit, as it does once the blob is pruned', () => {
    const id = storeViaCli('table of results the handoff points at')
    expect(runCli(['handoff-create', 'refs', `see ${id} for the table`]).status).toBe(0)
    setAge(id, 2 * DAY_MS)
    expect(fs.existsSync(blobFile(id))).toBe(true)

    const retrieved = runCli(['retrieve', id])

    expect(retrieved.status).not.toBe(0)
    expect(retrieved.stderr).toContain(`content ${id} expired under the 24 h content limit`)
    expect(retrieved.stderr).toContain('handoff "refs" named it in the text')
    expect(retrieved.stderr).not.toContain('may have expired')
  })
})

describe('the retrieve_text tool says the same', () => {
  async function retrieveViaMcp(id: string): Promise<{ isError: boolean; text: string }> {
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({ name: 'retrieve_text', arguments: { id } })
      return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' }
    } finally {
      await client.close()
      await server.close()
    }
  }

  // The tool takes no project root, so it answers for the process's own project; the handoff is created for that same root.
  it('names the handoff for an id its blob lost, and gives the plain message for an id nobody named', async () => {
    const stored = compressText('table of results the handoff points at')
    createHandoff('refs', `see ${stored.id} for the table`, process.cwd())
    setAge(stored.id, 2 * DAY_MS)
    compressText('a later write that runs the prune')
    expect(fs.existsSync(blobFile(stored.id))).toBe(false)

    const named = await retrieveViaMcp(stored.id)
    expect(named.isError).toBe(true)
    expect(named.text).toContain(`content ${stored.id} expired under the 24 h content limit`)
    expect(named.text).toContain('handoff "refs" named it in the text')
    const unnamed = await retrieveViaMcp('tg_0000000000000000')
    expect(unnamed.text).toBe('no token-goat content for id: tg_0000000000000000')
  })

  it('names the handoff for a blob still on disk past the limit, and keeps the expired wording when none names it', async () => {
    const named = compressText('table of results the handoff points at')
    createHandoff('refs', `see ${named.id} for the table`, process.cwd())
    const unnamed = compressText('a second table nobody mentions')
    setAge(named.id, 2 * DAY_MS)
    setAge(unnamed.id, 2 * DAY_MS)
    expect(fs.existsSync(blobFile(named.id))).toBe(true)

    const withHandoff = await retrieveViaMcp(named.id)
    expect(withHandoff.isError).toBe(true)
    expect(withHandoff.text).toContain(`content ${named.id} expired under the 24 h content limit`)
    expect(withHandoff.text).toContain('handoff "refs" named it in the text')
    const without = await retrieveViaMcp(unnamed.id)
    expect(without.text).toBe(`token-goat content ${unnamed.id} expired: it is older than the local cache's age limit.`)
  })

  // HAND-DERIVED: handoff_create with no projectRoot keys the handoff under the git top level of the server's cwd (resolveToolRoot), the root handoff_resolve looks under; a package.json in a subdirectory is a project marker of its own, so the cwd-only key is the subdirectory. The retrieve_text tool takes no root, so it must read the one its sibling tools write.
  it('names the handoff handoff_create keyed under the git top level, from a subdirectory with its own package.json', async () => {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-named-repo-')))
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'package.json'), '{}\n')
    const cwdBefore = process.cwd()
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0)
      process.chdir(sub)
      const stored = compressText('table of results the handoff points at')
      const server = await createMcpServer()
      const client = new Client({ name: 'test-client', version: '0.0.1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      try {
        const created = await client.callTool({ name: 'handoff_create', arguments: { name: 'refs', text: `see ${stored.id} for the table` } })
        expect(created.isError).not.toBe(true)
      } finally {
        await client.close()
        await server.close()
      }
      setAge(stored.id, 2 * DAY_MS)
      compressText('a later write that runs the prune')
      expect(fs.existsSync(blobFile(stored.id))).toBe(false)

      const named = await retrieveViaMcp(stored.id)

      expect(named.text).toContain('handoff "refs" named it in the text')
    } finally {
      process.chdir(cwdBefore)
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  // HAND-DERIVED: mcp.allowed_roots (TOKEN_GOAT_MCP_ALLOWED_ROOTS, a path-delimited list) pins which roots the tools may serve; handoff_create and handoff_resolve refuse a root outside it, so a handoff of a root outside it is not something retrieve_text may name either. The miss itself still answers with the plain message, not a refusal.
  it('does not name a handoff of a root outside mcp.allowed_roots, and still answers the miss plainly', async () => {
    const allowed = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), '.tg-handoff-named-allowed-')))
    const stored = compressText('table of results the handoff points at')
    createHandoff('refs', `see ${stored.id} for the table`, process.cwd())
    setAge(stored.id, 2 * DAY_MS)
    compressText('a later write that runs the prune')
    const before = process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
    try {
      process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = allowed
      invalidateConfigCache()

      const refused = await retrieveViaMcp(stored.id)

      expect(refused.isError).toBe(true)
      expect(refused.text).toBe(`no token-goat content for id: ${stored.id}`)
    } finally {
      if (before === undefined) delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
      else process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = before
      invalidateConfigCache()
      fs.rmSync(allowed, { recursive: true, force: true })
    }
  })
})
