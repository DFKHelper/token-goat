import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureDecoderSetup,
  fencePayload,
  registerMcpDecoderProvider,
  resetDecoderCheckedForTests,
  resetMcpProviderRegisteredForTests,
} from '../src/extension'

// 'vscode' only exists inside a real extension host, so it is faked wholesale here the same way
// decoder_setup.test.ts does. McpStdioServerDefinition is modelled as a plain class recording the
// positional constructor arguments the real one takes (label, command, args, env, version) -- the
// point of these cases is which argv the definition carries, not what VS Code does with it.
interface StdioDefinitionShape {
  readonly label: string
  readonly command: string
  readonly args: string[]
  readonly env?: Record<string, string | number | null>
}

interface ProviderShape {
  provideMcpServerDefinitions: (token: unknown) => Promise<StdioDefinitionShape[]>
}

// The class is declared inside the factory rather than above it: vi.hoisted runs before any
// top-level declaration in this file, so referencing an outer class here throws at import time.
const { showWarningMessage, registerMcpServerDefinitionProvider, StdioDefinition } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  // Typed explicitly: an inferred `vi.fn(() => ...)` records calls as a zero-length tuple, so
  // reading `.mock.calls[0][1]` below fails typecheck:tests even though the runtime value is there.
  registerMcpServerDefinitionProvider: vi.fn<(id: string, provider: ProviderShape) => { dispose: () => void }>(
    () => ({ dispose: (): void => {} }),
  ),
  StdioDefinition: class {
    constructor(
      public readonly label: string,
      public readonly command: string,
      public readonly args: string[],
      public readonly env?: Record<string, string | number | null>,
    ) {}
  },
}))

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined, isTrusted: true },
  window: { showWarningMessage, showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
  lm: { registerMcpServerDefinitionProvider },
  McpStdioServerDefinition: StdioDefinition,
}))

const { runTokenGoat, resolveTokenGoatEntrypoint } = vi.hoisted(() => ({
  runTokenGoat: vi.fn(),
  resolveTokenGoatEntrypoint: vi.fn(),
}))

vi.mock('../src/launcher', () => ({
  runTokenGoat,
  resolveTokenGoatEntrypoint,
  assertSafeArgSegment: vi.fn(),
  runGitDiff: vi.fn(),
}))

function fakeContext(): { subscriptions: Array<{ dispose: () => void }> } {
  return { subscriptions: [] }
}

beforeEach(() => {
  resetDecoderCheckedForTests()
  resetMcpProviderRegisteredForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('registerMcpDecoderProvider', () => {
  it('registers under the id declared in the manifest contribution point', () => {
    registerMcpDecoderProvider(fakeContext() as never)
    // VS Code matches the runtime id against contributes.mcpServerDefinitionProviders[].id;
    // a mismatch silently provides nothing, with no error anywhere.
    expect(registerMcpServerDefinitionProvider.mock.calls[0]?.[0]).toBe('token-goat')
  })

  it('registers under an id the manifest actually declares', () => {
    // The runtime id and the manifest id are coupled across two files with no compiler link
    // between them, and a mismatch fails silently -- VS Code just provides no server, with no
    // error in either place. Asserting the runtime id alone leaves the manifest free to drift.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { contributes?: { mcpServerDefinitionProviders?: Array<{ id: string }> } }
    const declared = (manifest.contributes?.mcpServerDefinitionProviders ?? []).map((p) => p.id)

    registerMcpDecoderProvider(fakeContext() as never)
    const runtimeId = registerMcpServerDefinitionProvider.mock.calls[0]?.[0]

    expect(declared, 'package.json declares no mcpServerDefinitionProviders, so nothing is contributed however the code registers itself').not.toEqual([])
    expect(declared).toContain(runtimeId)
  })

  it('launches the resolved JS entrypoint with mcp-serve via the editor Node, not a shell or a .cmd shim', async () => {
    resolveTokenGoatEntrypoint.mockResolvedValue('C:\\npm\\node_modules\\token-goat\\dist\\token-goat.mjs')
    registerMcpDecoderProvider(fakeContext() as never)

    const provider = registerMcpServerDefinitionProvider.mock.calls[0]?.[1]
    const definitions = await provider!.provideMcpServerDefinitions(undefined)

    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.command).toBe(process.execPath)
    expect(definitions[0]?.args).toEqual(['C:\\npm\\node_modules\\token-goat\\dist\\token-goat.mjs', 'mcp-serve'])
  })

  it('runs the Electron binary as plain Node, or the command relaunches the editor instead', async () => {
    // In an extension host process.execPath is the Electron binary VS Code itself runs as, so
    // without ELECTRON_RUN_AS_NODE the definition above starts a second editor window rather than
    // the CLI, and the decoder never comes up at all. launcher.ts sets it for the same reason.
    registerMcpDecoderProvider(fakeContext() as never)
    const provider = registerMcpServerDefinitionProvider.mock.calls[0]?.[1]
    const definitions = await provider!.provideMcpServerDefinitions(undefined)
    expect(definitions[0]?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('disposes with the extension rather than leaking the registration', () => {
    const context = fakeContext()
    registerMcpDecoderProvider(context as never)
    expect(context.subscriptions).toHaveLength(1)
  })
})

describe('ensureDecoderSetup with the provider registered', () => {
  it('does not shell out to mcp-status or prompt, because the decoder now exists by construction', async () => {
    registerMcpDecoderProvider(fakeContext() as never)
    await expect(ensureDecoderSetup()).resolves.toBe(true)
    // Pre-change this always ran mcp-status and, on a machine with no mcp.json, told the user to
    // run `install --vscode` and reload -- setup work the provider makes unnecessary.
    expect(runTokenGoat).not.toHaveBeenCalled()
    expect(showWarningMessage).not.toHaveBeenCalled()
  })

  it('still falls back to the mcp-status check when the provider was never registered', async () => {
    // Guards against the skip above being unconditional: without registration the original path
    // must survive intact, so this file cannot pass by having disabled the check outright.
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: true, checkedPaths: [] }))
    await expect(ensureDecoderSetup()).resolves.toBe(true)
    expect(runTokenGoat).toHaveBeenCalledWith(['mcp-status', '--vscode'], undefined)
  })
})

describe('fencePayload', () => {
  it('delimits the payload so it does not run into the surrounding prose', () => {
    expect(fencePayload('compact_bytes: 12\nrecovery: token-goat retrieve abc')).toBe(
      '```\ncompact_bytes: 12\nrecovery: token-goat retrieve abc\n```',
    )
  })

  it('keeps the recovery line intact, since that is the line the model is told to key on', () => {
    expect(fencePayload('recovery: token-goat retrieve abc')).toContain('\nrecovery: token-goat retrieve abc\n')
  })

  it('outgrows a backtick run inside the payload instead of being closed early by it', () => {
    // Nothing compress-text emits today contains a backtick (fixed headers plus an optional
    // base64url body), so this guards the shape rather than a current input: a fence closed early
    // by its own content truncates the payload silently, with no error at any layer.
    const fenced = fencePayload('before\n```js\ncode\n```\nafter')
    expect(fenced.startsWith('````\n')).toBe(true)
    expect(fenced.endsWith('\n````')).toBe(true)
  })

  it('sizes the fence to the longest run, not merely to a run being present', () => {
    expect(fencePayload('a ````` b').startsWith('``````\n')).toBe(true)
  })
})
