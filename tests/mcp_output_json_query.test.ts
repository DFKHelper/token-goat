import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  compressAtlassianMcpResult,
  compressMcpResultWithPacks,
} from '../src/mcp_compress_packs.js'
import { storeMcpOutput } from '../src/mcp_cache.js'
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { unfence } from './helpers/unfence.js'
import { handleJson } from '../src/hints/file_type_handler.js'

const BUNDLE = path.join(__dirname, '..', 'dist', 'token-goat.mjs')

function runCli(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: tmpHome },
  })
  return {
    status: res.status ?? 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

let tmpHome: string
let prevHome: string | undefined
let tmpDir: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-home-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-test-'))
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // cleanup
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // cleanup
  }
})

// Realistic Jira search response fixture with heavy avatar and self URL boilerplate
function jiraSearchFixture(count = 10) {
  const issues = Array.from({ length: count }, (_, i) => ({
    expand: 'operations,versionedRepresentations,editmeta,changelog,renderedFields',
    id: `1000${i}`,
    self: `https://jira.example.com/rest/api/2/issue/1000${i}`,
    key: `PROJ-${100 + i}`,
    fields: {
      summary: `Issue number ${i} for migration`,
      description: `Detailed description for issue ${i} with reproduction steps.`,
      status: {
        self: `https://jira.example.com/rest/api/2/status/1`,
        description: 'Open status',
        iconUrl: 'https://jira.example.com/images/icons/statuses/open.png',
        name: 'Open',
        id: '1',
        statusCategory: {
          self: 'https://jira.example.com/rest/api/2/statuscategory/2',
          id: 2,
          key: 'new',
          name: 'To Do',
        },
      },
      priority: {
        self: 'https://jira.example.com/rest/api/2/priority/3',
        iconUrl: 'https://jira.example.com/images/icons/priorities/medium.svg',
        name: 'Medium',
        id: '3',
      },
      issuetype: {
        self: 'https://jira.example.com/rest/api/2/issuetype/10001',
        id: '10001',
        description: 'A task that needs to be done.',
        iconUrl: 'https://jira.example.com/images/icons/issuetypes/task.svg',
        name: 'Task',
        avatarId: 10318,
      },
      reporter: {
        self: 'https://jira.example.com/rest/api/2/user?username=dev1',
        name: 'dev1',
        emailAddress: 'dev1@example.com',
        avatarUrls: {
          '48x48': 'https://jira.example.com/secure/useravatar?size=large&ownerId=dev1',
          '24x24': 'https://jira.example.com/secure/useravatar?size=small&ownerId=dev1',
          '16x16': 'https://jira.example.com/secure/useravatar?size=xsmall&ownerId=dev1',
          '32x32': 'https://jira.example.com/secure/useravatar?size=medium&ownerId=dev1',
        },
        displayName: 'Developer One',
        timeZone: 'America/New_York',
      },
      assignee: {
        self: 'https://jira.example.com/rest/api/2/user?username=dev2',
        name: 'dev2',
        emailAddress: 'dev2@example.com',
        avatarUrls: {
          '48x48': 'https://jira.example.com/secure/useravatar?size=large&ownerId=dev2',
          '24x24': 'https://jira.example.com/secure/useravatar?size=small&ownerId=dev2',
          '16x16': 'https://jira.example.com/secure/useravatar?size=xsmall&ownerId=dev2',
          '32x32': 'https://jira.example.com/secure/useravatar?size=medium&ownerId=dev2',
        },
        displayName: 'Developer Two',
        timeZone: 'America/New_York',
      },
    },
  }))

  return {
    expand: 'schema,names',
    startAt: 0,
    maxResults: count,
    total: 150,
    issues,
  }
}

