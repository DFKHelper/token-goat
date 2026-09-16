import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { preReadHandler, postReadHandler, relPathWithinRoot } from '../src/hooks_read.js'
import type { HookEvent } from '../src/hook_registry.js'
import { loadConfig } from '../src/config.js'
import { getSessionId } from '../src/session.js'
import { makeProjectAt } from '../src/project.js'
import { readAllSessionManifests, writeSessionManifest } from '../src/compact.js'
import { dataDir } from '../src/constants.js'
import { expectHookType } from './helpers/hook-output.js'
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
      agentId: undefined,
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      agentId: undefined,
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
      agentId: undefined,
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
      agentId: undefined,
      raw: {},
    }

    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      agentId: undefined,
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
      agentId: undefined,
      raw: { cwd: repoDir },
    }

    const result = preReadHandler(event)
    expectHookType(result, 'context')
    expect(result.context).toMatch(/already been read by another agent/)
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
      agentId: undefined,
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
      agentId: undefined,
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
      agentId: undefined,
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
      agentId: undefined,
      raw: { cwd: repoDir },
    }
    preReadHandler(preEvent)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: getSessionId(),
      agentId: undefined,
      raw: { cwd: repoDir, output: 'content' },
    }
    postReadHandler(postEvent)

    const project = makeProjectAt(repoDir)
    const manifestPath = path.join(dataDir(), 'projects', project.hash, 'sessions', getSessionId() + '.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(written.files.some((f: { rel_path: string }) => f.rel_path === 'roundtrip.txt')).toBe(true)
  })

  // Every other test in this file builds its event with `sessionId: getSessionId()`, which makes the event's id and the process-memoized singleton identical by construction -- so none of them can tell which of the two the write path actually reads. These two supply an id that diverges, which is the real shape: the bridges in src/bridges/ serve more than one session from one cached process, and getSessionId() memoizes the first one it sees.
  it('names the manifest after the session on the event, not the process-memoized session id', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'divergent.txt')
    fs.writeFileSync(filePath, 'content')
    const project = makeProjectAt(repoDir)

    const wireSessionId = 'wire-session-not-the-process-one'
    expect(wireSessionId).not.toBe(getSessionId())

    postReadHandler({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: wireSessionId,
      agentId: undefined,
      raw: { cwd: repoDir, output: 'content' },
    })

    const sessionsDir = path.join(dataDir(), 'projects', project.hash, 'sessions')
    const written = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []
    expect(written).toContain(`${wireSessionId}.json`)
    // The failure this replaces: the second session's reads landed in the first session's manifest, overwriting it, so the first session's reads stopped being discoverable by anyone.
    expect(written).not.toContain(`${getSessionId()}.json`)
  })

  it('gives a subagent a manifest of its own rather than overwriting the parent one', () => {
    process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'

    const repoDir = makeRepo()
    const filePath = path.join(repoDir, 'subagent.txt')
    fs.writeFileSync(filePath, 'content')
    const project = makeProjectAt(repoDir)

    const parentId = 'parent-session-id'
    const base = {
      eventName: 'post_tool_use' as const,
      toolName: 'Read',
      toolInput: { file_path: filePath },
      sessionId: parentId,
      raw: { cwd: repoDir, output: 'content' },
    }
    postReadHandler({ ...base, agentId: undefined })
    postReadHandler({ ...base, agentId: 'agent-42' })

    const sessionsDir = path.join(dataDir(), 'projects', project.hash, 'sessions')
    const written = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []
    // All subagents of one parent share the parent's session_id on the wire, so keying the manifest on that alone let each subagent overwrite the file with only its own reads. sessionStateKey salts with agentId, which is the same key relay.ts persists the exported state blob under.
    expect(written).toContain(`${parentId}.json`)
    expect(written.some((f) => f.startsWith(`${parentId}_agent_`))).toBe(true)
  })

  it('keeps two subagents of a long-session-id parent on separate manifests', () => {
    const repoDir = makeRepo()
    const project = makeProjectAt(repoDir)
    // 60 characters: past the point where a plain slice(0, 64) of `<sessionId>:agent:<agentId>` cuts into the `_agent_` marker itself, so every subagent of this parent used to land on one filename. Session ids come off the wire from whatever harness is driving, and CLAUDE_CODE_SESSION_ID is a plain env var a wrapper can set to any descriptive string.
    const longId = 'a'.repeat(60)
    writeSessionManifest(project.hash, `${longId}:agent:agent-one`, { files: [{ rel_path: 'one.txt', hit_count: 1 }] })
    writeSessionManifest(project.hash, `${longId}:agent:agent-two`, { files: [{ rel_path: 'two.txt', hit_count: 1 }] })

    const sessionsDir = path.join(dataDir(), 'projects', project.hash, 'sessions')
    const written = fs.readdirSync(sessionsDir)
    expect(written).toHaveLength(2)
    const payloads = written.map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')))
    expect(payloads.map((p) => p.files[0].rel_path).sort()).toEqual(['one.txt', 'two.txt'])
  })

  it('sanitizes a session id with path-traversal characters instead of escaping the sessions dir', () => {
    const repoDir = makeRepo()
    const project = makeProjectAt(repoDir)
    const maliciousId = '../../evil'

    writeSessionManifest(project.hash, maliciousId, { files: [] })

    const projectsRoot = path.join(dataDir(), 'projects')
    const sessionsDir = path.join(projectsRoot, project.hash, 'sessions')
    const escapedTarget = path.join(projectsRoot, 'evil.json')

    expect(fs.existsSync(escapedTarget)).toBe(false)

    const written = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []
    for (const file of written) {
      expect(path.dirname(path.join(sessionsDir, file))).toBe(sessionsDir)
    }
  })

  it('still writes and round-trips a normal well-formed session id (UUID) exactly as before', () => {
    const repoDir = makeRepo()
    const project = makeProjectAt(repoDir)
    const uuid = '123e4567-e89b-12d3-a456-426614174000'

    writeSessionManifest(project.hash, uuid, { files: [{ rel_path: 'a.txt', hit_count: 2 }] })

    const manifestPath = path.join(dataDir(), 'projects', project.hash, 'sessions', `${uuid}.json`)
    expect(fs.existsSync(manifestPath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(written).toEqual({ files: [{ rel_path: 'a.txt', hit_count: 2 }] })
  })

  it('deletes an expired manifest file as opportunistic cleanup, but keeps a fresh sibling', () => {
    const repoDir = makeRepo()
    const project = makeProjectAt(repoDir)

    writeSessionManifest(project.hash, 'stale-session', { files: [{ rel_path: 'a.txt', hit_count: 1 }] })
    writeSessionManifest(project.hash, 'fresh-session', { files: [{ rel_path: 'b.txt', hit_count: 1 }] })

    const sessionsDir = path.join(dataDir(), 'projects', project.hash, 'sessions')
    const staleManifestPath = path.join(sessionsDir, 'stale-session.json')
    const freshManifestPath = path.join(sessionsDir, 'fresh-session.json')
    const oldTime = new Date(Date.now() - 3600 * 1000)
    fs.utimesSync(staleManifestPath, oldTime, oldTime)

    const results = readAllSessionManifests(project.hash, 60)

    expect(fs.existsSync(staleManifestPath)).toBe(false)
    expect(fs.existsSync(freshManifestPath)).toBe(true)
    expect(results).toEqual([{ files: [{ rel_path: 'b.txt', hit_count: 1 }] }])
  })

  describe('relPathWithinRoot', () => {
    it('rejects a same-drive sibling path outside root', () => {
      expect(relPathWithinRoot(path.join(os.tmpdir(), 'root'), path.join(os.tmpdir(), 'sibling', 'x.txt'))).toBeNull()
    })

    it('accepts a genuine descendant of root', () => {
      const root = path.join(os.tmpdir(), 'root')
      expect(relPathWithinRoot(root, path.join(root, 'sub', 'x.txt'))).toBe('sub/x.txt')
    })

    // Regression: path.relative(root, target) returns target's OWN ABSOLUTE PATH unchanged
    // (not a '..'-prefixed relative path) when root and target are on different Windows drive
    // letters -- documented Node behavior, not a bug in path.relative itself. The previous guard
    // here was a bare `!rel.startsWith('..')`, which that absolute-path result trivially passes,
    // so a file on an unrelated drive was silently treated as "inside" the project and its
    // absolute path leaked into the project's cross-session read-dedup manifest instead of being
    // excluded like any other out-of-project file.
    it.skipIf(process.platform !== 'win32')('rejects a cross-drive path on Windows instead of treating it as in-root', () => {
      expect(relPathWithinRoot('D:\\some\\project', 'C:\\Users\\someone\\secret.env')).toBeNull()
    })
  })

  describe('cross-session case-fold (case-insensitive FS)', () => {
    const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    afterEach(() => {
      if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
    })

    // Regression: scanCrossSessionManifests (hooks_read.ts) compared rel_path with raw ===
    // instead of foldPath(). rel_path is stored case-preserved by writeSessionManifest, so a
    // sibling session that read the same physical file under a different literal casing (e.g.
    // "Shared.TXT" vs "shared.txt") on a case-insensitive filesystem never matched, and the
    // cross-session-read-dedup hint silently failed to fire.
    it('emits a context hint when a sibling session read the same file under different letter-casing', () => {
      process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'

      const repoDir = makeRepo()
      const filePath = path.join(repoDir, 'shared.txt')
      fs.writeFileSync(filePath, 'shared content')

      const project = makeProjectAt(repoDir)
      writeSessionManifest(project.hash, 'sibling-session-id', {
        files: [{ rel_path: 'Shared.TXT', hit_count: 1 }],
      })

      const event: HookEvent = {
        eventName: 'pre_tool_use',
        toolName: 'Read',
        toolInput: { file_path: filePath },
        sessionId: getSessionId(),
        agentId: undefined,
        raw: { cwd: repoDir },
      }

      const result = preReadHandler(event)
      expectHookType(result, 'context')
      expect(result.context).toMatch(/already been read by another agent/)
    })

    it('control: case-sensitive FS mode does not match a case-only rel_path variant', () => {
      process.env.TOKEN_GOAT_CROSS_SESSION_READ_DEDUP = '1'
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'

      const repoDir = makeRepo()
      const filePath = path.join(repoDir, 'shared.txt')
      fs.writeFileSync(filePath, 'shared content')

      const project = makeProjectAt(repoDir)
      writeSessionManifest(project.hash, 'sibling-session-id', {
        files: [{ rel_path: 'Shared.TXT', hit_count: 1 }],
      })

      const event: HookEvent = {
        eventName: 'pre_tool_use',
        toolName: 'Read',
        toolInput: { file_path: filePath },
        sessionId: getSessionId(),
        agentId: undefined,
        raw: { cwd: repoDir },
      }

      const result = preReadHandler(event)
      expect(result.hookType).toBe('pass')
    })
  })
})
