/**
 * Regression: `token-goat brief` took its "Callers (N)" total from queryRefCounts, which counts
 * references by symbol NAME across the whole project, while the caller rows it actually printed
 * came from resolveCallers, which additionally scopes to THIS definition site (filterRefsForSymbol
 * drops refs living in a file that defines its own same-named symbol). For a name defined in two
 * files, the header therefore counted the OTHER definition's callers and the "...(N more elided)"
 * tail promised rows that could never be listed. Driven through the real, unmocked `run()` CLI
 * entrypoint against a real index -- the mocked unit tests in read_commands.test.ts stub both
 * resolveCallers and queryRefCounts, so they can never observe the two disagreeing.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'

const A_SRC = 'export function widget(): number {\n  return 1\n}\n'
const B_SRC = [
  'export function widget(): number {',
  '  return 2',
  '}',
  'export function useB1(): number {',
  '  return widget()',
  '}',
  'export function useB2(): number {',
  '  return widget()',
  '}',
  'export function useB3(): number {',
  '  return widget()',
  '}',
  '',
].join('\n')
const C_SRC = "import { widget } from './a.js'\nexport function useC(): number {\n  return widget()\n}\n"

async function briefWidget(json: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'tg-brief-scope-'))
  const cwd = process.cwd()
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), A_SRC)
    writeFileSync(join(root, 'src', 'b.ts'), B_SRC)
    writeFileSync(join(root, 'src', 'c.ts'), C_SRC)
    process.chdir(root)
    await run(['node', 'token-goat', 'index', '--walk'])
    chunks.length = 0
    const args = ['node', 'token-goat', 'brief', `${join(root, 'src', 'a.ts')}::widget`]
    if (json) args.push('--json')
    await run(args)
    return chunks.join('\n')
  } finally {
    spy.mockRestore()
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('brief caller count is scoped to the resolved definition', () => {
  it('counts only the callers of THIS widget, not the same-named widget in another file', async () => {
    // src/a.ts::widget has exactly one caller (useC in src/c.ts). src/b.ts::widget has three
    // (useB1/useB2/useB3), and those three must not be counted here. Expectation derived from the
    // fixture by hand, not from any code path under test.
    const out = await briefWidget(false)
    expect(out).toContain('Callers (1):')
    expect(out).toContain('useC')
    expect(out).not.toContain('Callers (4):')
    // Nothing is elided when every counted caller is also listed.
    expect(out).not.toMatch(/more elided/)
  })

  it('reports the same scoped total and truncated=false in --json mode', async () => {
    const out = await briefWidget(true)
    const parsed = JSON.parse(out) as { totalCallers: number; truncated: boolean; callers: { caller: string }[] }
    expect(parsed.totalCallers).toBe(1)
    expect(parsed.truncated).toBe(false)
    expect(parsed.callers.map((c) => c.caller)).toEqual(['useC'])
  })
})
