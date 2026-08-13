import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDecoderSetup, resetDecoderCheckedForTests } from '../src/extension'

// 'vscode' only exists inside a real extension host, and a factory-only vi.mock resolves it
// as the module without ever finding a real 'vscode' package on disk. The mocks it closes over
// go through vi.hoisted so they exist by the time vitest's hoisting moves this vi.mock call
// above the static imports above it.
const { showWarningMessage, showInformationMessage, showErrorMessage } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}))
let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolders
    },
    isTrusted: true,
  },
  window: { showWarningMessage, showInformationMessage, showErrorMessage },
}))

const runTokenGoat = vi.hoisted(() => vi.fn())
vi.mock('../src/launcher', () => ({
  runTokenGoat,
  assertSafeArgSegment: vi.fn(),
  runGitDiff: vi.fn(),
}))

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

  it('the prompt wording is workspace-independent, matching that the check itself fires with no folder open', async () => {
    // Task C, issue #76-adjacent: the check no longer depends on a workspace at all (see the
    // "no folder open" case above), so the prompt text must not claim "this workspace" has no
    // decoder -- that claim is false whenever no folder is even open.
    workspaceFolders = undefined
    runTokenGoat.mockResolvedValue(JSON.stringify({ configured: false, checkedPaths: [] }))
    showWarningMessage.mockResolvedValue('Not now')
    await ensureDecoderSetup()
    expect(showWarningMessage).toHaveBeenCalledTimes(1)
    const promptText = showWarningMessage.mock.calls[0]?.[0] as string
    expect(promptText).not.toMatch(/this workspace/i)
  })
})

describe('ensureDecoderSetup (CLI/extension version skew, issue #76 task B)', () => {
  it('shows an actionable update message, not a raw Commander error toast, when the installed CLI predates mcp-status', async () => {
    // Commander's own wording for a command the CLI doesn't recognize -- this is exactly what
    // `runTokenGoat` rejects with when the global token-goat is older than the extension
    // (marketplace and npm ship independently). Pre-fix this fell into the generic `catch`
    // (`reportError(error); return`), surfacing this raw internal wording as an error toast
    // and permanently skipping the setup prompt for the rest of the session.
    workspaceFolders = undefined
    runTokenGoat.mockRejectedValue(new Error("error: unknown command 'mcp-status'"))
    await ensureDecoderSetup()
    expect(showWarningMessage).toHaveBeenCalledTimes(1)
    const promptText = showWarningMessage.mock.calls[0]?.[0] as string
    expect(promptText).toMatch(/update/i)
    expect(promptText).not.toMatch(/unknown command/i)
  })

  it('still routes a genuine, unrelated failure through the normal error path (not the version-skew message)', async () => {
    workspaceFolders = undefined
    runTokenGoat.mockRejectedValue(new Error('ECONNREFUSED: something else entirely broke'))
    await ensureDecoderSetup()
    expect(showWarningMessage).not.toHaveBeenCalled()
    expect(showErrorMessage).toHaveBeenCalledTimes(1)
  })
})
