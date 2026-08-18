/**
 * `gdrive.enabled = false` must remove the Google Drive integration from both surfaces it has:
 * the command itself, and every place the installed agent guidance names it.
 *
 * Both halves matter independently. A gate on the command alone leaves an agent reading
 * `gdrive-sections <file-id>` in its own instructions file and reaching for a command this
 * install refuses; removing it from the guidance alone leaves the command reachable by anyone
 * who types it. An organisation that does not use Google Drive asked for neither to be present.
 */

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

import { buildGuidanceBody, buildGuidanceBlock } from '../src/bridges/guidance_block.js'

const CLAUSE = "Claude Code's own Read, Grep, and Glob preference rules"

function commandsLine(body: string): string {
  return body.split('\n').find((l) => l.startsWith('Commands:')) ?? ''
}

describe('gdrive.enabled guidance gate', () => {
  it('names gdrive-sections by default', () => {
    expect(commandsLine(buildGuidanceBody(CLAUSE))).toContain('`gdrive-sections <file-id>`')
  })

  it('names gdrive-sections when explicitly enabled', () => {
    expect(commandsLine(buildGuidanceBody(CLAUSE, { gdrive: true }))).toContain('`gdrive-sections <file-id>`')
  })

  it('omits gdrive-sections entirely when disabled', () => {
    const body = buildGuidanceBody(CLAUSE, { gdrive: false })
    expect(body).not.toContain('gdrive')
  })

  // The whole line, not just the command: dropping a list item must not eat a neighbour or leave
  // a doubled separator, which a `toContain('gdrive')` check alone would not notice.
  it('leaves the rest of the Commands line intact when disabled', () => {
    const off = commandsLine(buildGuidanceBody(CLAUSE, { gdrive: false }))
    const on = commandsLine(buildGuidanceBody(CLAUSE, { gdrive: true }))

    expect(off).toBe(on.replace('`gdrive-sections <file-id>`, ', ''))
    expect(off).toContain('`bash-output`/`web-output`/`mcp-output`, `image-meta file`')
    expect(off).not.toContain(', ,')
  })

  // buildGuidanceBlock is the wrapper three of the four surfaces go through; the flag has to
  // survive the hop rather than being silently dropped between the two functions.
  it('passes the flag through buildGuidanceBlock', () => {
    const block = buildGuidanceBlock({
      beginMarker: '<!-- b -->',
      endMarker: '<!-- e -->',
      fallbackToolClause: CLAUSE,
      gdrive: false,
    })

    expect(block).not.toContain('gdrive')
    expect(block.startsWith('<!-- b -->')).toBe(true)
  })

  it('defaults to enabled when the harness omits the flag', () => {
    const block = buildGuidanceBlock({ beginMarker: '<!-- b -->', endMarker: '<!-- e -->', fallbackToolClause: CLAUSE })

    expect(block).toContain('`gdrive-sections <file-id>`')
  })
})

describe('gdrive.enabled command gate (built bundle)', () => {
  function run(enabled: string): { status: number | null; out: string } {
    const res = spawnSync(process.execPath, [BUNDLE, 'gdrive-sections', '1AbCdEfGhIjKlMnOpQrStUvWxYz'], {
      encoding: 'utf8',
      env: { ...process.env, TOKEN_GOAT_GDRIVE_ENABLED: enabled },
    })
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }

  // No network assertion is needed to make this meaningful: the refusal happens before fetchDoc,
  // so a run that reached Google would take seconds and report an HTTP status instead.
  it('refuses the command when disabled, naming the setting', () => {
    const { status, out } = run('false')

    expect(status).not.toBe(0)
    expect(out).toContain('gdrive.enabled')
    expect(out).not.toMatch(/HTTP \d/)
  })
})
