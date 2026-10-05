/** The shipped bundle's PreToolUse rewrites against real Claude Code settings files: a rewrite must never carry `permissionDecision: "allow"` past a rule the user wrote, and must not happen at all where a deny or ask rule could match the original. Claude Code matches its rules against the hook's `updatedInput` (https://code.claude.com/docs/en/hooks, PreToolUse decision control: `updatedInput` "Replaces the entire input object", `allow` "bypasses the permission prompt"), so a `token-goat compress` wrapper or a shrunk image's temp path is what a rule would see. PROVENANCE: FORMAT-DERIVED payload envelope from https://code.claude.com/docs/en/hooks (`session_id`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`); FORMAT-DERIVED settings shape and rule syntax from https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/permissions (`permissions.deny`, `Bash(curl:*)`, `Read(./private/**)`); the image is random noise generated here (HAND-DERIVED). Every child runs with HOME, CLAUDE_CONFIG_DIR and the data dirs inside a temp tree and its cwd in the project there, so no developer settings take part. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-perm-e2e-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

interface Sandbox {
  readonly home: string
  readonly project: string
  readonly temp: string
  readonly env: NodeJS.ProcessEnv
}

function sandbox(name: string, userSettings?: unknown, projectSettings?: unknown): Sandbox {
  const base = path.join(root, name)
  const home = path.join(base, 'home')
  const project = path.join(base, 'proj')
  const temp = path.join(base, 'tmp')
  const claude = path.join(home, 'claude')
  for (const d of [home, project, temp, claude]) fs.mkdirSync(d, { recursive: true })
  if (userSettings !== undefined) fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(userSettings))
  if (projectSettings !== undefined) {
    fs.mkdirSync(path.join(project, '.claude'))
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(projectSettings))
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKEN_GOAT_HOME: path.join(home, 'tg'),
    LOCALAPPDATA: path.join(home, 'la'),
    XDG_DATA_HOME: path.join(home, 'xd'),
    APPDATA: path.join(home, 'ad'),
    CLAUDE_CONFIG_DIR: claude,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
    TOKEN_GOAT_OCR_ENABLED: 'false',
    TOKEN_GOAT_OFFLINE: '1',
  }
  delete env['TOKEN_GOAT_BASH_COMPRESS']
  return { home, project, temp, env }
}

function hook(box: Sandbox, toolName: string, toolInput: Record<string, unknown>, mode = 'default'): Record<string, unknown> | undefined {
  const payload = { session_id: `perm-e2e-${path.basename(path.dirname(box.home))}`, cwd: box.project, permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env: box.env, input: JSON.stringify(payload), encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return (JSON.parse(res.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
}

function shrinkEvents(box: Sandbox): number {
  const res = spawnSync(process.execPath, [BUNDLE, 'stats', '--json'], { cwd: box.project, env: box.env, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  const parsed = JSON.parse(res.stdout) as { by_kind?: Record<string, { events?: number }> }
  return parsed.by_kind?.['image_shrink']?.events ?? 0
}

async function writeNoiseJpeg(file: string): Promise<void> {
  const side = 1600
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100 }).toBuffer())
}

describe('shell rewrites honor Claude Code permission rules (built bundle)', () => {
  it('a Bash deny rule keeps the original command: no rewrite reaches Claude Code to slip past it', () => {
    const box = sandbox('deny-curl', { permissions: { deny: ['Bash(curl:*)'] } })
    expect(hook(box, 'Bash', { command: 'curl -s https://example.com' })).toBeUndefined()
  })

  it('with no rules the same command is rewritten, with no decision, so Claude Code still asks', () => {
    const box = sandbox('none-curl')
    const hso = hook(box, 'Bash', { command: 'curl -s https://example.com' })
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f curl --timeout 600 -c 'curl -s https://example.com'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })

  it('an unproven build command is rewritten with no permissionDecision', () => {
    const box = sandbox('none-go')
    const hso = hook(box, 'Bash', { command: 'go build ./...' })
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f go --timeout 600 -c 'go build ./...'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })

  it('a user allow rule for the original proves it auto-allowed, so the rewrite may say allow', () => {
    const box = sandbox('allow-go', { permissions: { allow: ['Bash(go build:*)'] } })
    const hso = hook(box, 'Bash', { command: 'go build ./...' })
    expect(hso?.['permissionDecision']).toBe('allow')
  })

  // HAND-DERIVED from https://code.claude.com/docs/en/permission-modes: entering auto mode drops package-manager run rules, and an unproven call goes to the classifier, which a hook allow would skip.
  it('in auto mode an allow rule auto mode drops proves nothing: the original is left to the classifier', () => {
    const box = sandbox('auto-npm-run', { permissions: { allow: ['Bash(npm run *)'] } })
    expect(hook(box, 'Bash', { command: 'npm run build' })?.['permissionDecision']).toBe('allow')
    expect(hook(box, 'Bash', { command: 'npm run build' }, 'auto')).toBeUndefined()
    const hso = hook(sandbox('auto-go', { permissions: { allow: ['Bash(npm run *)'] } }), 'Bash', { command: 'go build ./...' }, 'auto')
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f go --timeout 600 -c 'go build ./...'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })

  it('bypassPermissions gets the rewrite with no permissionDecision', () => {
    const box = sandbox('bypass-go')
    const hso = hook(box, 'Bash', { command: 'go build ./...' }, 'bypassPermissions')
    expect(hso?.['updatedInput']).toEqual({ command: "token-goat compress -f go --timeout 600 -c 'go build ./...'" })
    expect(hso !== undefined && 'permissionDecision' in hso).toBe(false)
  })
})

describe('image Read rewrites honor Claude Code Read rules (built bundle)', () => {
  it('a Read deny rule on the image keeps the original Read, writes no copy and books no saving', async () => {
    const box = sandbox('deny-private', undefined, { permissions: { deny: ['Read(./private/**)'] } })
    const image = path.join(box.project, 'private', 'shot.jpg')
    await writeNoiseJpeg(image)
    expect(hook(box, 'Read', { file_path: image })).toBeUndefined()
    expect(fs.readdirSync(box.temp).filter((n) => n.startsWith('token-goat-shrink-'))).toEqual([])
    expect(shrinkEvents(box)).toBe(0)
  }, 60_000)

  it('with no rules the same image is rewritten to a shrunk copy with allow, and the saving is booked', async () => {
    const box = sandbox('none-private')
    const image = path.join(box.project, 'private', 'shot.jpg')
    await writeNoiseJpeg(image)
    const hso = hook(box, 'Read', { file_path: image })
    expect(hso?.['permissionDecision']).toBe('allow')
    const file = (hso?.['updatedInput'] as Record<string, unknown> | undefined)?.['file_path']
    expect(typeof file === 'string' && path.basename(file).startsWith('token-goat-shrink-')).toBe(true)
    expect(shrinkEvents(box)).toBe(1)
  }, 60_000)
})

// HAND-DERIVED from https://code.claude.com/docs/en/permissions: a Read deny or ask rule applies to Claude Code's Read and Grep tools and to its recognized file commands in Bash (cat, head, sed), but never to a token-goat command those calls are pointed at instead.
describe('read hints honor Claude Code Read rules (built bundle)', () => {
  const lock = JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': { name: 'p' } } }, null, 2)
  const source = Array.from({ length: 400 }, (_, i) => `export function f${i}(a: number): number {\n  return a + ${i}\n}\n`).join('')
  let calls = 0

  function project(name: string, rule: 'deny' | 'ask'): Sandbox {
    const box = sandbox(name, undefined, { permissions: { [rule]: ['Read(./secrets/**)'] } })
    for (const dir of ['secrets', 'open']) {
      fs.mkdirSync(path.join(box.project, dir, 'node_modules', 'x'), { recursive: true })
      fs.writeFileSync(path.join(box.project, dir, 'package-lock.json'), lock)
      fs.writeFileSync(path.join(box.project, dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
      fs.writeFileSync(path.join(box.project, dir, 'app.ts'), source)
    }
    return box
  }

  // The whole answer, since a Claude Code refusal is a top-level decision rather than hookSpecificOutput; each call gets its own session so no once-per-session hint is spent by an earlier one.
  function answer(box: Sandbox, toolName: string, toolInput: Record<string, unknown>): string {
    const payload = { session_id: `read-hint-${calls++}`, cwd: box.project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env: { ...box.env, CLAUDE_PROJECT_DIR: box.project }, input: JSON.stringify(payload), encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    return res.stdout.trim()
  }

  for (const rule of ['deny', 'ask'] as const) {
    it(`a Read ${rule} rule holds back the token-goat hints for a Read, a Grep or a cat under it, and leaves them for the files beside it`, () => {
      const box = project(`read-hint-${rule}`, rule)
      for (const dir of ['secrets', 'open']) {
        const shown = dir === 'open'
        const lockAnswer = answer(box, 'Read', { file_path: path.join(box.project, dir, 'package-lock.json') })
        expect(lockAnswer.includes('token-goat json-outline'), lockAnswer).toBe(shown)
        const modulesAnswer = answer(box, 'Read', { file_path: path.join(box.project, dir, 'node_modules', 'x', 'index.js') })
        expect(modulesAnswer.includes('node_modules is typically noise'), modulesAnswer).toBe(shown)
        const grepAnswer = answer(box, 'Grep', { pattern: '^export function', path: path.join(box.project, dir, 'app.ts') })
        expect(grepAnswer.includes('token-goat skeleton'), grepAnswer).toBe(shown)
        const catAnswer = answer(box, 'Bash', { command: `cat ${dir}/app.ts` })
        expect(catAnswer.includes('token-goat read'), catAnswer).toBe(shown)
        const catLockAnswer = answer(box, 'Bash', { command: `cat ${dir}/package-lock.json` })
        expect(catLockAnswer.includes('token-goat json-query'), catLockAnswer).toBe(shown)
        if (!shown) expect([lockAnswer, modulesAnswer, grepAnswer, catAnswer, catLockAnswer]).toEqual(['{}', '{}', '{}', '{}', '{}'])
      }
    })
  }

  it('a warning about how a command is written still reaches a command naming a covered file', () => {
    const box = project('read-hint-quote', 'deny')
    expect(answer(box, 'Bash', { command: 'cat "secrets/app.ts' })).toContain('unclosed double quote')
  })
})
