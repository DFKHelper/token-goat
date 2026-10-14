/** Built-bundle check for the `symbol` miss path: the shipped dist/token-goat.mjs, not source, indexes a small project through `index . --walk` and answers a typo, a scope-hidden exact name, a JSON key and a `--json` miss. The miss path reads names and structured files with statements of its own (src/symbol_scan.ts) rather than through querySymbols, so this is the check that those statements survive bundling and run against a database the real indexer wrote. Fixture provenance: HAND-DERIVED. The source files are written below and every expected line is computed from them: `renderInvoice` is one edit from `renderInvoise`, and `portNumber` sits at `server.portNumber` in settings.json. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return bundleTg(project, env, args)
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-symbol-miss-bundle-'))
  fs.writeFileSync(path.join(project, 'invoice.ts'), 'export function renderInvoice(total: number): string {\n  return `total: ${total}`\n}\n')
  fs.writeFileSync(path.join(project, 'settings.json'), '{\n  "server": {\n    "portNumber": 8080\n  }\n}\n')
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle answers a symbol miss', () => {
  it('suggests the near name for a typo', () => {
    const r = tg(['symbol', 'renderInvoise', '-p'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`No matches for "renderInvoise"\nDid you mean:\n  - renderInvoice`)
  })

  it('names the scope that hid an exact name', () => {
    const r = tg(['symbol', 'renderInvoice', '-p', '--kind', 'class'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`"renderInvoice" IS indexed (function at invoice.ts:1) -- drop --kind to see it`)
  })

  it('points at the JSON key a miss names', () => {
    const r = tg(['symbol', 'portNumber', '-p'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`"portNumber" is a key in settings.json at server.portNumber`)
  })

  it('emits a parseable JSON envelope on stdout for a --json miss, shaped like a hit', () => {
    const miss = tg(['symbol', 'renderInvoise', '-p', '--json'])
    expect(miss.status).toBe(0)
    expect(JSON.parse(miss.stdout)).toEqual({ items: [], truncated: false, totalCount: 0 })
    const hit = tg(['symbol', 'renderInvoice', '-p', '--json'])
    expect(hit.status).toBe(0)
    const hitPayload = JSON.parse(hit.stdout) as Record<string, unknown>
    expect(hitPayload.totalCount).toBe(1)
    expect(Object.keys(JSON.parse(miss.stdout) as object).sort()).toEqual(Object.keys(hitPayload).sort())
  })
})
