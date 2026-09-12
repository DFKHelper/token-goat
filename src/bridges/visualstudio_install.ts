/**
 * Visual Studio (the full IDE, 2022 17.14+ and 2026) GitHub Copilot agent-mode integration: an MCP server entry and routing guidance, and nothing else.
 *
 * MCP: Visual Studio reads `%USERPROFILE%\.mcp.json`, then `<SOLUTIONDIR>\.vs\mcp.json`, `<SOLUTIONDIR>\.mcp.json`, `<SOLUTIONDIR>\.vscode\mcp.json` and `<SOLUTIONDIR>\.cursor\mcp.json`, each with a `servers` root key holding `{type:"stdio", command, args, env}` entries (https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers). New MCP tools start disabled: the user ticks them in the chat Tools picker.
 * Instructions: `.github/copilot-instructions.md` in the solution, and `%USERPROFILE%\copilot-instructions.md` for the user on Visual Studio 2026, both gated by the Tools > Options checkbox "Enable custom instructions to be loaded from .github/copilot-instructions.md files and added to requests" (https://learn.microsoft.com/en-us/visualstudio/ide/copilot-chat-context).
 * Hooks: GitHub documents agent hooks only for Copilot cloud agent and Copilot CLI (https://docs.github.com/en/copilot/concepts/agents/hooks), so this bridge writes no hooks file. In Visual Studio there is no read dedup, no hint, no image shrink and no output folding.
 *
 * Both `.mcp.json` paths are also Claude Code files: it reads `<dir>\.mcp.json` in every directory from the cwd up to the drive root, validates each with `mcpServers` required, and fails fatally on a file holding only `servers`. So this module edits `servers["token-goat"]`, adds an empty `mcpServers` to any file it writes that lacks one, and leaves an existing `mcpServers` key byte-for-byte as it was; it registers nothing for Claude Code.
 *
 * This module must not import vscode_install.ts or copilot_cli_install.ts: both call syncVisualStudioProjectGuidance, so importing either would close an import cycle.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, backupFile, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { recordCreatedConfig, removeCreatedBackups, takeCreatedConfig } from './created_configs.js'
import { buildGuidanceBody } from './guidance_block.js'
import { loadConfig } from '../config.js'
import { dropEmptyServers, dropLoneEmptyMcpServers, ensureMcpServersKey, hasManagedServer, holdsOnlyManagedServer, isManagedServer, managedServer, readServersJson, serversOf, setTokenGoatServer } from './mcp_servers_json.js'

const LABEL = 'Visual Studio'

export const VISUALSTUDIO_GUIDANCE_BEGIN = '<!-- token-goat-visualstudio-begin -->'
export const VISUALSTUDIO_GUIDANCE_END = '<!-- token-goat-visualstudio-end -->'

/** The other token-goat gate blocks that can sit in the same `.github/copilot-instructions.md` (install --vscode -p and install --copilot --local); literal copies because importing their modules would be a cycle, and tests pin them to the real exports. */
export const SIBLING_GATE_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['<!-- token-goat-vscode-begin -->', '<!-- token-goat-vscode-end -->'],
  ['<!-- token-goat-begin -->', '<!-- token-goat-end -->'],
]

/** Scope selector: user scope by default, `project: true` for the solution folder (the cwd unless `projectRoot` is given). */
export interface VisualStudioScopeOptions {
  project?: boolean
  projectRoot?: string
}

export function visualStudioUserMcpPath(): string {
  return path.join(os.homedir(), '.mcp.json')
}

export function visualStudioProjectMcpPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.mcp.json')
}

export function visualStudioMcpPath(opts: VisualStudioScopeOptions = {}): string {
  return opts.project === true ? visualStudioProjectMcpPath(opts.projectRoot) : visualStudioUserMcpPath()
}

function otherScopeMcpPath(opts: VisualStudioScopeOptions): string {
  return opts.project === true ? visualStudioUserMcpPath() : visualStudioProjectMcpPath(opts.projectRoot)
}

/** Where the routing guidance goes: the solution's `.github/copilot-instructions.md`, or `%USERPROFILE%\copilot-instructions.md` for the user; user scope never touches the cwd. */
export function visualStudioInstructionsPath(opts: VisualStudioScopeOptions = {}): string {
  return opts.project === true
    ? path.join(path.resolve(opts.projectRoot ?? process.cwd()), '.github', 'copilot-instructions.md')
    : path.join(os.homedir(), 'copilot-instructions.md')
}

/** Whether the other scope's `.mcp.json` already registers token-goat; Visual Studio reads both files, so writing this scope too would register it twice. */
export function visualStudioOtherScopeHasManagedServer(opts: VisualStudioScopeOptions = {}): boolean {
  return hasManagedServer(otherScopeMcpPath(opts), LABEL)
}

/** Whether this scope's `.mcp.json` registers token-goat. */
export function isVisualStudioInstalled(opts: VisualStudioScopeOptions = {}): boolean {
  return hasManagedServer(visualStudioMcpPath(opts), LABEL)
}

