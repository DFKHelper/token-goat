import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { INLINE_SYMBOL_MAX_BYTES, inlineSymbolAnswer } from '../src/inline_symbol_answer.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import type * as SecretRedact from '../src/secret_redact.js'
import { redactSecrets } from '../src/secret_redact.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { indexableDir } from './helpers/temp-config.js'

vi.mock('../src/secret_redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SecretRedact>()
  return { ...actual, redactSecrets: vi.fn(actual.redactSecrets) }
})

// HAND-DERIVED: a synthetic Python module and a caller file with N lines of `value_i = unique_loader("path-number-i.txt")`, about 45 bytes each, so 1,200 lines are over four caps (48,000 bytes) of raw listing and 400 lines are between one cap and four.
const MODULE = ['def unique_loader(path):', '    """Load one thing."""', '    return open(path).read()', ''].join('\n')
const BARE = String.raw`\bunique_loader\b`

function callers(count: number): string {
  return Array.from({ length: count }, (_, i) => `value_${i} = unique_loader("path-number-${i}.txt")`).join('\n') + '\n'
}

function project(files: Record<string, string>): string {
  const dir = indexableDir()
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'init', '-q'], { cwd: dir, stdio: 'ignore' })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, 'utf8')
  for (const name of Object.keys(files)) indexFileSync(path.join(dir, name), globalDbPath())
  return dir
}

async function answer(dir: string) {
  const event = makeHookEvent({ toolName: 'Grep', toolInput: { pattern: BARE, output_mode: 'content', path: dir }, sessionId: `listing-cap-${process.pid}`, raw: { cwd: dir } })
  return await inlineSymbolAnswer({ enabled: true, pattern: BARE, grepPath: dir, cwd: dir, event, isBarred: () => false })
}

beforeEach(() => {
  clearModuleCaches()
  vi.stubEnv('TOKEN_GOAT_INLINE_SYMBOL_BODY', '1')
  invalidateConfigCache()
  vi.mocked(redactSecrets).mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
})

describe('the match listing bound', () => {
  it('redacts a listing between one cap and four caps before it finds it over the cap', async () => {
    const dir = project({ 'mod.py': MODULE, 'use.py': callers(400) })
    expect(callers(400).length).toBeGreaterThan(INLINE_SYMBOL_MAX_BYTES)
    expect(callers(400).length).toBeLessThan(4 * INLINE_SYMBOL_MAX_BYTES)
    expect(await answer(dir)).toEqual({ name: 'over_cap' })
    expect(vi.mocked(redactSecrets).mock.calls.length, 'a listing under four caps is still redacted and then measured').toBeGreaterThan(0)
  })

  it('passes a listing past four caps through as over_cap without redacting any of it', async () => {
    const dir = project({ 'mod.py': MODULE, 'use.py': callers(1200) })
    expect(callers(1200).length).toBeGreaterThan(4 * INLINE_SYMBOL_MAX_BYTES)
    expect(await answer(dir)).toEqual({ name: 'over_cap' })
    expect(vi.mocked(redactSecrets).mock.calls.length, 'redactSecrets calls for a listing past four caps').toBe(0)
  })
})
