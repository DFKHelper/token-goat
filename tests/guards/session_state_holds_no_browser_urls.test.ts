/**
 * The open-tab list a browser tool reports must not reach the session file on disk.
 *
 * `hooks_browser_image.ts` shortens a repeated "Tab Context:" block to a placeholder, which means
 * it has to recognize a repeat, which means remembering the previous one across hook processes --
 * and session state is written to disk. The block is a list of the tabs open in the user's browser:
 * titles and full URLs. A URL routinely carries a credential in it (a session token, a signed
 * object link, a password-reset parameter), so storing the block verbatim writes whatever happened
 * to be in the address bar into a file, for a value nothing ever reads back for its content.
 *
 * Only one question is ever asked of the stored value -- is the next block identical to this one --
 * and a fingerprint answers it exactly, so a fingerprint is what gets stored. `curlDownloadKey`
 * already does this for download URLs for the same reason; this is that rule applied to the one
 * remaining place a URL was still being kept whole.
 *
 * PROVENANCE
 *
 * The tab-context fixture is FORMAT-DERIVED from the shape `TAB_CONTEXT_RE` matches in
 * `src/hooks_browser_image.ts`, with the URL replaced by one carrying an obvious marker. The marker
 * is HAND-CHOSEN and appears nowhere in the codebase, so finding it in the file can only mean the
 * block reached disk.
 *
 * WHY IT DRIVES THE HOOK AND READS THE FILE
 *
 * Asserting on `lastTabContextMatches` would only prove the accessor hashes. The property that
 * matters is about bytes on disk, and the path from the tool result to those bytes runs through the
 * hook, the export, and the store -- six touch points, two of which this repo has already shipped a
 * bug in (see the round-trip regression in tests/session_store.test.ts). So the test runs the real
 * post-hook and then reads the file that was actually written.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { postBrowserImageHandler } from '../../src/hooks_browser_image.js'
import { makeHookEvent } from '../helpers/hook-event.js'
import { exportSessionState, importSessionState, type SerializedSession } from '../../src/session.js'
import { readSessionStateFile, saveSessionState } from '../../src/session_store.js'

/** A token that exists nowhere else in this repo, so a hit is unambiguous. */
const SECRET = 'tg-tab-url-marker-8f2b19c4'

const TAB_CONTEXT =
  '\n\nTab Context:\n- Available tabs:\n' +
  `  • tabId 1: "Payroll" (https://payroll.example.com/session?token=${SECRET})\n` +
  `  • tabId 2: "Reset" (https://mail.example.com/reset?k=${SECRET})`

/** A 1x1 PNG. The image path is not what is under test; the text block travelling with it is. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-taburl-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] } as SerializedSession)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('session state written to disk', () => {
  it('records the tab list as a fingerprint, so no tab URL is ever written to the file', async () => {
    await postBrowserImageHandler(
      makeHookEvent({
        eventName: 'post_tool_use',
        toolName: 'mcp__claude-in-chrome__computer',
        toolInput: {},
        sessionId: 'taburl',
        raw: {
          tool_response: {
            content: [
              { type: 'text', text: 'Took a screenshot of the current page.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
              { type: 'text', text: TAB_CONTEXT },
            ],
          },
        },
      }),
    )

    // The hook must actually have recorded something, or every assertion below passes on an empty
    // file -- the vacuous-pass shape this repo keeps hitting.
    const digest = exportSessionState().lastTabContextDigest
    expect(digest, 'the hook recorded no tab context at all, so this test proves nothing').toBeTruthy()
    expect(digest).not.toContain(SECRET)

    saveSessionState('taburl')

    const onDisk = readSessionStateFile('taburl')
    expect(onDisk?.lastTabContextDigest, 'the digest did not survive the round-trip').toBe(digest)

    // The whole file, not just the field: a tab URL landing in some other key would be the same
    // disclosure by a different route.
    const raw = fs.readFileSync(path.join(tmpHome, 'sessions', 'taburl.json'), 'utf8')
    expect(raw, 'a tab URL reached the session file on disk').not.toContain(SECRET)
    expect(raw).not.toContain('payroll.example.com')
  })
})