/** The solution's `.vscode/mcp.json`, which Visual Studio also reads and `install --vscode -p` writes; a literal copy of vscodeProjectMcpPath because importing vscode_install.ts would be a cycle, and a test pins the two together. */
export function visualStudioSolutionVscodeMcpPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.vscode', 'mcp.json')
}

/** Every file Visual Studio reads for a solution at `projectRoot` that registers token-goat: two or more means it lists the server twice. */
export function visualStudioManagedRegistrations(projectRoot = process.cwd()): string[] {
  return [visualStudioUserMcpPath(), visualStudioProjectMcpPath(projectRoot), visualStudioSolutionVscodeMcpPath(projectRoot)].filter((p) => hasManagedServer(p, LABEL))
}

/** The note install prints when Visual Studio would see token-goat twice for the solution at `projectRoot`, or null when it sees it at most once. */
export function visualStudioDuplicateNote(projectRoot = process.cwd()): string | null {
  const found = visualStudioManagedRegistrations(projectRoot)
  if (found.length < 2) return null
  const lead = `Note: Visual Studio reads ${found.join(' and ')}, and each registers token-goat, so it will list the token-goat server more than once for this solution.`
  if (!found.includes(visualStudioSolutionVscodeMcpPath(projectRoot))) return `${lead} Keep one: run "token-goat uninstall --visualstudio" or "token-goat uninstall --visualstudio -p".`
  return `${lead} Keep one: if you do not use VS Code in this folder, run "token-goat uninstall --vscode -p"; otherwise run "token-goat uninstall --visualstudio${found.includes(visualStudioUserMcpPath()) ? '' : ' -p'}".`
}

/** Backs `mcp-status --visualstudio`: whether the user `.mcp.json` (and, with a projectRoot, the solution one) registers token-goat. */
export function visualStudioMcpStatus(opts: { projectRoot?: string } = {}): { configured: boolean; checkedPaths: string[] } {
  const checkedPaths = [visualStudioUserMcpPath()]
  if (opts.projectRoot !== undefined) checkedPaths.push(visualStudioProjectMcpPath(opts.projectRoot))
  return { configured: checkedPaths.some((p) => hasManagedServer(p, LABEL)), checkedPaths }
}

/** The command and bundle path of a managed entry in `filePath`, or null when there is none (or the file is unreadable). */
export function visualStudioManagedEntry(filePath: string): { command: string; bundlePath: string } | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const entry = serversOf(readServersJson(filePath, LABEL), filePath, LABEL)['token-goat']
    if (!isManagedServer(entry)) return null
    const { command, args } = entry as { command?: unknown; args: string[] }
    return { command: typeof command === 'string' ? command : '', bundlePath: args[0] ?? '' }
  } catch {
    return null
  }
}

// Visual Studio's own agent tool names, from the custom-agents page; written without code spans because an instructions loader can harvest backticked names into a tool allowlist.
const FALLBACK_TOOL_CLAUSE = 'Visual Studio’s built-in readfile, code_search, and find_references tools'

const RETRIEVE_NOTE =
  '**Compressed payloads:** a message containing a token-goat payload block (recognizable by a `recovery: token-goat retrieve <id>` line) is compressed text, not an answer. Call the MCP tool `retrieve_text` with that id to recover the original text, then answer the question the message asks using the recovered text. Never present the raw payload to the user as the response; if the `retrieve_text` tool is unavailable (the MCP server is not running, or its tools are not ticked in the chat Tools picker), say so plainly and ask the user to turn on the token-goat tools.'

const SUPPORT_NOTE =
  'Visual Studio support: token-goat install --visualstudio registers a stdio MCP server under the servers root key of %USERPROFILE%\\.mcp.json (with --project, the .mcp.json in the solution folder). Visual Studio runs no token-goat hooks, so nothing denies a repeated read, adds a hint, shrinks an image, or folds what readfile returns there: the narrow reads come only from calling the token-goat MCP tools, or the token-goat CLI through runcommandinterminal.'

/** The Visual Studio block: the full gate when it is alone in its file, or a short addendum when another token-goat gate already sits in the same file. */
export function buildVisualStudioGuidanceBlock(sharesFileWithGate: boolean): string {
  const lead = sharesFileWithGate
    ? ['## token-goat in Visual Studio', '', `The token-goat gate elsewhere in this file applies in Visual Studio too; there, ${FALLBACK_TOOL_CLAUSE} are the fallback it names.`]
    : [buildGuidanceBody(FALLBACK_TOOL_CLAUSE, { gdrive: loadConfig().gdrive.enabled })]
  return [VISUALSTUDIO_GUIDANCE_BEGIN, ...lead, '', RETRIEVE_NOTE, '', SUPPORT_NOTE, VISUALSTUDIO_GUIDANCE_END].join('\n')
}

