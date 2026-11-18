/** A throwing redactor leaves the withheld placeholder in the near-miss and inline answer. HAND-DERIVED. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type * as SecretRedact from '../src/secret_redact.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nearmiss-withhold-'))

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

const { describeNearMiss, findNearMiss } = await import('../src/edit_near_miss.js')
const { inlineAnswerDeny } = await import('../src/inline_symbol_answer.js')
const { WITHHELD_PLACEHOLDER } = await import('../src/redact_or_withhold.js')

const RAW = 'RAWMARKER_visible_if_unredacted_0123456789'

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

describe('a throwing redactor never lets raw text through', () => {
  it('the edit near-miss span is withheld', () => {
    const fileText = `${RAW}   \nnext\n`
    const miss = findNearMiss(fileText, `${RAW}\nnext`)
    expect(miss).not.toBeNull()
    const advice = describeNearMiss(fileText, 'src/a.txt', miss as NonNullable<typeof miss>)
    expect(advice).toContain(WITHHELD_PLACEHOLDER)
    expect(advice).not.toContain(RAW)
  })

  it('the inline answer body and listing are withheld', () => {
    const out = inlineAnswerDeny({ inline: RAW, file: 'src/a.py', symbol: 'load', matches: [RAW] })
    const message = out.hookType === 'deny' ? out.message : ''
    expect(message).toContain(WITHHELD_PLACEHOLDER)
    expect(message).not.toContain(RAW)
  })
})
