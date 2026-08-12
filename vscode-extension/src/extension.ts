import { exec, execFile, type ExecFileException } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { formatSavingsBar, parseStatsJson, type StatsJson } from './savings'

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

// Tickets and logs carry emails, phone numbers, ID numbers, and card numbers.
// Strip them before compression so they never reach the chat input.
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, 'id-number'],
  [/\b(?:\d[ -]?){13,16}\b/g, 'card-number'],
  [/(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g, 'phone'],
]

let lastRedactions = 0

function scrubPii(text: string): string {
  lastRedactions = 0
  if (!vscode.workspace.getConfiguration('token-goat').get<boolean>('scrubPii', true)) return text
  let out = text
  for (const [pattern, label] of PII_PATTERNS) {
    out = out.replace(pattern, () => {
      lastRedactions++
      return `[${label} removed]`
    })
  }
  return out
}

// Single compression path for all text payloads: scrub, compress, report.
async function compressText(text: string, extension: string): Promise<string> {
  const payload = await withTemporaryText(scrubPii(text), extension, (file) => runTokenGoat(['compress-text', '--file', file]))
  showStats(payload)
  if (lastRedactions > 0) {
    if (savingsContext && !savingsContext.globalState.get<boolean>('piiNoticeShown', false)) {
      void savingsContext.globalState.update('piiNoticeShown', true)
      void vscode.window.showInformationMessage(
        `token-goat removed ${lastRedactions} personal-data item(s) (emails, phone/ID/card numbers) before this reached chat. It does this every time — turn it off in Settings if you need raw text.`,
        'Keep it on', 'Turn it off',
      ).then((choice) => {
        if (choice === 'Turn it off') {
          void vscode.workspace.getConfiguration('token-goat').update('scrubPii', false, vscode.ConfigurationTarget.Global)
        }
      })
    } else {
      void vscode.window.setStatusBarMessage(`token-goat: removed ${lastRedactions} personal-data item(s) before sending`, 6000)
    }
  }
  return payload
}

async function openChat(query: string): Promise<void> {
  await ensureDecoderSetup()
  const hint = '\n\n(This message contains token-goat-compressed text. Decode it with the recovery command in the payload. If you cannot, tell the user to run: token-goat install --vscode)'
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: query + hint })
}

// The payload is only readable by the chat model when the workspace has
// token-goat's MCP decoder (token-goat install --vscode). Check once per
// session and offer to set it up instead of leaving the user staring at a
// base64 blob.
let decoderChecked = false

async function ensureDecoderSetup(): Promise<void> {
  if (decoderChecked) return
  decoderChecked = true
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return
  try {
    const raw = await fs.readFile(path.join(folder.uri.fsPath, '.vscode', 'mcp.json'), 'utf8')
    if (raw.includes('token-goat')) return
  } catch {
    // No mcp.json — fall through to the prompt below.
  }
  const choice = await vscode.window.showWarningMessage(
    'token-goat compressed this for chat, but this workspace has no decoder set up — chat will show an unreadable blob. Set it up now? (runs: token-goat install --vscode)',
    'Set up now', 'Not now',
  )
  if (choice !== 'Set up now') return
  try {
    await runTokenGoat(['install', '--vscode'], folder.uri.fsPath)
    void vscode.window.showInformationMessage('token-goat decoder installed. Two steps left: reload the window (Ctrl+Shift+P → Developer: Reload Window), then start the server when VS Code asks — or via Ctrl+Shift+P → "MCP: List Servers" → token-goat → Start. Compressed payloads also need Agent mode in chat.')
  } catch (error) {
    reportError(error)
  }
}

// Tokens-saved status bar: rendered straight from the local ledger (`token-goat stats --json`), which already covers every source (reads, hints, bash, images, compression), not just the compress-text operations this extension itself triggers.
let savingsBar: vscode.StatusBarItem | undefined
let savingsContext: vscode.ExtensionContext | undefined
let lastSavingsRefresh = 0
const SAVINGS_REFRESH_MIN_INTERVAL_MS = 30000
const SAVINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000
let savingsRefreshTimer: ReturnType<typeof setInterval> | undefined

// Throttled: this can be triggered after every compress operation (a user action, not a hot path) plus a background timer, so a minimum interval keeps rapid-fire actions from shelling out repeatedly.
async function refreshSavingsBar(force = false): Promise<void> {
  if (!savingsBar) return
  const now = Date.now()
  if (!force && now - lastSavingsRefresh < SAVINGS_REFRESH_MIN_INTERVAL_MS) return
  lastSavingsRefresh = now
  let stats: StatsJson | null = null
  try {
    stats = parseStatsJson(await runTokenGoat(['stats', '--json']))
  } catch {
    stats = null
  }
  const rendered = formatSavingsBar(stats)
  savingsBar.text = rendered.text
  savingsBar.tooltip = rendered.tooltip
}

