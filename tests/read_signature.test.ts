import { describe, it, expect } from 'vitest'
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
    expect(res.text).toContain('export function extractSignature(body: string, kind?: string): string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })

  it('works end-to-end via runSymbol with sig: true', async () => {
    const { runSymbol } = await import('../src/read_symbol.js')
    const res = runSymbol({ name: 'extractSignature', sig: true, limit: 1 })
    expect(res.code).toBe(0)
    expect(res.text).toContain('export function extractSignature(body: string, kind?: string): string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })
})

