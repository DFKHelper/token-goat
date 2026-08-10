import { exec, execFile, type ExecFileException } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

// Only arguments containing shell metacharacters get quotes; cmd.exe's
// /s /c quote-stripping mangles a command line where every argument is
// pre-quoted, and the npm .cmd shim forwards via %*, so quotes must be
// minimal and exact.
function quoteWindowsArgument(argument: string): string {
  if (argument.includes('\0')) throw new Error('token-goat cannot launch with a NUL byte in its path')
  if (!/[\s&|<>()^%"]/.test(argument)) return argument
  return `"${argument.replace(/"/g, '\\"')}"`
}

function runTokenGoat(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      encoding: 'utf8' as const,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      cwd,
    }
    if (process.platform === 'win32') {
      // npm exposes global CLIs as .cmd shims on Windows. All arguments passed
      // here are fixed flags or generated temporary paths, never workspace paths.
      const commandLine = ['token-goat.cmd', ...args.map(quoteWindowsArgument)].join(' ')
      exec(commandLine, options, callback)
      return
    }
    execFile('token-goat', args, options, callback)

    function callback(error: ExecFileException | null, stdout: string, stderr: string): void {
      if (error) {
        reject(new Error(stderr.trim() || `token-goat exited with code ${error.code ?? 'unknown'}`))
        return
      }
      resolve(stdout.trim())
    }
  })
}

async function withTemporaryText<T>(text: string, extension: string, action: (file: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'token-goat-vscode-'))
  const file = path.join(directory, `payload${extension}`)
  try {
    await fs.writeFile(file, text, 'utf8')
    return await action(file)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function openChat(query: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', { query })
}

function contextRadius(): number {
  return vscode.workspace.getConfiguration('token-goat').get<number>('contextLines', 25)
}

// compress-text prints original_bytes/compact_bytes/bytes_saved headers;
// surface the savings so the user sees what the compression bought.
function showStats(payload: string): void {
  if (!vscode.workspace.getConfiguration('token-goat').get<boolean>('showStats', true)) return
  const original = /^original_bytes: (\d+)$/m.exec(payload)
  const compact = /^compact_bytes: (\d+)$/m.exec(payload)
  if (!original || !compact) return
  void vscode.window.setStatusBarMessage(
    `token-goat: ${original[1]} → ${compact[1]} bytes`, 5000,
  )
}

async function compressSelectionPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('No active editor is open.')
  const text = editor.document.getText(editor.selection)
  if (!text) throw new Error('Select text before sending a compressed payload.')
  const payload = await withTemporaryText(text, '.txt', (file) => runTokenGoat(['compress-text', '--file', file]))
  showStats(payload)
  return payload
}

async function compressSurgicalPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('No active file is open.')
  const radius = contextRadius()
  const line = editor.selection.active.line
  const start = Math.max(0, line - radius)
  const end = Math.min(editor.document.lineCount, line + radius + 1)
  const sourceName = editor.document.isUntitled ? 'untitled document' : path.basename(editor.document.uri.fsPath)
  const excerpt = editor.document.getText(new vscode.Range(start, 0, end, 0))
  const payload = await withTemporaryText(excerpt, '.txt', (file) => runTokenGoat(['compress-text', '--file', file]))
  showStats(payload)
  return `Surgical ${start + 1}-${end} line excerpt from ${sourceName}:\n${payload}`
}

// Resolve the symbol under the cursor via the token-goat index
// (`scope "file:line"` prints "name\tkind\tfile:start-end", innermost first),
// then pull its full body. Falls back to the cursor-window excerpt when the
// project is not indexed or the cursor sits outside any symbol.
async function compressSymbolPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.isUntitled) throw new Error('Open a saved file to send the symbol at the cursor.')
  const workspace = vscode.workspace.getWorkspaceFolder(editor.document.uri)
  if (!workspace) throw new Error('The file is not inside the workspace folder.')
  const relative = path.relative(workspace.uri.fsPath, editor.document.uri.fsPath)
  const line = editor.selection.active.line + 1
  let scope: string
  try {
    scope = await runTokenGoat(['scope', `${relative}:${line}`], workspace.uri.fsPath)
  } catch {
    return compressSurgicalPayload()
  }
  const first = scope.split('\n')[0]?.split('\t')
  if (!first || first.length < 3) return compressSurgicalPayload()
  const [name, kind, location] = first
  const startLine = /:(\d+)-\d+$/.exec(location)?.[1]
  const spec = startLine ? `${relative}::${name}@${startLine}` : `${relative}::${name}`
  const body = await runTokenGoat(['read', spec], workspace.uri.fsPath)
  const payload = await withTemporaryText(body, '.txt', (file) => runTokenGoat(['compress-text', '--file', file]))
  showStats(payload)
  return `Symbol ${name} (${kind}) from ${path.basename(relative)}:\n${payload}`
}

