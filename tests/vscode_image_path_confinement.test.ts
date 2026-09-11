/**
 * On VS Code the image hook runs before VS Code asks the user to approve the call, so it must not open a path the model chose outside the workspace.
 *
 * A UNC or device path is declined before any fs call (on Windows a stat of a UNC path opens an SMB connection to that host), and so is a path outside the workspace folder VS Code runs the hook in. node:fs is wrapped with pass-through recorders so the test can see every path handed to it; a UNC or device path throws inside the wrapper instead of reaching the real fs, so no network access happens even on the unfixed code. The no-fs-access check calls preReadImageHandler itself; the {} and ledger checks go through the full registry and serializer, and tests/vscode_pre_handler_path_gate.test.ts covers every other handler on the same tools.
 *
 * PROVENANCE: FORMAT-DERIVED. The view_image envelope is VS Code 1.136.0's, as cited in tests/vscode_hooks.test.ts; VS Code sends no cwd and runs the hook in the workspace folder, which normalizePayload's vscode branch fills from process.cwd(), so the test chdirs into the workspace rather than putting a cwd on the payload. Images are random noise generated here (HAND-DERIVED).
 */
import * as fsReal from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const touched = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof fsReal>()
  const record = <F>(fn: F): F =>
    ((...args: unknown[]) => {
      const p = args[0]
      if (typeof p === 'string') {
        touched.push(p)
        if (/^[\\/]{2}/.test(p)) throw Object.assign(new Error(`ENOENT: test wrapper refused ${p}`), { code: 'ENOENT' })
      }
      return (fn as (...a: unknown[]) => unknown)(...args)
    }) as F
  const overrides = {
    statSync: record(orig.statSync),
    lstatSync: record(orig.lstatSync),
    readFileSync: record(orig.readFileSync),
    openSync: record(orig.openSync),
    existsSync: record(orig.existsSync),
    accessSync: record(orig.accessSync),
    realpathSync: Object.assign(record(orig.realpathSync), { native: record(orig.realpathSync.native) }),
  }
  return { ...orig, ...overrides, default: { ...orig, ...overrides } }
})

import sharp from 'sharp'

import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { runHook, serializeOutput } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import { preReadImageHandler } from '../src/image_shrink.js'
import { normalizePath } from '../src/paths.js'
import { summarize } from '../src/stats.js'

const savedEnv = { override: process.env['TOKEN_GOAT_HARNESS_OVERRIDE'], offline: process.env['TOKEN_GOAT_OFFLINE'] }
const savedCwd = process.cwd()
let base: string
let workspace: string
let insidePng: string
let outsidePng: string

async function noisePng(file: string): Promise<void> {
  const side = 2000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  fsReal.writeFileSync(file, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer())
}

beforeAll(async () => {
  base = fsReal.realpathSync(fsReal.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-confine-')))
  workspace = path.join(base, 'workspace')
  const outside = path.join(base, 'elsewhere')
  fsReal.mkdirSync(workspace)
  fsReal.mkdirSync(outside)
  insidePng = path.join(workspace, 'shot.png')
  outsidePng = path.join(outside, 'shot.png')
  await noisePng(insidePng)
  await noisePng(outsidePng)
})

afterEach(() => {
  process.chdir(savedCwd)
  if (savedEnv.override === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedEnv.override
  if (savedEnv.offline === undefined) delete process.env['TOKEN_GOAT_OFFLINE']
  else process.env['TOKEN_GOAT_OFFLINE'] = savedEnv.offline
})

afterAll(() => {
  fsReal.rmSync(base, { recursive: true, force: true })
})

function shrinkEvents(): number {
  return summarize(30).by_kind['image_shrink']?.events ?? 0
}

function viewImageEvent(filePath: string): HookEvent {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
  process.env['TOKEN_GOAT_OFFLINE'] = '1'
  process.chdir(workspace)
  const payload = { timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: `confine-${Math.random().toString(36).slice(2)}`, tool_name: 'view_image', tool_input: { filePath }, tool_use_id: 'tu-1' }
  return buildEvent('pre_tool_use', normalizePayload(payload, 'vscode'))
}

async function viewImage(filePath: string): Promise<Record<string, unknown>> {
  const event = viewImageEvent(filePath)
  return JSON.parse(serializeOutput(await runHook(event), 'pre_tool_use', 'vscode', event)) as Record<string, unknown>
}

/** Runs the image handler alone and returns its verdict plus every path it handed to fs. */
async function imageHandlerAlone(filePath: string): Promise<{ hookType: string; touched: string[] }> {
  const event = viewImageEvent(filePath)
  touched.length = 0
  const out = await preReadImageHandler(event)
  return { hookType: out.hookType, touched: [...touched] }
}

function sameFile(a: string, b: string): boolean {
  return normalizePath(path.resolve(workspace, a)) === normalizePath(path.resolve(workspace, b))
}

describe('view_image on VS Code: paths the hook declines before touching them', () => {
  it.each([
    ['a UNC path', '\\\\tg-no-such-host\\share\\shot.png'],
    ['a forward-slash UNC path', '//tg-no-such-host/share/shot.png'],
    ['an extended-length device path', '\\\\?\\C:\\tg-no-such-dir\\shot.png'],
    ['a device namespace path', '\\\\.\\C:\\tg-no-such-dir\\shot.png'],
  ])('%s: the image handler passes without an fs call on it, and the hook gives {} with no saving', async (_label, target) => {
    const alone = await imageHandlerAlone(target)
    expect(alone.hookType).toBe('pass')
    expect(alone.touched.filter((p) => p.includes('tg-no-such')), 'no fs call may be handed the path').toEqual([])
    const before = shrinkEvents()
    expect(await viewImage(target)).toEqual({})
    expect(shrinkEvents()).toBe(before)
  })

  it.each([
    ['an absolute path', (): string => outsidePng],
    ['a relative path that climbs out', (): string => path.join('..', 'elsewhere', 'shot.png')],
  ])('an image outside the workspace, given as %s: passes without an fs call on it, {} and no saving', async (_label, target) => {
    const alone = await imageHandlerAlone(target())
    expect(alone.hookType).toBe('pass')
    expect(alone.touched.filter((p) => sameFile(p, outsidePng)), 'no fs call may be handed the path').toEqual([])
    const before = shrinkEvents()
    expect(await viewImage(target())).toEqual({})
    expect(shrinkEvents()).toBe(before)
  })
})

describe('view_image on VS Code: an image inside the workspace still shrinks', () => {
  it('points filePath at a smaller temp copy and books one saving', async () => {
    const before = shrinkEvents()
    const out = await viewImage(insidePng)
    const file = ((out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['updatedInput'] as Record<string, unknown> | undefined)?.['filePath']
    expect(typeof file).toBe('string')
    expect(fsReal.statSync(file as string).size).toBeLessThan(fsReal.statSync(insidePng).size)
    expect(shrinkEvents() - before).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('writes the temp copy readable by its owner only (0600)', async () => {
    // A separate image so this case does not depend on the one above having filled the shrink cache.
    const own = path.join(workspace, 'mode.png')
    await noisePng(own)
    const out = await viewImage(own)
    const file = ((out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['updatedInput'] as Record<string, unknown> | undefined)?.['filePath'] as string
    expect(fsReal.statSync(file).mode & 0o777).toBe(0o600)
  })
})
