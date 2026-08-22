import { afterEach, describe, expect, it, vi } from 'vitest'

// Regression test for Fix 3: cli.ts must not eagerly import mcp_server.ts (and
// therefore the whole MCP protocol layer and zod) at module load time. Only the
// `mcp-serve` command handler may reach for it, lazily.
//
// We mock both modules to throw on import. If cli.ts (or any command other than
// mcp-serve) still statically/eagerly imports them, importing '../src/cli.js'
// itself -- or running any non-mcp-serve command -- would throw. If the
// mcp-serve command is invoked, it should hit the lazy import, catch the
// simulated failure, and degrade with a clear message instead of crashing.
//
// The message no longer names a package to install: the MCP server used to be
// @modelcontextprotocol/sdk, an optionalDependency that could genuinely be
// absent, and is now token-goat's own code bundled into the artifact. A load
// failure here means a broken install, not a missing one, so the assertion below
// pins the message that is actually true.
vi.mock('../src/mcp_server.js', () => {
  throw new Error('simulated: MCP server modules unloadable')
})
vi.mock('../src/mcp_stdio.js', () => {
  throw new Error('simulated: MCP server modules unloadable')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp-serve lazy load', () => {
  it('loading cli.js does not eagerly touch mcp_server.js / the protocol layer', async () => {
    // If this import throws, cli.ts still has an eager top-level import of the
    // mocked (throwing) modules.
    await expect(import('../src/cli.js')).resolves.toBeTruthy()
  })

  it('a non-mcp-serve command runs fine even though the MCP modules are unloadable', async () => {
    const { run } = await import('../src/cli.js')
    await expect(run(['node', 'token-goat', 'map', '--compact'])).resolves.not.toThrow()
  })

  it('mcp-serve degrades with a clear message instead of crashing when the modules are unloadable', async () => {
    const { run } = await import('../src/cli.js')
    const chunks: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk))
      return realWrite(chunk as never, ...(rest as []))
    }) as typeof process.stderr.write
    try {
      await run(['node', 'token-goat', 'mcp-serve'])
    } finally {
      process.stderr.write = realWrite
    }
    const written = chunks.join('')
    expect(written).toMatch(/mcp-server unavailable \(could not load the MCP server modules\)/i)
    // The old message told the reader to install a package. Nothing to install exists any more, so a regression back to that wording is a wrong instruction, not just stale text.
    expect(written).not.toMatch(/install @modelcontextprotocol/i)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