describe('Atlassian MCP compression pack', () => {
  it('returns null for non-Atlassian tool names', () => {
    const raw = JSON.stringify(jiraSearchFixture(5))
    expect(compressAtlassianMcpResult('mcp__github__search_repositories', raw)).toBeNull()
  })

  it('returns null for unparseable JSON', () => {
    expect(compressAtlassianMcpResult('mcp__atlassian_mcp_jira_search', 'not valid json')).toBeNull()
  })

  it('strips avatarUrls, iconUrl, self, expand, and timeZone from Jira search results', () => {
    const fixture = jiraSearchFixture(10)
    const raw = JSON.stringify(fixture)
    const compressed = compressAtlassianMcpResult('mcp__atlassian_mcp_jira_search', raw)

    expect(compressed).not.toBeNull()
    if (compressed === null) return

    // Redundant boilerplate is stripped
    expect(compressed).not.toContain('avatarUrls')
    expect(compressed).not.toContain('timeZone')
    expect(compressed).not.toContain('https://jira.example.com/rest/api/2/issue')

    // Essential data is preserved
    expect(compressed).toContain('PROJ-100')
    expect(compressed).toContain('PROJ-109')
    expect(compressed).toContain('Developer One')
    expect(compressed).toContain('Issue number 0 for migration')

    // Sizable byte reduction achieved (> 50%)
    expect(compressed.length).toBeLessThan(raw.length * 0.5)
  })

  it('is invoked via compressMcpResultWithPacks', () => {
    const fixture = jiraSearchFixture(5)
    const raw = JSON.stringify(fixture)
    const compressed = compressMcpResultWithPacks('mcp__atlassian_mcp_jira_search', raw)

    expect(compressed).not.toBeNull()
    expect(compressed).not.toContain('avatarUrls')
    expect(compressed).toContain('PROJ-100')
  })
})

describe('mcp-output --json-query and --file CLI command', () => {
  it('slices cached MCP JSON with --json-query', () => {
    const fixture = jiraSearchFixture(5)
    const raw = JSON.stringify(fixture)
    const id = storeMcpOutput('test-session', 'mcp__jira__search', { jql: 'project=PROJ' }, raw)
    expect(id).not.toBeNull()
    if (!id) return

    const { status, stdout } = runCli(['mcp-output', id, '--json-query', 'issues[*].key'])
    expect(status).toBe(0)
    expect(stdout).toContain('PROJ-100')
    expect(stdout).toContain('PROJ-104')
  })

  it('caps fanned results with --head and discloses elision', () => {
    const fixture = jiraSearchFixture(8)
    const raw = JSON.stringify(fixture)
    const id = storeMcpOutput('test-session', 'mcp__jira__search', { jql: 'project=PROJ' }, raw)
    expect(id).not.toBeNull()
    if (!id) return

    const { status, stdout } = runCli(['mcp-output', id, '--json-query', 'issues[*].key', '--head', '2'])
    expect(status).toBe(0)
    expect(stdout).toContain('PROJ-100')
    expect(stdout).toContain('PROJ-101')
    expect(stdout).not.toContain('PROJ-103')
    expect(stdout).toContain('(6 more items elided; use --head to see more)')
  })

  it('outputs structured envelope when --json is passed with --json-query', () => {
    const fixture = jiraSearchFixture(6)
    const raw = JSON.stringify(fixture)
    const id = storeMcpOutput('test-session', 'mcp__jira__search', { jql: 'project=PROJ' }, raw)
    expect(id).not.toBeNull()
    if (!id) return

    const { status, stdout } = runCli(['mcp-output', id, '--json-query', 'issues[*].key', '--head', '3', '--json'])
    expect(status).toBe(0)
    const unfenced = unfence(stdout).trim()
    const parsed = JSON.parse(unfenced)
    expect(parsed.totalCount).toBe(6)
    expect(parsed.truncated).toBe(true)
    expect(parsed.items).toEqual(['PROJ-100', 'PROJ-101', 'PROJ-102'])
  })

  it('extracts non-fanned single value', () => {
    const fixture = jiraSearchFixture(5)
    const raw = JSON.stringify(fixture)
    const id = storeMcpOutput('test-session', 'mcp__jira__search', { jql: 'project=PROJ' }, raw)
    expect(id).not.toBeNull()
    if (!id) return

    const { status, stdout } = runCli(['mcp-output', id, '--json-query', 'total'])
    expect(status).toBe(0)
    expect(stdout.trim()).toContain('150')
  })

  it('queries an on-disk tool spill file via --file', () => {
    const fixture = jiraSearchFixture(4)
    const spillPath = path.join(tmpDir, 'content.json')
    fs.writeFileSync(spillPath, JSON.stringify(fixture), 'utf-8')

    const { status, stdout } = runCli(['mcp-output', '--file', spillPath, '--json-query', 'issues[*].key'])
    expect(status).toBe(0)
    expect(stdout).toContain('PROJ-100')
    expect(stdout).toContain('PROJ-103')
  })

  it('fails with clear error if --file does not exist', () => {
    const fakePath = path.join(tmpDir, 'nonexistent.json')
    const { status, stderr } = runCli(['mcp-output', '--file', fakePath, '--json-query', 'key'])
    expect(status).not.toBe(0)
    expect(stderr).toContain('file not found')
  })

  it('fails if neither id nor --file is supplied', () => {
    const { status, stderr } = runCli(['mcp-output'])
    expect(status).not.toBe(0)
    expect(stderr).toContain('provide an mcp-output <id> or --file <path>')
  })
})

