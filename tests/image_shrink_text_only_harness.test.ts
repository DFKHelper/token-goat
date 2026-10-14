/** A shrunk image reaches the model as an image only where something turns token-goat's payload into one: a rewritten Read path (Claude Code, VS Code) or a host bridge that decodes the data URL into a temp file and rewrites the read itself (Copilot CLI, pi, OpenClaw). Anywhere else the data URL would land in the model's context as text: a megabyte-scale base64 string a text model cannot use, beside a Read that still loads the original. A generic harness used to get exactly that, because an OpenClaw host called the hook without naming itself and was detected as generic. These cases pin that every other harness passes, on the in-process registry path and through the built bundle, and that the OpenClaw plugin names its harness so its shrink still ships. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { KNOWN_HARNESS_NAMES } from '../src/bridges/registry.js'
import { loadHiddenRuleCheck } from '../src/rewrite_permission.js'
import { clearPerRequestCaches } from '../src/reset.js'
import '../src/image_shrink.js'
import { BUNDLE } from './helpers/bundle.js'
import { HARNESS_DETECTION_ENV_KEYS, withHarnessOverride } from './helpers/harness-env.js'

/** Hosts whose bridge decodes the data URL out of the hook's context and never forwards that text to the model (copilotTranslate in src/hook_adapters.ts, MATERIALIZE_SHRUNK_IMAGE_JS in src/bridges/shrink_block.ts, pi.ts's typed copy). */
const DATA_URL_HOSTS = new Set(['copilot_cli', 'pi', 'openclaw'])
/** Harnesses whose PreToolUse takes a rewritten Read path to a copy this process writes. */
const PATH_REWRITE = new Set(['claudecode', 'vscode'])

const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const
let dir: string
let imagePath: string
const priorTemp = TEMP_KEYS.map((k) => process.env[k])

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-text-only-'))
  const side = 1200
  const noise = Buffer.allocUnsafe(side * side * 3)
  let x = 2463534242
  for (let i = 0; i < noise.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    noise[i] = x & 0xff
  }
  imagePath = path.join(dir, 'photo.png')
  fs.writeFileSync(imagePath, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer())
  expect(fs.statSync(imagePath).size).toBeGreaterThan(1024 * 1024)
  const copies = path.join(dir, 'copies')
  fs.mkdirSync(copies)
  for (const k of TEMP_KEYS) process.env[k] = copies
  process.env['TOKEN_GOAT_OFFLINE'] = '1'
  await loadHiddenRuleCheck()
})

afterAll(() => {
  TEMP_KEYS.forEach((k, i) => {
    const v = priorTemp[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  delete process.env['TOKEN_GOAT_OFFLINE']
  fs.rmSync(dir, { recursive: true, force: true })
})

function readPayload(sessionId: string): Record<string, unknown> {
  return { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: imagePath }, session_id: sessionId, cwd: dir, permission_mode: 'default' }
}

describe('image shrink on a harness that cannot take an image in place of the Read', () => {
  it.each([...KNOWN_HARNESS_NAMES])('%s: a data URL is emitted only to a host that decodes it, and nothing else gets context text', async (harness) => {
    clearPerRequestCaches()
    const out = await withHarnessOverride(harness, () => runHook(buildEvent('pre_tool_use', readPayload(`text-only-${harness}`))))
    const text = JSON.stringify(out)
    if (DATA_URL_HOSTS.has(harness)) {
      expect(out.hookType).toBe('context')
      expect(text).toContain('data:image/')
    } else {
      expect(text).not.toContain('data:image/')
      if (!PATH_REWRITE.has(harness)) expect(out).toEqual({ hookType: 'pass' })
    }
  })

  it('the built bundle answers a generic harness Read of a 1 MB image with no context at all', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
    const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { input: JSON.stringify(readPayload('text-only-bundle')), encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('data:image/')
    expect(run.stdout.length).toBeLessThan(10_000)
    expect(JSON.parse(run.stdout)).toEqual({})
  })

  it('the built bundle still hands an OpenClaw-pinned call the data URL its plugin turns into a file', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
    env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'openclaw'
    const run = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { input: JSON.stringify(readPayload('text-only-bundle-openclaw')), encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('data:image/')
  })
})
