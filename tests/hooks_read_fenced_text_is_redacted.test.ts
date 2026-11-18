/** Text pre_read serves hides secrets. Fixture provenance: SYNTHETIC, hash-chain base64, not a real key. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fencedredact-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { preReadHandler } = await import('../src/hooks_read.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { compactPathFor, writeCompact, buildExtractiveCompact } = await import('../src/doc_compact.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const END = '-----END RSA PRIVATE KEY-----'
const BODY = Array.from({ length: 27 }, (_, i) =>
  [0, 1]
    .map((part) => createHash('sha256').update(`fenced-${i}-${part}`).digest('base64'))
    .join('')
    .replaceAll('=', 'A')
    .slice(0, 64),
)

const files: string[] = []

function makeFile(name: string, content: string): string {
  const p = path.join(DATA_DIR, `${process.pid}-${Math.random().toString(36).slice(2)}-${name}`)
  fs.writeFileSync(p, content)
  files.push(p)
  return p
}

function served(file: string): string {
  const event = makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: 'fenced-redact' })
  const result = preReadHandler(event)
  if (result.hookType === 'deny') return result.message
  return result.hookType === 'context' ? result.context : ''
}

beforeEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
  for (const p of files.splice(0)) fs.rmSync(p, { force: true })
  for (const p of fs.readdirSync(DATA_DIR)) {
    if (p.endsWith('.compact.md') || p.endsWith('.compact')) fs.rmSync(path.join(DATA_DIR, p), { force: true })
  }
})

describe('the compact sidecar served in place of a document', () => {
  it('hides a 27-line key block the sidecar cut to its first ten lines', () => {
    const lines = ['# Keys', 'Deploy key below.', '', '```', BEGIN, ...BODY, END, '```', '']
    const src = makeFile('keys.md', lines.join('\n'))
    const body = buildExtractiveCompact(fs.readFileSync(src, 'utf-8'))
    expect(body).toContain(BEGIN)
    expect(body).not.toContain(END)
    writeCompact(compactPathFor(src), src, body)

    const out = served(src)

    expect(out).toContain('Serving the extractive compact sidecar')
    for (const line of BODY.slice(0, 9)) expect(out).not.toContain(line)
    expect(out).not.toContain('PRIVATE KEY')
  })

  it('hides a keyword assignment in a section the sidecar kept', () => {
    const src = makeFile('env.md', '# Env\npassword = hunter2hunter2xyz\n\n# More\nplain\n')
    writeCompact(compactPathFor(src), src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    expect(served(src)).not.toContain('hunter2hunter2xyz')
  })
})

describe('the heading tree served for a large markdown file', () => {
  it('hides a secret written into a heading', () => {
    const filler = `${'Some prose line that pads the document out.\n'.repeat(120)}`
    const secretHeading = `## password = hunter2hunter2xyz`
    const parts = [`# Intro\n${filler}`, secretHeading, `${filler}\n## Usage\n${filler}\n## Notes\n${filler}\n`]
    const src = makeFile('big.md', parts.join('\n'))
    const out = served(src)
    expect(out).toContain('Intro')
    expect(out).not.toContain('hunter2hunter2xyz')
  })
})
