// The handoff_resolve tool answers what handoff-resolve prints: the handoff itself, a note naming an older copy kept under a previous root spelling, and a message that tells an expired handoff from one never created.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { createHandoff } from '../src/content_store.js'
import { shortFingerprint } from '../src/fingerprint.js'
import { createMcpServer } from '../src/mcp_server.js'
import { canonicalize } from '../src/path_containment.js'
import { clearModuleCaches } from '../src/reset.js'
import { runTeardown } from './helpers/strict_teardown.js'

const isWin = process.platform === 'win32'

let home: string
let projectDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_MCP_TOOLS']) saved[key] = process.env[key]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-mcp-handoff-'))
  const dataRoot = dataDirForHome(home)
  const envRoot = isWin ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  process.env['TOKEN_GOAT_MCP_TOOLS'] = 'handoff_resolve,retrieve_text'
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-mcp-handoff-project-'))
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

async function resolveTool(name: string, root: string): Promise<{ isError: boolean; texts: string[] }> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: 'handoff_resolve', arguments: { name, full: true, projectRoot: root } })
    return { isError: result.isError === true, texts: (result.content as Array<{ text: string }>).map((block) => block.text) }
  } finally {
    await client.close()
    await server.close()
  }
}

// FORMAT-DERIVED: the stored record has the shape of origin/main 3913ac9c2 src/content_store.ts createHandoff (kind, id, name, projectRoot, contentId, text, createdAt; id hashed from the root as spelled). A handoff made from the link and a newer one stored the way the previous release stored it, under the id of the link target's spelling; a junction stands in for the symlink on Windows.
function plantTwoCopies(): { link: string; currentId: string } {
  const real = path.join(projectDir, 'root-a')
  const link = path.join(projectDir, 'link-root')
  fs.mkdirSync(real)
  fs.symlinkSync(real, link, isWin ? 'junction' : 'dir')
  const current = createHandoff('plan', 'written from the link', link)
  const spelling = canonicalize(fs.realpathSync.native(real))
  const id = `tg_handoff_${shortFingerprint(`${spelling}\x00plan`)}`
  fs.writeFileSync(
    path.join(home, 'content', `${id}.json`),
    JSON.stringify({ kind: 'handoff', id, name: 'plan', projectRoot: spelling, contentId: `tg_${shortFingerprint('written from the target')}`, text: 'written from the target', createdAt: Date.now() + 60_000 }),
  )
  return { link, currentId: current.id }
}

describe('the handoff_resolve tool', () => {
  // HAND-DERIVED: the stored copy is newer by construction (createdAt a minute ahead), so it wins and the copy made from the link is the older one.
  it('returns the handoff first and names the older copy in a second text block', async () => {
    const { link } = plantTwoCopies()

    const answer = await resolveTool('plan', link)

    expect(answer.isError).toBe(false)
    expect(answer.texts[0]).toBe('written from the target')
    expect(answer.texts).toHaveLength(2)
    expect(answer.texts[1]).toMatch(/^note: 1 older copy of handoff "plan" \(stored \d{4}-\d\d-\d\dT[\d:.]+Z\) is kept under a previous project-root spelling; read it with: the retrieve_text tool with id tg_[0-9a-f]{16}$/)
  })

  // HAND-DERIVED: the same planted pair as the row above, with only handoff_resolve listed, so the note cannot name retrieve_text.
  it('names the content id instead of a tool the server does not list', async () => {
    const { link } = plantTwoCopies()
    process.env['TOKEN_GOAT_MCP_TOOLS'] = 'handoff_resolve'

    const answer = await resolveTool('plan', link)

    expect(answer.texts[1]).toMatch(/read it with: content id tg_[0-9a-f]{16}$/)
  })

  // HAND-DERIVED: one handoff has no other copy to report.
  it('returns the handoff alone when there is no older copy', async () => {
    createHandoff('plan', 'only copy', projectDir)

    const answer = await resolveTool('plan', projectDir)

    expect(answer.texts).toEqual(['only copy'])
  })

  // HAND-DERIVED: the file is aged 48 h with utimes, past the 24 h age limit; the never-created name was never stored.
  it('says a record past the age limit expired, and keeps the plain message for a name never created', async () => {
    const created = createHandoff('plan', 'old plan', projectDir)
    const aged = new Date(Date.now() - 48 * 3600 * 1000)
    fs.utimesSync(path.join(home, 'content', `${created.id}.json`), aged, aged)

    const expired = await resolveTool('plan', projectDir)
    expect(expired.isError).toBe(true)
    expect(expired.texts[0]).toContain('handoff "plan" expired: it was stored')
    const never = await resolveTool('never-made', projectDir)
    expect(never.isError).toBe(true)
    expect(never.texts[0]).toContain('no local handoff named "never-made" in this project')
  })
})

describe('the handoff_resolve tool with an unreadable record', () => {
  // HAND-DERIVED: the planted pair is the one above; the record made from the link is then overwritten with text that is not JSON, so only the copy under the target's spelling reads.
  it('returns the readable text first and says a stored record could not be read in a second block', async () => {
    const { link, currentId } = plantTwoCopies()
    fs.writeFileSync(path.join(home, 'content', `${currentId}.json`), '{not json', 'utf8')

    const answer = await resolveTool('plan', link)

    expect(answer.isError).toBe(false)
    expect(answer.texts).toEqual(['written from the target', 'note: a stored record of handoff "plan" could not be read (SyntaxError); the text shown may not be the latest'])
  })

  // HAND-DERIVED: with every copy unreadable nothing can be served, and the message must say unreadable, never "no local handoff".
  it('does not say there is no handoff when the only record is unreadable', async () => {
    const { link, currentId } = plantTwoCopies()
    fs.writeFileSync(path.join(home, 'content', `${currentId}.json`), '', 'utf8')
    const targetId = fs.readdirSync(path.join(home, 'content')).find((file) => file.startsWith('tg_handoff_') && file !== `${currentId}.json`) as string
    fs.writeFileSync(path.join(home, 'content', targetId), '', 'utf8')

    const answer = await resolveTool('plan', link)

    expect(answer.isError).toBe(true)
    expect(answer.texts[0]).toContain('handoff "plan" could not be read (SyntaxError)')
    expect(answer.texts[0]).not.toContain('no local handoff')
  })
})
