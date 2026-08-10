import { execFile, type ExecFileException } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

function quoteWindowsArgument(argument: string): string {
  if (argument.includes('\0')) throw new Error('token-goat cannot launch with a NUL byte in its path')
  return `"${argument
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/[&|<>()]/g, '^$&')}"`
}

function runTokenGoat(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      encoding: 'utf8' as const,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }
    if (process.platform === 'win32') {
      // npm exposes global CLIs as .cmd shims on Windows. All arguments passed
      // here are fixed flags or generated temporary paths, never workspace paths.
      const commandLine = ['token-goat.cmd', ...args.map(quoteWindowsArgument)].join(' ')
      execFile(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', commandLine], options, callback)
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

async function compressSelectionPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('No active editor is open.')
  const text = editor.document.getText(editor.selection)
  if (!text) throw new Error('Select text before sending a compressed payload.')
  return withTemporaryText(text, '.txt', (file) => runTokenGoat(['compress-text', '--file', file]))
}

async function compressSurgicalPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('No active file is open.')
  const line = editor.selection.active.line
  const start = Math.max(0, line - 25)
  const end = Math.min(editor.document.lineCount, line + 26)
  const sourceName = editor.document.isUntitled ? 'untitled document' : path.basename(editor.document.uri.fsPath)
  const excerpt = editor.document.getText(new vscode.Range(start, 0, end, 0))
  const payload = await withTemporaryText(excerpt, '.txt', (file) => runTokenGoat(['compress-text', '--file', file]))
  return `Surgical ${start + 1}-${end} line excerpt from ${sourceName}:\n${payload}`
}

async function sendSelection(): Promise<void> {
  const payload = await compressSelectionPayload()
  await openChat(`Use this local token-goat compressed selection when useful:\n${payload}`)
}

async function sendSurgicalRead(): Promise<void> {
  await openChat(await compressSurgicalPayload())
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  void vscode.window.showErrorMessage(`token-goat: ${message}`)
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('token-goat.sendSelection', () => sendSelection().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendSurgicalRead', () => sendSurgicalRead().catch(reportError)),
  )

  const participant = vscode.chat.createChatParticipant('token-goat-vscode.tokenGoat', async (request, _ctx, stream, token) => {
    try {
      if (request.command === 'selection') {
        stream.markdown(await compressSelectionPayload())
      } else if (request.command === 'context') {
        stream.markdown(await compressSurgicalPayload())
      } else {
        stream.markdown(
          'Type `@token-goat /selection` to compress your highlighted code, ' +
          'or `@token-goat /context` to compress the 51 lines around your cursor. ' +
          'The compressed payload costs fewer chat tokens than pasting the raw code.'
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
