/** A throwing redactor leaves the withheld placeholder in served text. Fixture provenance: HAND-DERIVED. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type * as SecretRedact from '../src/secret_redact.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hookwithhold-'))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => path.join(DATA_DIR, 'config.toml') }
})
vi.mock('../src/secret_redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SecretRedact>()
  const fail = (): never => {
    throw new Error('injected redactor failure')
  }
  return { ...actual, redactSecrets: fail, redactCutSecrets: fail, redactSerializedJson: fail }
})

const { preReadHandler } = await import('../src/hooks_read.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { compactPathFor, writeCompact, buildExtractiveCompact } = await import('../src/doc_compact.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')
const { fenceNumberedFileContent, fenceUntrustedFileContent, fenceUntrustedOcrText } =
  await import('../src/injection_scan.js')
const { fenceFieldIfMatched, fenceFileText } = await import('../src/untrusted_fence.js')
const { WITHHELD_PLACEHOLDER } = await import('../src/fence_cap.js')

const RAW = 'RAWMARKER_visible_if_unredacted_0123456789'
const files: string[] = []

function makeFile(name: string, content: string): string {
  const p = path.join(DATA_DIR, `${process.pid}-${Math.random().toString(36).slice(2)}-${name}`)
  fs.writeFileSync(p, content)
  files.push(p)
  return p
}

function served(file: string): string {
  const event = makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: 'hook-withhold' })
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
})

describe('the fences withhold text whose redaction threw', () => {
  it.each([
    ['fenceUntrustedFileContent', () => fenceUntrustedFileContent(RAW)],
    ['fenceNumberedFileContent', () => fenceNumberedFileContent(RAW, 'layout').body],
    ['fenceUntrustedOcrText', () => fenceUntrustedOcrText(RAW)],
    ['fenceFileText', () => fenceFileText(RAW)],
    ['fenceFieldIfMatched', () => fenceFieldIfMatched(RAW, 'untrusted-file-content')],
  ])('%s', (_name, fence) => {
    const out = fence()
    expect(out).not.toContain(RAW)
    expect(out).toContain(WITHHELD_PLACEHOLDER)
  })
})

describe('a hook answer built from file text under a throwing redactor', () => {
  it('the compact sidecar served for a document', () => {
    const src = makeFile('doc.md', `# Doc\n\n${RAW} is the first sentence.\n\n## Part\n\nmore\n`)
    writeCompact(compactPathFor(src), src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    const out = served(src)
    expect(out).toContain('Serving the extractive compact sidecar')
    expect(out).not.toContain(RAW)
    expect(out).toContain(WITHHELD_PLACEHOLDER)
  })

  it('the output-stripped notebook', () => {
    const output = { output_type: 'stream', name: 'stdout', text: ['x'.repeat(6000)] }
    const source = [`print("${RAW}")`]
    const cell = { cell_type: 'code', metadata: {}, source, outputs: [output], execution_count: 1 }
    const notebook = { cells: [cell], metadata: {}, nbformat: 4, nbformat_minor: 5 }
    const src = makeFile('nb.ipynb', JSON.stringify(notebook))
    const out = served(src)
    expect(out).toContain('output-stripped notebook')
    expect(out).not.toContain(RAW)
    expect(out).toContain(WITHHELD_PLACEHOLDER)
  })

  it('the heading tree of a large markdown file', () => {
    const filler = 'Some prose line that pads the document out.\n'.repeat(120)
    const body = `# Intro ${RAW}\n${filler}\n## Usage\n${filler}\n## Notes\n${filler}\n## More\n${filler}\n`
    const src = makeFile('big.md', body)
    const out = served(src)
    expect(out).not.toContain(RAW)
  })
})
