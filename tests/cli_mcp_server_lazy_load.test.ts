import { afterEach, describe, expect, it, vi } from 'vitest'

// Regression test for Fix 3: cli.ts must not eagerly import mcp_server.ts (and
// therefore @modelcontextprotocol/sdk, 17 transitive deps) at module load time.
// Only the `mcp-serve` command handler may reach for it, lazily.
//
// We mock both modules to throw on import. If cli.ts (or any command other than
// mcp-serve) still statically/eagerly imports them, importing '../src/cli.js'
// itself -- or running any non-mcp-serve command -- would throw. If the
// mcp-serve command is invoked, it should hit the lazy import, catch the
// simulated failure, and degrade with a clear message instead of crashing.
vi.mock('../src/mcp_server.js', () => {
  throw new Error('simulated: @modelcontextprotocol/sdk not installed')
})
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  throw new Error('simulated: @modelcontextprotocol/sdk not installed')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp-serve lazy load', () => {
  it('loading cli.js does not eagerly touch mcp_server.js / the SDK', async () => {
    // If this import throws, cli.ts still has an eager top-level import of the
    // mocked (throwing) modules.
    await expect(import('../src/cli.js')).resolves.toBeTruthy()
  })

  it('a non-mcp-serve command runs fine even though the SDK modules are unloadable', async () => {
    const { run } = await import('../src/cli.js')
    await expect(run(['node', 'token-goat', 'map', '--compact'])).resolves.not.toThrow()
  })

  it('mcp-serve degrades with a clear message instead of crashing when the SDK is unavailable', async () => {
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
    expect(written).toMatch(/install @modelcontextprotocol\/sdk/i)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
