/** On Claude Code a shrunk image reaches the model only as a rewritten Read path, never as hook context text. The shrink used to answer Claude Code's PreToolUse with the shrunk image as a base64 data URL in `additionalContext` and book the saving. Claude Code does not turn context text into an image: per https://code.claude.com/docs/en/hooks ("A hook's `additionalContext` ... capped at 10,000 characters", over the limit "saves the output to a file in the session directory and replaces it with the file path and a preview of up to the first 2,000 characters"), a megabyte data URL became a 2,000-character preview of base64 while the Read went on to load the full original image, and stats booked the whole difference as saved. PROVENANCE: FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (fetched 2026-10-04): the PreToolUse input envelope (`hook_event_name`, `tool_name` "Read", `tool_input.file_path` absolute, `cwd`, `session_id`, `tool_use_id`), the `updatedInput` field ("Replaces the entire input object"), the 10,000-character `additionalContext` cap, and the permissions page's "Read-only ... No [approval], within the working directory and additional directories" (https://code.claude.com/docs/en/permissions), which is why an image outside `cwd` is left alone: the rewrite is answered with `permissionDecision: "allow"` (when no Read deny or ask rule could match; see tests/rewrite_permission_e2e.test.ts), and granting a read outside the working directory is the user's call. The image is random noise generated here (HAND-DERIVED), large enough to qualify for a shrink. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { runHook, serializeOutput } from '../src/hook_registry.js'
import { summarize } from '../src/stats.js'

/** Claude Code's documented per-field cap on `additionalContext`. */
const CLAUDE_CODE_CONTEXT_CAP = 10_000

const ENV_KEYS = ['TOKEN_GOAT_HARNESS_OVERRIDE', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_OCR_ENABLED', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const savedCwd = process.cwd()

let dir: string
let project: string
let outside: string
let shrinkTemp: string

async function writeNoiseJpeg(file: string): Promise<void> {
  const side = 3000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  fs.writeFileSync(file, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer())
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-cc-'))
  project = path.join(dir, 'project')
  outside = path.join(dir, 'elsewhere')
  shrinkTemp = path.join(dir, 'tmp')
  for (const d of [project, outside, shrinkTemp]) fs.mkdirSync(d)
  await writeNoiseJpeg(path.join(project, 'shot.jpeg'))
  fs.copyFileSync(path.join(project, 'shot.jpeg'), path.join(outside, 'shot.jpeg'))
})