function contextRadius(): number {
  return vscode.workspace.getConfiguration('token-goat').get<number>('contextLines', 25)
}

// compress-text prints original_bytes/compact_bytes/tokens_saved headers (tokens_saved can be negative when the encoding swap costs more than it saves); surface that real figure, not a bytes÷4 guess.
function showStats(payload: string): void {
  void refreshSavingsBar()
  if (!vscode.workspace.getConfiguration('token-goat').get<boolean>('showStats', true)) return
  const original = /^original_bytes: (\d+)$/m.exec(payload)
  const compact = /^compact_bytes: (\d+)$/m.exec(payload)
  const tokensSaved = /^tokens_saved: (-?\d+)$/m.exec(payload)
  if (!original || !compact || !tokensSaved) return
  const tokens = Number(tokensSaved[1])
  const label = tokens < 0 ? `${Math.abs(tokens)} tokens lost` : `${tokens} tokens saved`
  void vscode.window.setStatusBarMessage(
    `token-goat: ${original[1]} → ${compact[1]} bytes (${label})`, 5000,
  )
}

async function compressSelectionPayload(): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('No active editor is open.')
  const text = editor.document.getText(editor.selection)
  if (!text) throw new Error('Select text before sending a compressed payload.')
  return compressText(text, '.txt')
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
  const payload = await compressText(excerpt, '.txt')
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
  const payload = await compressText(body, '.txt')
  return `Symbol ${name} (${kind}) from ${path.basename(relative)}:\n${payload}`
}

async function compressFilePayload(target?: vscode.Uri): Promise<string> {
  const editor = vscode.window.activeTextEditor
  if (target && editor && editor.document.uri.fsPath === target.fsPath) {
    // The target is open in the editor: compress the in-memory text so
    // unsaved changes are included.
    const sourceName = path.basename(target.fsPath)
    const payload = await compressText(editor.document.getText(), path.extname(target.fsPath) || '.txt')
    return `Whole file ${sourceName}:\n${payload}`
  }
  const file = target?.fsPath ?? editor?.document.uri.fsPath
  if (!file) throw new Error('No file is open or selected.')
  const payload = await compressText(await fs.readFile(file, 'utf8'), path.extname(file) || '.txt')
  return `Whole file ${path.basename(file)}:\n${payload}`
}

async function compressClipboardPayload(): Promise<string> {
  const text = await vscode.env.clipboard.readText()
  if (!text.trim()) throw new Error('The clipboard has no text. Copy the ticket, log, or message first.')
  const payload = await compressText(text, '.txt')
  return `Compressed clipboard contents (${text.length} characters):\n${payload}`
}

// Keep signal lines (errors, failures, warnings, exceptions) plus two lines of
// surrounding context so a multi-megabyte log becomes its actionable core.
const LOG_SIGNAL = /error|fail|exception|warn|critical|fatal|denied|timeout|refused|unauthorized/i

function extractLogSignal(text: string): string {
  const lines = text.split('\n')
  const kept = new Set<number>()
  lines.forEach((line, i) => {
    if (!LOG_SIGNAL.test(line)) return
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) kept.add(j)
  })
  if (kept.size === 0) return text
  const sorted = [...kept].sort((a, b) => a - b)
  const out: string[] = []
  let previous = -2
  for (const i of sorted) {
    if (i > previous + 1 && out.length > 0) out.push('...')
    out.push(lines[i])
    previous = i
  }
  return out.join('\n')
}

async function compressErrorsPayload(target?: vscode.Uri): Promise<string> {
  const file = target?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath
  if (!file) throw new Error('Open a log file, or right-click one in the Explorer.')
  const text = await fs.readFile(file, 'utf8')
  const signal = extractLogSignal(text)
  const payload = await compressText(signal, '.log')
  return `Errors and warnings from ${path.basename(file)} (${text.length} → ${signal.length} characters before compression):\n${payload}`
}

async function zipListPayload(target?: vscode.Uri): Promise<string> {
  const file = target?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath
  if (!file) throw new Error('Right-click a .zip/.vsix/.nupkg file in the Explorer first.')
  return `Contents of ${path.basename(file)} (listed without extracting):\n${await runTokenGoat(['zip-list', file])}`
}

