// getStandardAuxiliaryRoots in src/mcp_server.ts is the single point enforcing root policy for all
// 17 MCP tools: assertRootAllowed consults it when a caller-supplied projectRoot is outside every
// entry in mcp.allowed_roots, so the skills tree and the Claude Code transcript tree stay readable
// for cross-workspace inspections. It hardcoded `<home>/.claude/skills` and `<home>/.claude/projects`,
// which is not where Claude Code keeps either one for a user who sets CLAUDE_CONFIG_DIR -- so the
// allowlist named a tree the product no longer writes, and the MCP tools refused the only copy that
// exists. They now hang off claudeConfigDir().
//
// Fixture provenance: HAND-DERIVED. The directory layout under the config home (`skills`, `projects`)
// and the precedence rule (CLAUDE_CONFIG_DIR outranks homedir()) are taken from claudeConfigDir's
// contract in src/claude_config_dir.ts, whose own docstring cites the shipping @anthropic-ai/claude-code
// binary as `process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`; the paths and the
// allowed/refused verdicts below are composed from that rule independently of the code under test.
// The refusal substring `mcp.allowed_roots` is the wording assertRootAllowed throws and is the same
// anchor the sibling tests/mcp_server_allowed_roots.test.ts asserts on.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('mcp auxiliary roots honour CLAUDE_CONFIG_DIR', () => {
  let allowedRoot: string
  let relocatedConfigHome: string
  let cleanup: (() => Promise<void>) | undefined
  const savedEnv: Record<string, string | undefined> = {}

  // `map` is one of the path-less tools the allowlist docstring names: it resolves the caller-supplied
  // root and reads no individual file, so the verdict here is the root allowlist's alone.
  async function mapVerdict(projectRoot: string): Promise<string> {
    const { client, close } = await connectedClient()
    cleanup = close
    const result = await client.callTool({ name: 'map', arguments: { projectRoot } })
    return textOf(result)
  }

  function makeProject(dir: string): string {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
    return dir
  }

  beforeEach(() => {
    for (const k of ['TOKEN_GOAT_MCP_ALLOWED_ROOTS', 'CLAUDE_CONFIG_DIR']) savedEnv[k] = process.env[k]
    allowedRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auxcfg-allowed-')))
    relocatedConfigHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auxcfg-home-')))
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = allowedRoot
    invalidateConfigCache()
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    invalidateConfigCache()
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const d of [allowedRoot, relocatedConfigHome]) fs.rmSync(d, { recursive: true, force: true })
  })

  it.each(['skills', 'projects'])(
    'admits the relocated config home\'s %s tree when CLAUDE_CONFIG_DIR is set',
    async (child) => {
      process.env['CLAUDE_CONFIG_DIR'] = relocatedConfigHome
      const target = makeProject(path.join(relocatedConfigHome, child, 'a-workspace'))
      const text = await mapVerdict(target)
      expect(
        text,
        `the MCP allowlist refused <CLAUDE_CONFIG_DIR>/${child}, which is where Claude Code keeps it`,
      ).not.toContain('mcp.allowed_roots')
    },
  )

  // Calibration: with the variable unset the old home-relative pair must still be admitted, or the
  // fix traded one dead allowlist for another.
  it.each(['skills', 'projects'])(
    'still admits <home>/.claude/%s when CLAUDE_CONFIG_DIR is unset',
    async (child) => {
      delete process.env['CLAUDE_CONFIG_DIR']
      const target = makeProject(path.join(os.homedir(), '.claude', child, 'a-workspace'))
      try {
        const text = await mapVerdict(target)
        expect(text).not.toContain('mcp.allowed_roots')
      } finally {
        fs.rmSync(path.join(os.homedir(), '.claude', child, 'a-workspace'), { recursive: true, force: true })
      }
    },
  )

  // The bound that separates this widening from a drive-wide read grant: the entries are the named
  // CHILDREN of the config home, never the config home itself. `CLAUDE_CONFIG_DIR=C:/` must grant
  // C:/skills and C:/projects, not the whole drive.
  it('refuses the config home itself, admitting only its named children', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = relocatedConfigHome
    makeProject(path.join(relocatedConfigHome, 'skills', 'a-workspace'))
    const text = await mapVerdict(relocatedConfigHome)
    expect(text, 'the whole config home was admitted, not just skills/ and projects/').toContain('mcp.allowed_roots')
  })

  it('refuses a sibling directory under the config home that is neither skills nor projects', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = relocatedConfigHome
    const target = makeProject(path.join(relocatedConfigHome, 'plugins', 'a-workspace'))
    const text = await mapVerdict(target)
    expect(text).toContain('mcp.allowed_roots')
  })

  // The replacement half of the policy: with the variable pointed elsewhere, the home-relative tree
  // is no longer an allowlist entry, because Claude Code does not use it then either.
  it('no longer admits <home>/.claude/projects once CLAUDE_CONFIG_DIR points elsewhere', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = relocatedConfigHome
    const target = makeProject(path.join(os.homedir(), '.claude', 'projects', 'a-workspace'))
    try {
      const text = await mapVerdict(target)
      expect(text).toContain('mcp.allowed_roots')
    } finally {
      fs.rmSync(path.join(os.homedir(), '.claude', 'projects', 'a-workspace'), { recursive: true, force: true })
    }
  })
})
