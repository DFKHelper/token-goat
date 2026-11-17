/** Opt-in raw payload capture (TOKEN_GOAT_HOOK_CAPTURE). The payload is a HAND-DERIVED inline object. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { captureHookPayload, HOOK_CAPTURE_ENV, HOOK_CAPTURE_FILE, HOOK_CAPTURE_MAX_FILE_BYTES, HOOK_CAPTURE_MAX_PAYLOAD_BYTES } from '../src/hook_capture.js'
import { makeBundleProject, runBundle, type BundleProject } from './helpers/bundle.js'

let root: string
let proj: BundleProject

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cm-capture-')))
  proj = makeBundleProject('tg-cm-capture-bundle-')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(proj.root, { recursive: true, force: true })
})

const payload = { hook_event_name: 'PreToolUse', tool_name: 'REPL', tool_input: { code: 'return 1' } }

describe('captureHookPayload', () => {
  it('writes nothing when the variable is unset, empty or relative', async () => {
    await captureHookPayload(payload, {})
    await captureHookPayload(payload, { [HOOK_CAPTURE_ENV]: '' })
    // HAND-DERIVED: a plain relative value resolves under the cwd, so with cwd = root a write would land in root.
    const savedCwd = process.cwd()
    try {
      process.chdir(root)
      await captureHookPayload(payload, { [HOOK_CAPTURE_ENV]: 'rel-sub' })
    } finally {
      process.chdir(savedCwd)
    }
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('appends one JSON line per payload when on', async () => {
    const env = { [HOOK_CAPTURE_ENV]: root }
    await captureHookPayload(payload, env)
    await captureHookPayload({ ...payload, tool_name: 'Bash' }, env)
    const lines = fs.readFileSync(path.join(root, HOOK_CAPTURE_FILE), 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => (JSON.parse(l) as { tool_name: string }).tool_name)).toEqual(['REPL', 'Bash'])
  })

  it('never rejects when the directory cannot be written', async () => {
    const blocker = path.join(root, 'a-file')
    fs.writeFileSync(blocker, 'x')
    await expect(captureHookPayload(payload, { [HOOK_CAPTURE_ENV]: path.join(blocker, 'sub') })).resolves.toBeUndefined()
  })

  it('never throws on a payload that cannot be serialized', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(captureHookPayload(cyclic, { [HOOK_CAPTURE_ENV]: root })).resolves.toBeUndefined()
  })

  it('skips a payload over 1 MiB and still appends the next normal one', async () => {
    const env = { [HOOK_CAPTURE_ENV]: root }
    await captureHookPayload({ tool_name: 'Big', blob: 'x'.repeat(HOOK_CAPTURE_MAX_PAYLOAD_BYTES) }, env)
    await captureHookPayload({ ...payload, tool_name: 'Bash' }, env)
    const lines = fs.readFileSync(path.join(root, HOOK_CAPTURE_FILE), 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => (JSON.parse(l) as { tool_name: string }).tool_name)).toEqual(['Bash'])
  })

  it('appends nothing once the capture file is at the total bound', async () => {
    const file = path.join(root, HOOK_CAPTURE_FILE)
    fs.writeFileSync(file, '')
    fs.truncateSync(file, HOOK_CAPTURE_MAX_FILE_BYTES)
    await captureHookPayload(payload, { [HOOK_CAPTURE_ENV]: root })
    expect(fs.statSync(file).size).toBe(HOOK_CAPTURE_MAX_FILE_BYTES)
  })

  it.skipIf(process.platform !== 'win32')('refuses a root-only path with no drive on Windows (skipped off Windows: only there is it absolute)', async () => {
    // A bare separator root resolves against the working directory's drive, so set that to root's drive. A reverted check then writes into root on any drive layout, and the row finds the file.
    const savedCwd = process.cwd()
    process.chdir(path.parse(root).root)
    try {
      await captureHookPayload(payload, { [HOOK_CAPTURE_ENV]: root.slice(2) })
    } finally {
      process.chdir(savedCwd)
    }
    expect(fs.existsSync(path.join(root, HOOK_CAPTURE_FILE))).toBe(false)
  })
})

describe('built bundle capture', () => {
  const input = JSON.stringify(payload)

  it('off by default: a hook call writes no capture file when the variable is unset or relative', () => {
    // The helper copies the parent environment, so a variable set in the developer's shell is stripped here.
    const { [HOOK_CAPTURE_ENV]: _inherited, ...unsetEnv } = proj.env
    const unset = runBundle(['hook', 'pre_tool_use'], { cwd: proj.project, env: unsetEnv, input, timeout: 60000 })
    expect(unset.status, unset.stderr).toBe(0)
    // An always-on capture with no configured directory would land in the hook's working directory.
    expect(fs.existsSync(path.join(proj.project, HOOK_CAPTURE_FILE))).toBe(false)

    // HAND-DERIVED: with cwd = root a plain relative value would resolve under root, so root must stay empty.
    const relativeEnv = { ...unsetEnv, [HOOK_CAPTURE_ENV]: 'rel-sub' }
    const relative = runBundle(['hook', 'pre_tool_use'], { cwd: root, env: relativeEnv, input, timeout: 60000 })
    expect(relative.status, relative.stderr).toBe(0)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('on: one line per payload, and an unwritable directory still gives exit 0 and {}', () => {
    const on = runBundle(['hook', 'pre_tool_use'], { cwd: proj.project, env: { ...proj.env, [HOOK_CAPTURE_ENV]: root }, input, timeout: 60000 })
    expect(on.status, on.stderr).toBe(0)
    const file = path.join(root, HOOK_CAPTURE_FILE)
    // The hook does not await the append; the process lives until it lands, so the file exists after exit.
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)

    const blocker = path.join(root, 'a-file')
    fs.writeFileSync(blocker, 'x')
    const bad = runBundle(['hook', 'pre_tool_use'], { cwd: proj.project, env: { ...proj.env, [HOOK_CAPTURE_ENV]: path.join(blocker, 'sub') }, input, timeout: 60000 })
    expect(bad.status, bad.stderr).toBe(0)
    expect(bad.stdout.trim()).toBe('{}')
  })
})
