import { afterEach, describe, expect, it, vi } from 'vitest'

// 'vscode' only exists inside a real extension host; { virtual: true } lets vitest resolve
// this mock as the module without ever finding a real 'vscode' package on disk.
const showWarningMessage = vi.fn()
const showInformationMessage = vi.fn()
let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined

vi.mock(
  'vscode',
  () => ({
    workspace: {
      get workspaceFolders() {
        return workspaceFolders
      },
      isTrusted: true,
    },
    window: { showWarningMessage, showInformationMessage },
  }),
  { virtual: true },
)

const runTokenGoat = vi.fn()
vi.mock('../src/launcher', () => ({
  runTokenGoat,
  assertSafeArgSegment: vi.fn(),
  runGitDiff: vi.fn(),
}))

const { ensureDecoderSetup, resetDecoderCheckedForTests } = await import('../src/extension')

afterEach(() => {
  vi.clearAllMocks()
  workspaceFolders = undefined
  resetDecoderCheckedForTests()
})

describe('ensureDecoderSetup (false-prompt regression, issue #82)', () => {
  it('does not prompt when a user-scope install is configured and no workspace folder is open', async () => {
    // Pre-fix, this returned early on `if (!folder) return` -- a user-scope install with
    // no folder open was silently undetected, so nothing about it was verifiable at all.
    // Post-fix it must call mcp-status (not require a folder) and see configured: true.
    workspaceFolders = undefined
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: true, checkedPaths: ['C:\\Users\\x\\AppData\\Roaming\\Code\\User\\mcp.json'] }))
    await ensureDecoderSetup()
    expect(runTokenGoat).toHaveBeenCalledWith(['mcp-status', '--vscode'], undefined)
    expect(showWarningMessage).not.toHaveBeenCalled()
  })

  it('does not prompt for a user-scope install with a workspace open and no workspace mcp.json', async () => {
    // This is the exact bug: install --vscode defaults to user scope (9c220be7), so a
    // correctly-installed user has no <project>/.vscode/mcp.json. Pre-fix this read only
    // that file and always found it missing, so the prompt fired every session.
    workspaceFolders = [{ uri: { fsPath: 'C:\\proj' } }]
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: true, checkedPaths: [] }))
    await ensureDecoderSetup()
    expect(runTokenGoat).toHaveBeenCalledWith(['mcp-status', '--vscode', '--project'], 'C:\\proj')
    expect(showWarningMessage).not.toHaveBeenCalled()
  })

  it('still prompts when neither scope has token-goat configured', async () => {
    workspaceFolders = [{ uri: { fsPath: 'C:\\proj' } }]
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: false, checkedPaths: [] }))
    showWarningMessage.mockResolvedValue('Not now')
    await ensureDecoderSetup()
    expect(showWarningMessage).toHaveBeenCalledTimes(1)
  })
})
