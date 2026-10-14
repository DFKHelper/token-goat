/** A credential inside a device control string, split there by a colour code, was missed by both readings redaction takes. The strip removes a control string whole up to its terminator, so the escape-stripped view held nothing, and the text as given held the token in two halves. A strip that removes only the two-byte openers and the colour code, as the strip did before control strings were taken whole, joins the halves into a whole token. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig, type Config } from '../src/config.js'
import { withoutEscapes } from '../src/injection_scan.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import { hasPreciseSecret, redactSecrets } from '../src/secret_redact.js'
import { BUNDLE } from './helpers/bundle.js'

const ESC = '\x1b'
const CONFIG: Config = { ...loadConfig(), redaction: { custom_patterns: [], strict: false } }

// HAND-DERIVED: the audit's input, `ESC P ghp_` and 18 letters, a colour code, 18 more letters, then the string terminator.
const SPLIT_IN_DCS = `${ESC}Pghp_${'A'.repeat(18)}${ESC}[31m${'B'.repeat(18)}${ESC}\\`
const WHOLE = 'ghp_' + 'A'.repeat(18) + 'B'.repeat(18)

/** Every reading of `text` a reader could be shown: as given, through each strip, and with only CSI and single-character escapes removed, which keeps a control string's payload. */
function views(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  return [text, stripAnsiEscapes(text), withoutEscapes(text), text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')]
}

describe('a credential split inside a control string', () => {
  it('is redacted in every view of the result', () => {
    const { text, count } = redactSecrets(SPLIT_IN_DCS, CONFIG)
    expect(count).toBeGreaterThan(0)
    for (const view of views(text)) expect(view, JSON.stringify(view)).not.toContain(WHOLE)
  })

  it('counts as a precise secret', () => {
    expect(hasPreciseSecret(SPLIT_IN_DCS, CONFIG)).toBe(true)
  })

  it('in each of the other control strings too', () => {
    for (const opener of ['X', '^', '_']) {
      const text = SPLIT_IN_DCS.replace(`${ESC}P`, `${ESC}${opener}`)
      expect(hasPreciseSecret(text, CONFIG), opener).toBe(true)
      for (const view of views(redactSecrets(text, CONFIG).text)) expect(view, opener).not.toContain(WHOLE)
    }
  })

  it('a control string holding no credential is left as it was', () => {
    const text = `${ESC}Pq${ESC}[31mplain words${ESC}\\ after`
    expect(redactSecrets(text, CONFIG)).toEqual({ text, count: 0 })
    expect(hasPreciseSecret(text, CONFIG)).toBe(false)
  })
})

describe('built bundle: the Bash hook stores the credential redacted', () => {
  it('no file the hook writes holds either half of it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-redact-dcs-'))
    try {
      const stdout = Array.from({ length: 300 }, (_, i) => `line ${i} of build output`).join('\n') + `\n${SPLIT_IN_DCS}\n`
      const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'redact-dcs', cwd: home, tool_name: 'Bash', tool_input: { command: 'make build' }, tool_response: { stdout, exitCode: 0 } })
      const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: payload, encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: home, XDG_DATA_HOME: home } })
      expect(run.status).toBe(0)
      const stored = fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'latin1')).join('\n')
      expect(stored.includes('[REDACTED:'), 'a redaction marker').toBe(true)
      expect(stored.includes('A'.repeat(18)), 'the first half').toBe(false)
      expect(stored.includes('B'.repeat(18)), 'the second half').toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