describe('oversized MCP result recovery', () => {
  it('caches oversized results and emits recovery header with suggested commands', async () => {
    // Large raw MCP result that exceeds 25KB
    const largeObj = {
      description: 'A very large text payload that is not easily compressible',
      data: 'x'.repeat(30_000),
    }
    const rawResult = JSON.stringify(largeObj)

    const event = buildEvent('post_tool_use', {
      tool_name: 'mcp__custom__query_large',
      tool_input: { query: 'test' },
      tool_response: rawResult,
      session_id: 'session-oversized-test',
    })

    const output = await runHook(event)
    expect(output).not.toBeNull()
    if (!output) return

    expect(output.hookType).toBe('rewriteOutput')
    if (output.hookType !== 'rewriteOutput') return
    const content = output.updatedOutput ?? ''
    expect(content).toContain('[token-goat: oversized MCP result')
    expect(content).toContain('cached as mcp_')
    expect(content).toContain('--json-query')
    expect(content).toContain('--section')
    expect(content).toContain('--grep')
    expect(content).toContain('preview truncated by token-goat')
  })
})

describe('spilled JSON file read intercepts', () => {
  it('handleJson flags content.json as oversized tool output spill', () => {
    const bigJson = JSON.stringify({
      issues: Array.from({ length: 300 }, (_, i) => ({ id: i, key: `KEY-${i}`, pad: 'a'.repeat(80) })),
    })
    const res = handleJson('/tmp/sandbox/content.json', bigJson)
    expect(res.shouldBlock).toBe(true)
    expect(res.message).toContain('oversized tool output spill')
    expect(res.message).toContain('Do not read it whole with Read/read_file')
    expect(res.message).toContain('json-query')
    expect(res.message).toContain('Slice spill: token-goat mcp-output --file')
  })

  it('denies re-read of content.json with surgical guidance', async () => {
    const spillFile = path.join(tmpDir, 'content.json')
    fs.writeFileSync(spillFile, JSON.stringify({ a: 1 }), 'utf-8')

    const event = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: spillFile },
      session_id: 'session-spill-test',
    })

    // First read
    await runHook(event)

    // Second read: should be denied
    const second = await runHook(event)
    expect(second.hookType).toBe('deny')
    if (second.hookType !== 'deny') return
    expect(second.message).toContain('already read this session')
    expect(second.message).toContain('json-query')
    expect(second.message).toContain('mcp-output --file')
  })
})
