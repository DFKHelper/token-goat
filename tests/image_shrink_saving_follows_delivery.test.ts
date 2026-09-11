/**
 * The image_shrink saving is booked only when the shrunk copy actually reaches the model.
 *
 * On VS Code the shrunk image reaches the model only as a rewritten view_image path to a temp file. The saving used to be booked by preReadImageHandler before the serializer tried to write that file, so a failed write left a ledger row for bytes the model never saw. The temp write is forced to fail for real by pointing TEMP/TMP/TMPDIR below a regular file, so os.tmpdir() names a directory that cannot exist.
 *
 * PROVENANCE: FORMAT-DERIVED. The VS Code payload envelope (hook_event_name, tool_name "view_image", tool_input.filePath) is the one ChatHookService.executePreToolUseHook builds in VS Code 1.136.0's resources/app/extensions/copilot/dist/extension.js, as cited in tests/vscode_hooks.test.ts; TOKEN_GOAT_HARNESS_OVERRIDE=vscode is what the shared Copilot shim sets when it runs the hook for a VS Code payload (src/bridges/copilot_cli.ts). The image is random noise generated here (HAND-DERIVED), large enough to qualify for a shrink.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { runHook, serializeOutput } from '../src/hook_registry.js'
import { summarize } from '../src/stats.js'

const ENV_KEYS = ['TOKEN_GOAT_HARNESS_OVERRIDE', 'TOKEN_GOAT_OFFLINE', 'TEMP', 'TMP', 'TMPDIR'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let dir: string
let imgPath: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-delivery-'))
  const side = 3000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  imgPath = path.join(dir, 'shot.jpeg')
  fs.writeFileSync(imgPath, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer())
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function shrinkRow(): { events: number; bytes: number } {
  const row = summarize(30).by_kind['image_shrink']
  return { events: row?.events ?? 0, bytes: row?.bytes_saved ?? 0 }
}

async function viewImage(): Promise<Record<string, unknown>> {
  const payload = { timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: 'vs-delivery', tool_name: 'view_image', tool_input: { filePath: imgPath }, tool_use_id: 'tu-1' }
  const event = buildEvent('pre_tool_use', normalizePayload(payload, 'vscode'))
  return JSON.parse(serializeOutput(await runHook(event), 'pre_tool_use', 'vscode', event)) as Record<string, unknown>
}

describe('image_shrink saving on VS Code follows the temp-file delivery', () => {
  it('books nothing when the shrunk copy cannot be written, then exactly one saving for the same image once it can', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
    // OCR declines before spawning tesseract, so no language data is fetched; noise has no text anyway.
    process.env['TOKEN_GOAT_OFFLINE'] = '1'

    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'a regular file, so nothing can be created below it')
    const unwritable = path.join(blocker, 'tmp')
    for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = unwritable
    expect(os.tmpdir()).toBe(unwritable)

    const before = shrinkRow()
    const failed = await viewImage()
    expect(failed, 'the write failed, so view_image must keep its original path').toEqual({})
    expect(shrinkRow(), 'no image_shrink row may be booked for a copy that was never written').toEqual(before)

    const writable = path.join(dir, 'tmp-ok')
    fs.mkdirSync(writable)
    for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = writable

    const delivered = await viewImage()
    const updated = (delivered['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['updatedInput'] as Record<string, unknown> | undefined
    const file = updated?.['filePath']
    expect(typeof file).toBe('string')
    expect(path.dirname(file as string)).toBe(writable)
    expect(path.basename(file as string)).toMatch(/^token-goat-shrink-\d+-\d+-[a-z0-9-]+\.(jpeg|webp|png)$/)
    const shrunkBytes = fs.statSync(file as string).size
    const originalBytes = fs.statSync(imgPath).size
    expect(shrunkBytes).toBeLessThan(originalBytes)

    const after = shrinkRow()
    expect(after.events - before.events, 'a delivered copy books exactly one saving').toBe(1)
    expect(after.bytes - before.bytes).toBe(originalBytes - shrunkBytes)
  })
})
