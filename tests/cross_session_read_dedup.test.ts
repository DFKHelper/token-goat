import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { preReadHandler, postReadHandler } from '../src/hooks_read'
import type { HookEvent } from '../src/hook_registry'
import { loadConfig } from '../src/config'
import { getSessionId } from '../src/session'
import os from 'node:os'

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
})
