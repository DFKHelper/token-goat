import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { preReadHandler, postReadHandler } from '../src/hooks_read'
import type { HookEvent } from '../src/hook_registry'
import { loadConfig } from '../src/config'
import { getSessionId } from '../src/session'
import { makeProjectAt } from '../src/project'
import { writeSessionManifest } from '../src/compact'
import { dataDir } from '../src/constants'
import os from 'node:os'

function makeRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
  tmpDirs.push(tmpDir)
  const repoDir = path.join(tmpDir, 'repo')
  fs.mkdirSync(repoDir)
  fs.writeFileSync(path.join(repoDir, '.git'), '')
  return repoDir
}

const tmpDirs: string[] = []

function cleanup() {
  tmpDirs.forEach(dir => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })
  tmpDirs.length = 0
}

afterEach(cleanup)

describe('Cross-session read dedup', () => {
  it('config flag has correct defaults (disabled by default)', () => {
    const cfg = loadConfig()
    expect(cfg.hints.cross_session_read_dedup).toBe(false)
    expect(cfg.hints.cross_session_read_dedup_ttl_secs).toBe(2700)
  })

  it('does not write manifest when flag is disabled (default)', () => {
    const cfg = loadConfig()
    expect(cfg.hints.cross_session_read_dedup).toBe(false)

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
    tmpDirs.push(tmpDir)
    const repoDir = path.join(tmpDir, 'repo')
    fs.mkdirSync(repoDir)
    fs.writeFileSync(path.join(repoDir, '.git'), '')

    const filePath = path.join(repoDir, 'test.txt')
    fs.writeFileSync(filePath, 'test content')

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir, output: 'test output' },
    }

    const postResult = postReadHandler(postEvent)
    expect(postResult.hookType).toBe('pass')
  })

  it('handles missing project gracefully in preReadHandler', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
    tmpDirs.push(tmpDir)

    const filePath = path.join(tmpDir, 'orphan.txt')
    fs.writeFileSync(filePath, 'test content')

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: {},
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('does not crash when postReadHandler is called with no cwd', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
    tmpDirs.push(tmpDir)

    const filePath = path.join(tmpDir, 'test.txt')
    fs.writeFileSync(filePath, 'test content')

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: {},
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { output: 'test output' },
    }

    const postResult = postReadHandler(postEvent)
    expect(postResult.hookType).toBe('pass')
  })

  it('emits a context hint when a sibling session recently read the same file', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'shared.txt')
    fs.writeFileSync(filePath, 'shared content')

    const project = makeProjectAt(repoDir)
    writeSessionManifest(project.hash, 'sibling-session-id', {
      files: [{ rel_path: 'shared.txt', hit_count: 1 }],
    })

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('context')
    expect(String(result.context ?? '')).toMatch(/already been read by another agent/)
  })

  it('ignores a sibling manifest entry with hit_count 0', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'untouched.txt')
    fs.writeFileSync(filePath, 'content')

    const project = makeProjectAt(repoDir)
    writeSessionManifest(project.hash, 'sibling-session-id', {
      files: [{ rel_path: 'untouched.txt', hit_count: 0 }],
    })

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('ignores a sibling manifest older than the TTL', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS = '60'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'stale.txt')
    fs.writeFileSync(filePath, 'content')

    const project = makeProjectAt(repoDir)
    writeSessionManifest(project.hash, 'sibling-session-id', {
      files: [{ rel_path: 'stale.txt', hit_count: 1 }],
    })
    const manifestPath = path.join(dataDir(), 'projects', project.hash, 'sessions', 'sibling-session-id.json')
    const oldTime = new Date(Date.now() - 3600 * 1000)
    fs.utimesSync(manifestPath, oldTime, oldTime)

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')

    delete process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP_TTL_SECS
  })

  it('skips a corrupt sibling manifest without crashing', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'corrupt.txt')
    fs.writeFileSync(filePath, 'content')

    const project = makeProjectAt(repoDir)
    const sessionsDir = path.join(dataDir(), 'projects', project.hash, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, 'corrupt-sibling.json'), '{ not valid json')

    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('postReadHandler writes a manifest that a sibling session can discover', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'roundtrip.txt')
    fs.writeFileSync(filePath, 'content')

    const preEvent: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir },
    }
    preReadHandler(preEvent)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      raw: { cwd: repoDir, output: 'content' },
    }
    postReadHandler(postEvent)

    const project = makeProjectAt(repoDir)
    const manifestPath = path.join(dataDir(), 'projects', project.hash, 'sessions', getSessionId() + '.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(written.files.some((f: { rel_path: string }) => f.rel_path === 'roundtrip.txt')).toBe(true)
  })
})
