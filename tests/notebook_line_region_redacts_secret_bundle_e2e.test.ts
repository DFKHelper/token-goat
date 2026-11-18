/** Built-bundle check that `read nb.ipynb:N` prints a notebook's cell text redacted, as text and as --json, and says so plainly when a notebook has no cell text to number. Fixture provenance: HAND-DERIVED from nbformat 4 (https://nbformat.readthedocs.io/en/latest/format_description.html: `cells`, `cell_type`, `source` as a list of lines, `outputs` with `output_type: stream`). The key is the example access key id AWS publishes in its IAM documentation, `AKIAIOSFODNN7EXAMPLE`; the private key body lines are made-up filler, never key material. The line numbers count the Python document the index builds from the cells (src/languages/ipynb_idx.ts): a `# %% cell N` marker line opens each code cell, `# %% [markdown] cell N` each markdown cell, and markdown text is commented with `# `. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const AWS_PLACEHOLDER = '[REDACTED:aws_access_key]'
const PEM_PLACEHOLDER = '[REDACTED:private_key_block]'
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'

const notebook = (cells: unknown[], metadata: unknown = {}): string => JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 }, null, 1)

// Document lines: 1 `# %% [markdown] cell 0`, 2 `# # Notes`, 3 blank, 4 `# %% cell 1`, 5 `def deploy():`, 6 the key line, 7 `return key`.
const KEY_NOTEBOOK = notebook([
  { cell_type: 'markdown', metadata: {}, source: ['# Notes'] },
  {
    cell_type: 'code',
    execution_count: 1,
    metadata: {},
    outputs: [{ output_type: 'stream', name: 'stdout', text: [`deployed with ${AWS_KEY}\n`] }],
    source: ['def deploy():\n', `    key = "${AWS_KEY}"\n`, '    return key'],
  },
])
const KEY_LINE = 6

// Document lines: 1 `# %% [markdown] cell 0`, 2 the BEGIN line, 3 and 4 body, 5 the END line, 6 blank, 7 `# %% cell 1`, 8 `def after():`, 9 `return 1`.
const BODY = ['KEYBODYLINE01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'KEYBODYLINE02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
const PEM_NOTEBOOK = notebook([
  { cell_type: 'markdown', metadata: {}, source: [PEM_BEGIN, ...BODY, PEM_END].map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l)) },
  { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['def after():\n', '    return 1'] },
])

// A key pasted as comments around a function: the `helper` symbol cuts the block in two, so line 2 resolves to the region 1-3 that holds the BEGIN line and a body line but not the END line. Document lines: 1 `# %% cell 0`, 2 the BEGIN line, 3 body, 4 `def helper():`, 5 `return 1`, 6 body, 7 the END line.
const SPLIT_NOTEBOOK = notebook([
  { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [`# ${PEM_BEGIN}\n`, `# ${BODY[0]}\n`, 'def helper():\n', '    return 1\n', `# ${BODY[1]}\n`, `# ${PEM_END}`] },
])

// A Julia kernel is not flattened into the Python document, so it has no cell text to number.
const JULIA_NOTEBOOK = notebook([{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['println("hi")'] }], { kernelspec: { language: 'julia' } })

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return bundleTg(project, env, args)
}

interface JsonRegion {
  start: number
  end: number
  lines: string[]
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-nb-redact-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
  fs.writeFileSync(path.join(project, 'key.ipynb'), KEY_NOTEBOOK)
  fs.writeFileSync(path.join(project, 'pem.ipynb'), PEM_NOTEBOOK)
  fs.writeFileSync(path.join(project, 'split.ipynb'), SPLIT_NOTEBOOK)
  fs.writeFileSync(path.join(project, 'julia.ipynb'), JULIA_NOTEBOOK)
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('read nb.ipynb:N prints cell text redacted', () => {
  it('positive control: the key is in the notebook on disk, in the cell and in the stream output', () => {
    const raw = fs.readFileSync(path.join(project, 'key.ipynb'), 'utf8')
    expect(raw.split(AWS_KEY)).toHaveLength(3)
  })

  it('shows the key line with a placeholder and the key nowhere, in text form', () => {
    const res = tg(['read', `key.ipynb:${KEY_LINE}`])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain(`key = "${AWS_PLACEHOLDER}"`)
    expect(res.stdout).not.toContain(AWS_KEY)
  })

  it('shows the key line with a placeholder and the key nowhere, in --json form', () => {
    const res = tg(['read', `key.ipynb:${KEY_LINE}`, '--json'])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).not.toContain(AWS_KEY)
    const parsed = JSON.parse(res.stdout) as { regions: JsonRegion[] }
    const region = parsed.regions.find((r) => r.start <= KEY_LINE && r.end >= KEY_LINE)
    expect(region, 'no region covers the key line').toBeDefined()
    expect(region!.lines[KEY_LINE - region!.start]).toBe(`    key = "${AWS_PLACEHOLDER}"`)
  })

  it('turns a multi-line private key block in a markdown cell into one placeholder per line, keeping the line count', () => {
    const res = tg(['read', 'pem.ipynb:2-5', '--json'])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).not.toContain('KEYBODYLINE')
    expect(res.stdout).not.toContain('PRIVATE KEY-----')
    const parsed = JSON.parse(res.stdout) as { regions: JsonRegion[] }
    const byLine = new Map<number, string>()
    for (const r of parsed.regions) {
      expect(r.lines, `region ${r.start}-${r.end} changed its line count`).toHaveLength(r.end - r.start + 1)
      r.lines.forEach((l, i) => byLine.set(r.start + i, l))
    }
    for (let l = 2; l <= 5; l++) expect(byLine.get(l), `line ${l}`).toContain(PEM_PLACEHOLDER)
    const text = tg(['read', 'pem.ipynb:2-5'])
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).not.toContain('KEYBODYLINE')
    expect(text.stdout.split(PEM_PLACEHOLDER).length - 1).toBeGreaterThanOrEqual(4)
  })

  it('redacts a private key block that a symbol boundary splits across regions, in text and --json form', () => {
    const text = tg(['read', 'split.ipynb:2'])
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toContain(PEM_PLACEHOLDER)
    expect(text.stdout).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(text.stdout).not.toContain('KEYBODYLINE')
    const json = tg(['read', 'split.ipynb:2', '--json'])
    expect(json.status, json.stderr).toBe(0)
    expect(json.stdout).toContain(PEM_PLACEHOLDER)
    expect(json.stdout).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(json.stdout).not.toContain('KEYBODYLINE')
  })
})

describe('read nb.ipynb:N on a notebook with no cell text', () => {
  it('says the notebook has no indexed cell text instead of a line count of 1', () => {
    const res = tg(['read', 'julia.ipynb:3'])
    expect(res.status).toBe(1)
    expect(res.stderr + res.stdout).toContain('no indexed cell text')
    expect(res.stderr + res.stdout).not.toContain('past end of file')
  })
})