async function compressFilePayload(target?: vscode.Uri): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (target && editor && editor.document.uri.fsPath === target.fsPath) {
    // The target is open in the editor: compress the in-memory text so
    // unsaved changes are included.
    const sourceName = path.basename(target.fsPath)
    const payload = await withTemporaryText(editor.document.getText(), path.extname(target.fsPath) || '.txt',
      (file) => runTokenGoat(['compress-text', '--file', file]))
    showStats(payload)
    return `Whole file ${sourceName}:\n${payload}`
  }
  const file = target?.fsPath ?? editor?.document.uri.fsPath
  if (!file) throw new Error('No file is open or selected.')
  const payload = await runTokenGoat(['compress-text', '--file', file])
  showStats(payload)
  return `Whole file ${path.basename(file)}:\n${payload}`
}

async function compressDiffPayload(): Promise<string> {
  const workspace = vscode.workspace.workspaceFolders?.[0]
  if (!workspace) throw new Error('Open a workspace folder to send its git diff.')
  const diff = await new Promise<string>((resolve, reject) => {
    exec('git diff HEAD', { cwd: workspace.uri.fsPath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || 'git diff failed — is this a git repository?'))
        else resolve(stdout)
      })
  })
  if (!diff.trim()) throw new Error('The working tree has no changes against HEAD.')
  const payload = await withTemporaryText(diff, '.diff', (file) => runTokenGoat(['compress-text', '--file', file]))
  showStats(payload)
  return `Compressed git diff of ${workspace.name} against HEAD:\n${payload}`
}

async function sendSelection(): Promise<void> {
  const payload = await compressSelectionPayload()
  await openChat(`Use this local token-goat compressed selection when useful:\n${payload}`)
}

async function sendSurgicalRead(): Promise<void> {
  await openChat(await compressSurgicalPayload())
}

async function sendSymbol(): Promise<void> {
  await openChat(await compressSymbolPayload())
}

async function sendFile(target?: vscode.Uri): Promise<void> {
  await openChat(await compressFilePayload(target))
}

async function sendDiff(): Promise<void> {
  await openChat(await compressDiffPayload())
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  void vscode.window.showErrorMessage(`token-goat: ${message}`)
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('token-goat.sendSelection', () => sendSelection().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendSurgicalRead', () => sendSurgicalRead().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendSymbol', () => sendSymbol().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendFile', (target?: vscode.Uri) => sendFile(target).catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendDiff', () => sendDiff().catch(reportError)),
  )

  const participant = vscode.chat.createChatParticipant('token-goat-vscode.tokenGoat', async (request, _ctx, stream, token) => {
    try {
      if (request.command === 'selection') {
        stream.markdown(await compressSelectionPayload())
      } else if (request.command === 'context') {
        stream.markdown(await compressSurgicalPayload())
      } else if (request.command === 'symbol') {
        stream.markdown(await compressSymbolPayload())
      } else if (request.command === 'file') {
        stream.markdown(await compressFilePayload())
      } else if (request.command === 'diff') {
        stream.markdown(await compressDiffPayload())
      } else {
        stream.markdown(
          'Type `@token-goat` with a subcommand: `/selection` (highlighted code), ' +
          '`/context` (lines around the cursor), `/symbol` (the function under the cursor), ' +
          '`/file` (the whole active file), or `/diff` (the workspace git diff). ' +
          'Each replies with a compressed payload that costs fewer chat tokens than pasting the raw code.'
        )
      }
    } catch (error) {
      stream.markdown(`token-goat: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (token.isCancellationRequested) return
  })
  context.subscriptions.push(participant)
}

export function deactivate(): void {}