afterEach(() => {
  process.chdir(savedCwd)
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

async function claudeCodeRead(filePath: string, toolUseId: string, cwd: string = project): Promise<{ wire: string; parsed: Record<string, unknown> }> {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  // A host that passes its own flags where token-goat cannot see them (the accepted limit in docs/security.md); a terminal session would need a readable claude process, which a shrink test has no use for.
  process.env['CLAUDE_CODE_ENTRYPOINT'] = 'claude-vscode'
  // OCR declines before spawning tesseract, so no language data is fetched; noise has no text anyway.
  process.env['TOKEN_GOAT_OFFLINE'] = '1'
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = shrinkTemp
  const payload = { session_id: 'cc-shrink-delivery', transcript_path: path.join(dir, 't.jsonl'), cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: filePath }, tool_use_id: toolUseId }
  process.chdir(cwd)
  const event = buildEvent('pre_tool_use', normalizePayload(payload, 'claude'))
  const wire = serializeOutput(await runHook(event), 'pre_tool_use', 'claudecode', event)
  return { wire, parsed: JSON.parse(wire) as Record<string, unknown> }
}

/** A PNG that is only its signature, header and end chunk, declaring `width` x `height` pixels: enough for the header-only probe, with no pixels to decode. FORMAT-DERIVED from the PNG specification (signature, IHDR of 13 bytes, CRC-32 over type and data). */
function pngHeader(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

function overPixelLimitEvents(): number {
  return summarize(30).by_kind['image_shrink_over_pixel_limit']?.events ?? 0
}

function contextOf(parsed: Record<string, unknown>): string | undefined {
  return (parsed['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] as string | undefined
}

describe('image shrink on Claude Code', () => {
  it('rewrites the Read to a shrunk temp copy, carries no image text, and books exactly the delivered saving', async () => {
    const original = path.join(project, 'shot.jpeg')
    const before = shrinkRow()
    const { parsed } = await claudeCodeRead(original, 'tu-in')
    const hso = parsed['hookSpecificOutput'] as Record<string, unknown> | undefined
    expect(hso?.['hookEventName']).toBe('PreToolUse')
    expect(hso?.['permissionDecision']).toBe('allow')
    const ctx = contextOf(parsed)
    expect(ctx === undefined || ctx.length <= CLAUDE_CODE_CONTEXT_CAP, 'additionalContext must stay within Claude Code\'s 10,000-character cap').toBe(true)
    expect(ctx ?? '').not.toContain('data:image/')
    const file = (hso?.['updatedInput'] as Record<string, unknown> | undefined)?.['file_path']
    expect(typeof file).toBe('string')
    expect(path.dirname(file as string)).toBe(shrinkTemp)
    const shrunkBytes = fs.statSync(file as string).size
    const originalBytes = fs.statSync(original).size
    expect(shrunkBytes).toBeLessThan(originalBytes)
    const after = shrinkRow()
    expect(after.events - before.events, 'a delivered copy books exactly one saving').toBe(1)
    expect(after.bytes - before.bytes).toBe(originalBytes - shrunkBytes)
  })

  it('leaves an image outside the working directory alone and books nothing, since an allow there would skip Claude Code\'s own prompt', async () => {
    const before = shrinkRow()
    const { parsed } = await claudeCodeRead(path.join(outside, 'shot.jpeg'), 'tu-out')
    expect(parsed).toEqual({})
    expect(shrinkRow()).toEqual(before)
  })

  // HAND-DERIVED: a header declaring 10,000 x 10,000 pixels, past the default 64,000,000-pixel limit, so the shrink path books image_shrink_over_pixel_limit as soon as it has opened and probed the file. The rule decision has to come first: Claude Code refuses the original, but a shrunk copy left in token-goat's cache is a file no Read rule covers.
  it('opens nothing of an image a Read deny rule covers, and does open the same image outside the rule', async () => {
    const guarded = path.join(dir, 'guarded')
    fs.mkdirSync(path.join(guarded, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(guarded, 'private'))
    fs.writeFileSync(path.join(guarded, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./private/**)'] } }))
    const denied = path.join(guarded, 'private', 'huge.png')
    const open = path.join(guarded, 'huge.png')
    fs.writeFileSync(denied, pngHeader(10_000, 10_000))
    fs.writeFileSync(open, pngHeader(10_000, 10_000))
    const before = overPixelLimitEvents()
    expect((await claudeCodeRead(denied, 'tu-denied', guarded)).parsed).toEqual({})
    expect(overPixelLimitEvents(), 'the denied image was opened before the rule decision').toBe(before)
    // The control: the probe this case counts on does run for an image no rule covers.
    expect((await claudeCodeRead(open, 'tu-open', guarded)).parsed).toEqual({})
    expect(overPixelLimitEvents()).toBe(before + 1)
  })

  it('never serializes a shrunk-image data URL as Claude Code context, while a host-materialized harness still receives it', () => {
    const payload = 'token-goat shrank x.png: 2kb -> 1kb\ndata:image/png;base64,' + 'A'.repeat(64)
    expect(serializeOutput({ hookType: 'context', context: payload }, 'pre_tool_use', 'claudecode')).toBe('{}')
    expect(contextOf(JSON.parse(serializeOutput({ hookType: 'context', context: payload }, 'pre_tool_use', 'copilot_cli')) as Record<string, unknown>)).toBe(payload)
  })
})
