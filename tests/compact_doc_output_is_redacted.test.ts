/** `compact-doc` output hides a secret the document holds. Fixture provenance: HAND-DERIVED. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compactdocredact-'))
const emitted: string[] = []

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => path.join(DATA_DIR, 'config.toml') }
})
vi.mock('../src/emit.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emit: (text: string) => void emitted.push(text) }
})
vi.mock('../src/stats.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, recordStat: () => undefined }
})

const { cmdCompactDoc } = await import('../src/config_commands.js')
const { invalidateConfigCache } = await import('../src/config.js')

const SECRET = 'hunter2hunter2xyz'
const DOC =
  `# Doc\n\nIntro sentence one. Intro sentence two.\n\n## Keys\n\n` +
  `The database password = ${SECRET} is set here.\n\n## Other\n\nplain text\n`

let file: string

beforeEach(() => {
  invalidateConfigCache()
  emitted.length = 0
  file = path.join(DATA_DIR, `doc-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(file, DOC)
})

afterEach(() => {
  fs.rmSync(file, { force: true })
  invalidateConfigCache()
})

describe('compact-doc output', () => {
  it('--heading prints the section with the secret hidden', () => {
    cmdCompactDoc({ filePath: file, heading: 'Keys' })
    expect(emitted.join('\n')).toContain('database')
    expect(emitted.join('\n')).not.toContain(SECRET)
  })

  it('--heading --json prints the section with the secret hidden', () => {
    cmdCompactDoc({ filePath: file, heading: 'Keys', json: true })
    const text = emitted.join('\n')
    expect(JSON.parse(text).compact).toContain('database')
    expect(text).not.toContain(SECRET)
  })

  it('--show prints the extract with the secret hidden', () => {
    cmdCompactDoc({ filePath: file, show: true, force: true })
    expect(emitted.join('\n')).toContain('Keys')
    expect(emitted.join('\n')).not.toContain(SECRET)
  })

  it('--json prints the extract with the secret hidden', () => {
    cmdCompactDoc({ filePath: file, json: true, force: true })
    const text = emitted.join('\n')
    expect(JSON.parse(text).compact).toContain('Keys')
    expect(text).not.toContain(SECRET)
  })
})
