import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { bundleTg, makeBundleProject, type BundleProject } from './helpers/bundle.js'
import { extractSignature } from '../src/read_signature.js'

describe('extractSignature', () => {
  it('extracts TypeScript/JavaScript function signature', () => {
    const fn = `export function calculateTotal(items: Item[], tax: number): number {
      const sum = items.reduce((acc, x) => acc + x.price, 0)
      return sum * (1 + tax)
    }`
    expect(extractSignature(fn)).toBe('export function calculateTotal(items: Item[], tax: number): number')
  })

  it('handles multiline parameters and return types', () => {
    const fn = `export async function fetchData(
  url: string,
  options?: { timeout?: number; retries?: number }
): Promise<Response> {
  return fetch(url)
}`
    expect(extractSignature(fn)).toBe(`export async function fetchData(
  url: string,
  options?: { timeout?: number; retries?: number }
): Promise<Response>`)
  })

  it('extracts Python function signature', () => {
    const py = `def process_data(records: list[dict], threshold: float = 0.5) -> int:
    """Process incoming records."""
    count = 0
    for r in records:
        count += 1
    return count`
    expect(extractSignature(py)).toBe('def process_data(records: list[dict], threshold: float = 0.5) -> int:')
  })

  it('handles decorators gracefully', () => {
    const fn = `@logged\n@timed(100)\nexport function performAction(): void {\n  console.log("action")\n}`
    expect(extractSignature(fn)).toBe('export function performAction(): void')
  })

  it('works end-to-end via runRead with sig: true', async () => {
    const { runRead } = await import('../src/read_commands.js')
    const res = runRead({ spec: 'src/read_signature.ts::extractSignature', sig: true })
    expect(res.code).toBe(0)
    expect(res.text).toContain('export function extractSignature(body: string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })

  it('works end-to-end via runSymbol with sig: true', async () => {
    const { runSymbol } = await import('../src/read_symbol.js')
    const res = runSymbol({ name: 'extractSignature', sig: true, limit: 1 })
    expect(res.code).toBe(0)
    expect(res.text).toContain('export function extractSignature(body: string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })
})

// Provenance: HAND-DERIVED. The file below is written by this test and the expected lines are read off it; the flag spellings are the ones docs/cli.md and README.md document. The in-process runRead/runSymbol rows above call the handler with `sig: true` directly and so never cross the Commander option parse, which is where `--sig, --signature` lands on the attribute `signature`.
describe('the --sig and --signature flags reach the handler through the built CLI', () => {
  const SRC_FILE = 'sample_sig.ts'
  let tmp: BundleProject | undefined

  beforeEach(() => {
    tmp = makeBundleProject('tg-sig-')
    writeFileSync(path.join(tmp.project, SRC_FILE), 'export function pickWinner(scores: number[]): number {\n  const SIG_BODY_MARKER = scores.length\n  return SIG_BODY_MARKER\n}\n', 'utf-8')
  })

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp.root, { recursive: true, force: true })
    tmp = undefined
  })

  for (const flag of ['--sig', '--signature']) {
    it(`read ${flag} prints the declaration line and omits the body`, () => {
      const res = bundleTg(tmp!.project, tmp!.env, ['read', `${SRC_FILE}::pickWinner`, flag])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('export function pickWinner(scores: number[]): number')
      expect(res.stdout).not.toContain('SIG_BODY_MARKER')
    })

    it(`symbol ${flag} prints the declaration line and omits the body`, () => {
      const res = bundleTg(tmp!.project, tmp!.env, ['symbol', 'pickWinner', flag, '--file', SRC_FILE])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('export function pickWinner(scores: number[]): number')
      expect(res.stdout).not.toContain('SIG_BODY_MARKER')
    })
  }
})

