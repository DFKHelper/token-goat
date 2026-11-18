// The retrieve_text tool tells a content record that is on disk but unreadable from one that is missing, as the retrieve command does.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { compressText } from '../src/content_store.js'
import { createMcpServer } from '../src/mcp_server.js'
import { clearModuleCaches } from '../src/reset.js'
import { runTeardown } from './helpers/strict_teardown.js'

const isWin = process.platform === 'win32'

let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME']) saved[key] = process.env[key]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-mcp-retrieve-'))
  const dataRoot = dataDirForHome(home)
  const envRoot = isWin ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  runTeardown([_resetDataDirCacheForTesting, clearModuleCaches, () => fs.rmSync(home, { recursive: true, force: true })])
})

async function retrieve(id: string): Promise<{ isError: boolean; text: string }> {
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

describe('the retrieve_text tool', () => {
  // FORMAT-DERIVED: the record has the shape of origin/main 3913ac9c2 src/content_store.ts storeContent (kind content, id, text, createdAt), written by compressText and then overwritten with text that is not JSON.
  it('says an unreadable record could not be read, and is not called missing or expired', async () => {
    const id = compressText('some text worth keeping').id
    fs.writeFileSync(path.join(home, 'content', `${id}.json`), '{not json', 'utf8')

    const answer = await retrieve(id)

    expect(answer.isError).toBe(true)
    expect(answer.text).toBe(`content ${id} could not be read (SyntaxError): a record for it is on disk, so it may exist`)
  })

  // HAND-DERIVED: an id in the tool's accepted shape (tg_ plus 16 hex digits) that was never stored.
  it('keeps the missing wording for an id never stored', async () => {
    const answer = await retrieve('tg_0123456789abcdef')

    expect(answer.isError).toBe(true)
    expect(answer.text).toBe('no token-goat content for id: tg_0123456789abcdef')
  })
})