// Ticket attachments arrive as PDFs and Word documents; extract their text
// with the CLI's document readers, then compress like any other payload.
async function compressDocumentPayload(target?: vscode.Uri): Promise<string> {
  const file = target?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath
  if (!file) throw new Error('Right-click a .pdf or .docx file in the Explorer first.')
  const ext = path.extname(file).toLowerCase()
  const reader = ext === '.pdf' ? 'pdf-extract' : ext === '.docx' ? 'docx-text' : undefined
  if (!reader) throw new Error(`Cannot extract text from a '${ext}' file — use .pdf or .docx.`)
  const text = await runTokenGoat([reader, file])
  if (!text.trim()) throw new Error(`No extractable text found in ${path.basename(file)} (a scanned image-only PDF has no text layer).`)
  const payload = await compressText(text, '.txt')
  return `Text extracted from ${path.basename(file)}:\n${payload}`
}

// Right-click a folder of exported tickets/documents and ask one question
// across all of them. Capped at 20 text-like files so a stray folder pick
// can't launch a hundred CLI invocations.
const BATCHABLE = /\.(txt|log|md|csv|json|ya?ml|xml|html?|eml)$/i
const BATCH_LIMIT = 20

async function analyzeFolderPayload(target?: vscode.Uri): Promise<string> {
  if (!target) throw new Error('Right-click a folder in the Explorer first.')
  const names = (await fs.readdir(target.fsPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && BATCHABLE.test(entry.name))
    .slice(0, BATCH_LIMIT)
  if (names.length === 0) throw new Error('That folder has no readable text files (.txt, .log, .csv, .md, …).')
  const parts: string[] = []
  for (const entry of names) {
    const text = await fs.readFile(path.join(target.fsPath, entry.name), 'utf8')
    parts.push(`=== ${entry.name} ===\n${text}`)
  }
  const payload = await compressText(parts.join('\n\n'), '.txt')
  return `These are ${names.length} documents from the folder "${path.basename(target.fsPath)}". What are the top recurring issues or themes across them?\n${payload}`
}

// Canned plain-language prompts: the source is the selection if one exists,
// otherwise the clipboard (tickets usually arrive via copy-paste), otherwise
// the active file.
const PLAIN_STYLE = 'Rules for your answer: use short sentences; no jargon or acronyms without a one-line plain-English explanation; put the single most important point first; numbered steps for anything the person must do; under 150 words unless the content truly needs more.'

const CANNED_PROMPTS: Record<string, string> = {
  summarize: `Summarize this for a non-technical reader. ${PLAIN_STYLE} Start with one sentence answering "what is this about and does it need me to do something?"`,
  reply: `Draft a polite reply to the person who wrote this. ${PLAIN_STYLE} The reply should sound like a helpful human, not a form letter.`,
  actions: `List what needs to be done and who should do it. ${PLAIN_STYLE} Format: a numbered list, one action per line, each starting with a verb.`,
  explain: `Explain this in plain language, whatever it is — an error, a changelog entry, a message, documentation. If the text describes a problem someone is hitting, include "What to do" (numbered steps, easiest first) and "If that doesn't work" (one line). If it does not describe a problem, just explain what it says and what it means for the reader — do not invent a problem, do not add steps, and do not remark on what kind of text it is. ${PLAIN_STYLE}`,
  kb: `Turn this resolved ticket into a short knowledge-base article. ${PLAIN_STYLE} Sections: "The problem", "Why it happened", "How to fix it" (numbered steps), "How to avoid it next time".`,
  friendlier: `Rewrite my text below so it sounds warm and friendly while keeping every fact. ${PLAIN_STYLE}`,
  shorter: `Rewrite my text below as short as possible while keeping the key facts. ${PLAIN_STYLE}`,
  formal: `Rewrite my text below in a formal, professional tone. Keep it clear — formal does not mean long sentences or big words.`,
}

async function cannedPromptPayload(kind: keyof typeof CANNED_PROMPTS): Promise<string> {
  const editor = vscode.window.activeTextEditor
  const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : ''
  const clipboard = selection ? '' : await vscode.env.clipboard.readText()
  const fileText = selection || clipboard ? '' : editor && !editor.document.isUntitled ? editor.document.getText() : ''
  const text = selection || clipboard || fileText
  if (!text.trim()) throw new Error('Select some text, copy it to the clipboard, or open a file first.')
  const source = selection ? 'the selected text' : clipboard ? 'the clipboard' : 'the open file'
  const payload = await compressText(text, '.txt')
  return `${CANNED_PROMPTS[kind]}\nCompressed source (${source}):\n${payload}`
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
  const payload = await compressText(diff, '.diff')
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

async function sendClipboard(): Promise<void> {
  await openChat(await compressClipboardPayload())
}

async function sendErrors(target?: vscode.Uri): Promise<void> {
  await openChat(await compressErrorsPayload(target))
}

async function sendZipList(target?: vscode.Uri): Promise<void> {
  await openChat(await zipListPayload(target))
}

async function sendDocument(target?: vscode.Uri): Promise<void> {
  await openChat(await compressDocumentPayload(target))
}

async function sendFolderAnalysis(target?: vscode.Uri): Promise<void> {
  await openChat(await analyzeFolderPayload(target))
}

async function sendCanned(kind: keyof typeof CANNED_PROMPTS): Promise<void> {
  await openChat(await cannedPromptPayload(kind))
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  void vscode.window.showErrorMessage(`token-goat: ${message}`)
}

export function activate(context: vscode.ExtensionContext): void {
  savingsContext = context
  savingsBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  savingsBar.text = formatSavingsBar(null).text
  savingsBar.tooltip = formatSavingsBar(null).tooltip
  savingsBar.show()
  void refreshSavingsBar(true)
  savingsRefreshTimer = setInterval(() => void refreshSavingsBar(), SAVINGS_REFRESH_INTERVAL_MS)

  context.subscriptions.push(
    savingsBar,
    vscode.commands.registerCommand('token-goat.sendSelection', () => sendSelection().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendSurgicalRead', () => sendSurgicalRead().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendSymbol', () => sendSymbol().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendFile', (target?: vscode.Uri) => sendFile(target).catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendDiff', () => sendDiff().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendClipboard', () => sendClipboard().catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendErrors', (target?: vscode.Uri) => sendErrors(target).catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendZipList', (target?: vscode.Uri) => sendZipList(target).catch(reportError)),
    vscode.commands.registerCommand('token-goat.askSummarize', () => sendCanned('summarize').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askReply', () => sendCanned('reply').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askActions', () => sendCanned('actions').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askExplain', () => sendCanned('explain').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askKb', () => sendCanned('kb').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askFriendlier', () => sendCanned('friendlier').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askShorter', () => sendCanned('shorter').catch(reportError)),
    vscode.commands.registerCommand('token-goat.askFormal', () => sendCanned('formal').catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendDocument', (target?: vscode.Uri) => sendDocument(target).catch(reportError)),
    vscode.commands.registerCommand('token-goat.sendFolderAnalysis', (target?: vscode.Uri) => sendFolderAnalysis(target).catch(reportError)),
  )

  const participant = vscode.chat.createChatParticipant('token-goat-vscode.tokenGoat', async (request, _ctx, stream, token) => {
    try {
      await ensureDecoderSetup()
      // A chat participant's reply is shown as the final answer — it never
      // reaches the Copilot model, so streaming a compressed payload here
      // would just display the blob. Instead, prefill the input box and let
      // the user send it to the Copilot agent, which can decode it.
      const handoff = async (question: string): Promise<void> => {
        await openChat(question)
        stream.markdown('Compressed and ready — press Enter in the input box to send it to Copilot (use Agent mode so it can decode the payload).')
      }
      if (request.command === 'selection') {
        await handoff(`Use this local token-goat compressed selection when useful:\n${await compressSelectionPayload()}`)
      } else if (request.command === 'context') {
        await handoff(await compressSurgicalPayload())
      } else if (request.command === 'symbol') {
        await handoff(await compressSymbolPayload())
      } else if (request.command === 'file') {
        await handoff(await compressFilePayload())
      } else if (request.command === 'diff') {
        await handoff(await compressDiffPayload())
      } else if (request.command === 'paste') {
        await handoff(await compressClipboardPayload())
      } else if (request.command === 'errors') {
        await handoff(await compressErrorsPayload())
      } else if (request.command && request.command in CANNED_PROMPTS) {
        await handoff(await cannedPromptPayload(request.command))
      } else {
        stream.markdown(
          'Ask me to shrink something before it goes into chat. Subcommands: ' +
          '`/paste` (whatever you copied — a ticket, an email, an error message), ' +
          '`/errors` (just the errors and warnings from the open log file), ' +
          '`/summarize`, `/reply`, `/actions`, `/explain` (plain-language answers about selected/copied text), ' +
          '`/kb` (resolved ticket → knowledge-base article), ' +
          '`/friendlier`, `/shorter`, `/formal` (tone rewrites for text you wrote), ' +
          'plus developer commands `/selection`, `/context`, `/symbol`, `/file`, `/diff`. ' +
          'Everything is compressed first, so long tickets and logs cost fewer chat tokens.'
        )
      }
    } catch (error) {
      stream.markdown(`token-goat: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (token.isCancellationRequested) return
  })
  context.subscriptions.push(participant)
}

export function deactivate(): void {
  if (savingsRefreshTimer) clearInterval(savingsRefreshTimer)
}