function hasBlock(text: string, begin: string, end: string): boolean {
  const b = text.indexOf(begin)
  const e = text.indexOf(end)
  return b !== -1 && e > b
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function writeGuidance(filePath: string): boolean {
  const text = readText(filePath)
  const shares = SIBLING_GATE_MARKERS.some(([begin, end]) => hasBlock(text, begin, end))
  return upsertDelimitedBlock(filePath, VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END, buildVisualStudioGuidanceBlock(shares))
}

/**
 * Re-renders an existing Visual Studio block in `filePath` for the gate blocks now beside it; a no-op when the file has no Visual Studio block.
 *
 * Called after install/uninstall --vscode -p and --copilot --local change the same file, so the gate is never there twice and never missing: removing the other block turns the addendum back into the full gate.
 */
export function syncVisualStudioProjectGuidance(filePath: string): boolean {
  if (!hasBlock(readText(filePath), VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END)) return false
  return writeGuidance(filePath)
}

export interface VisualStudioInstallResult {
  mcpPath: string
  instructionsPath: string
  alreadyInstalled: boolean
  scope: 'project' | 'user'
}

export function installVisualStudio(opts: VisualStudioScopeOptions = {}): VisualStudioInstallResult {
  const scope: 'project' | 'user' = opts.project === true ? 'project' : 'user'
  const mcpPath = visualStudioMcpPath(opts)
  const instructionsPath = visualStudioInstructionsPath(opts)
  if (visualStudioOtherScopeHasManagedServer(opts)) {
    const otherScope = scope === 'project' ? 'user' : 'project'
    throw new Error(
      `token-goat is already registered in Visual Studio ${otherScope} scope (${otherScopeMcpPath(opts)}). Visual Studio reads both files, so installing into ${scope} scope too would register it twice. Run "token-goat uninstall --visualstudio${otherScope === 'project' ? ' --project' : ''}" first if you want to move it, or drop --visualstudio from this run.`,
    )
  }
  // Remembered before the write, because afterwards the file exists either way and nothing in it says who made it.
  const mcpExisted = fs.existsSync(mcpPath)
  const config = readServersJson(mcpPath, LABEL)
  // A file that already exists can still be ours: an earlier build wrote a servers-only file holding nothing but token-goat's own managed entry, and this run repairs it. That is not the content-sniffing the ledger exists to avoid, because there is no user data in such a file to lose: every key in it is one token-goat wrote.
  const ownedAlready = mcpExisted && holdsOnlyManagedServer(config.value)
  const current = serversOf(config, mcpPath, LABEL)['token-goat']
  if (current !== undefined && !isManagedServer(current)) {
    throw new Error(`Visual Studio MCP JSON at ${mcpPath} already has a non-token-goat-managed server named "token-goat"`)
  }
  const next = ensureMcpServersKey(setTokenGoatServer(config.text, managedServer()))
  if (config.text !== next) {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    backupFile(mcpPath)
    atomicWriteText(mcpPath, next)
    if (!mcpExisted || ownedAlready) recordCreatedConfig(mcpPath)
  }
  const guidanceChanged = writeGuidance(instructionsPath)
  return { mcpPath, instructionsPath, alreadyInstalled: config.text === next && !guidanceChanged, scope }
}

/** Removes only token-goat's entry and block; a file left holding nothing at all (`{}`, or blank guidance) is deleted, since nothing of the user's is in it. */
export function uninstallVisualStudio(opts: VisualStudioScopeOptions = {}): boolean {
  const mcpPath = visualStudioMcpPath(opts)
  let removed = false
  if (fs.existsSync(mcpPath)) {
    const config = readServersJson(mcpPath, LABEL)
    if (isManagedServer(serversOf(config, mcpPath, LABEL)['token-goat'])) {
      const next = dropEmptyServers(setTokenGoatServer(config.text, undefined))
      // Empty is not evidence the file is ours: a user's pre-existing `{"mcpServers": {}}` project stub walks back to exactly the same bytes. Only a file this install created is deleted; anything else is left holding its empty stub.
      if (/^\s*\{\s*\}\s*$/.test(dropLoneEmptyMcpServers(next)) && takeCreatedConfig(mcpPath)) fs.rmSync(mcpPath, { force: true })
      else {
        backupFile(mcpPath)
        atomicWriteText(mcpPath, ensureMcpServersKey(next))
      }
      // The timestamped backups this bridge made for mcpPath are token-goat's own litter, so a full uninstall takes them with it.
      removeCreatedBackups(mcpPath)
      removed = true
    }
  }
  const instructionsPath = visualStudioInstructionsPath(opts)
  if (stripDelimitedBlock(instructionsPath, VISUALSTUDIO_GUIDANCE_BEGIN, VISUALSTUDIO_GUIDANCE_END)) {
    removed = true
    if (readText(instructionsPath).trim() === '') fs.rmSync(instructionsPath, { force: true })
  }
  return removed
}
