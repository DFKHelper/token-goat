/**
 * The Read-hook fold gates ask only the precise secret patterns, never the recall-tuned catch-all.
 *
 * The gates decline to fold on a match, and a decline passes the file through to the model
 * UNREDACTED -- so a false positive there buys no protection and costs every fold the file could
 * have had. `generic_secret_assignment` is tuned the other way on purpose (it guards what gets
 * written to disk, where over-redacting is free), and it matches ordinary source: the prose line
 * below vetoed skeleton, outline and body folds for 9.4% of first-party files of 12 kB or more.
 *
 * Fixture provenance:
 *  - CAPTURE: `PasswordException: those files need a password to open` is a doc-comment line from
 *    this repository's own src/pdf_extract.ts, copied verbatim; it is prose about a exception type
 *    and holds no credential.
 *  - HAND-DERIVED: the surrounding TypeScript is synthetic filler written for this test, sized past
 *    the fold's own byte floor, and the `N\tline` numbered rendering is the Read tool's `cat -n`
 *    delivery shape (the same `numbered` helper tests/hooks_read_source_skeleton.test.ts uses).
 *  - HAND-DERIVED: the credential is assembled at runtime from a prefix and a filler run rather
 *    than written out, so no committed string in this repository is key-shaped. Its prefix is read
 *    off the vendor's documented key format, not off this repo's matcher.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { postReadHandler } from '../src/hooks_read.js'
import { redactSecrets } from '../src/secret_redact.js'
import type { HookEvent } from '../src/hook_registry.js'

/** The false positive: prose, copied from src/pdf_extract.ts, that generic_secret_assignment matches because its keyword needs no left word boundary and its value class runs on past the separator. */
const PROSE_FALSE_POSITIVE = '// PasswordException: those files need a password to open'

/** A real credential, assembled here so the repository never carries the literal. `sk-ant-` is Anthropic's documented key prefix. */
const REAL_CREDENTIAL = `sk-ant-api03-${'a'.repeat(90)}`

const BODY_FILLER =
  '  const padding = "filler that exists only to push this fixture past the fold byte floor, and a skeleton that keeps it is not a skeleton"'

function fn(i: number): string {
  return [
    `export function fixtureSecretGate${i}(input: string, count: number): number {`,
    ...Array.from({ length: 12 }, () => BODY_FILLER),
    '  return input.length + count',
    '}',
  ].join('\n')
}

/** A source file large enough to fold, with `marker` sitting in its preamble. */
function sourceWith(marker: string): string {
  return [marker, '', ...Array.from({ length: 12 }, (_, i) => fn(i))].join('\n') + '\n'
}

function numbered(body: string): string {
  return body
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
    .join('\n')
}

let TMP: string
const prevFlag = process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES']

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tg-fold-secret-'))
  process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES'] = '1'
})

afterAll(() => {
  if (prevFlag === undefined) delete process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES']
  else process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES'] = prevFlag
  rmSync(TMP, { recursive: true, force: true })
})

/** Runs the real post-Read hook over a file whose preamble carries `marker`, returning the rewritten text ('' when the hook declined to rewrite). */
function foldedText(name: string, marker: string): string {
  const body = sourceWith(marker)
  const file = join(TMP, name)
  writeFileSync(file, body)
  const event: HookEvent = {
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: file },
    sessionId: `fold-secret-${Math.random().toString(36).slice(2)}`,
    agentId: undefined,
    raw: { tool_response: numbered(body) },
  }
  const out = postReadHandler(event) as { hookType?: string; updatedOutput?: string } | null
  return out?.hookType === 'rewriteOutput' ? (out.updatedOutput ?? '') : ''
}

describe('the Read-hook fold gate asks only the precise secret patterns', () => {
  it('folds a file whose only match is the recall-tuned catch-all', () => {
    const text = foldedText('prose.ts', PROSE_FALSE_POSITIVE)
    expect(text).not.toBe('')
    // Named line by line rather than as a ratio: a fold that over-collapsed would score better on any size assertion while losing what the skeleton exists to keep.
    expect(text).toContain('export function fixtureSecretGate0(')
    expect(text).toContain('export function fixtureSecretGate11(')
    expect(text).not.toContain(BODY_FILLER)
  })

  it('still declines to fold a file holding a real credential', () => {
    expect(foldedText('credential.ts', `const apiKey = "${REAL_CREDENTIAL}"`)).toBe('')
  })

  it('leaves what redactSecrets writes to disk exactly as it was', () => {
    // Both directions of the persistence contract, which this change must not move: the catch-all still redacts the prose line it false-fires on, and the precise pattern still redacts the credential.
    const prose = redactSecrets(sourceWith(PROSE_FALSE_POSITIVE))
    expect(prose.count).toBeGreaterThan(0)
    expect(prose.text).toContain('[REDACTED:generic_secret_assignment]')

    const credential = redactSecrets(sourceWith(`const apiKey = "${REAL_CREDENTIAL}"`))
    expect(credential.text).toContain('[REDACTED:anthropic_api_key]')
    expect(credential.text).not.toContain(REAL_CREDENTIAL)
  })
})
