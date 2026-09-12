/**
 * Project-local VS Code MCP configuration and routing guidance.
 *
 * This intentionally does not install the extension package. VS Code supports
 * the stdio MCP server through `.vscode/mcp.json`; the extension is separately
 * packaged and installed as a VSIX when desired.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, backupFile, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { buildGuidanceBody } from './guidance_block.js'
import { loadConfig } from '../config.js'
import { copilotHooksFilePaths, installCopilotHooksFile, readCopilotHooksOwners, releaseCopilotHooksFile } from './copilot_cli_install.js'
import { assertProjectScopeTarget } from './project_scope_guard.js'
import { recordCreatedConfig, removeCreatedBackups, takeCreatedConfig } from './created_configs.js'
import { dropEmptyServers, isManagedServer, jsonc, managedServer, readServersJson, setTokenGoatServer, type ServersJsonConfig } from './mcp_servers_json.js'
import { syncVisualStudioProjectGuidance } from './visualstudio_install.js'

/** Markers of the VS Code guidance block; exported so the Visual Studio block can tell when it shares a file with this one. */
export const VSCODE_GUIDANCE_BEGIN = '<!-- token-goat-vscode-begin -->'
export const VSCODE_GUIDANCE_END = '<!-- token-goat-vscode-end -->'
const BEGIN = VSCODE_GUIDANCE_BEGIN
const END = VSCODE_GUIDANCE_END

/** Scope selector shared by every VS Code path helper below, mirroring CopilotCliScopeOptions. */
export interface VscodeScopeOptions {
  /** When true, target the project-scoped `<project>/.vscode/mcp.json` instead of the user-scoped profile one. */
  project?: boolean
  /** Only meaningful with `project: true`; defaults to `process.cwd()`. */
  projectRoot?: string
  /**
   * Keep the `.bak.<ISO>` recovery copies this run creates instead of sweeping them at the end.
   *
   * Only `uninstallVscode` reads it, and only the MIGRATION inside `installVscode` sets it. An
   * uninstall sweeping its own backups is right -- the user asked for token-goat to be gone -- but
   * the same function run as one step of an install is not an uninstall: it rewrites a user-scope
   * file nobody asked it to touch, and deleting the recovery copy it made seconds earlier is
   * precisely where a804e9f9's "every overwritten file has a recovery copy" guarantee failed. This
   * is an explicit option rather than call-site ordering so the distinction cannot be lost again by
   * moving a line.
   */
  keepBackups?: boolean
}

/**
 * VS Code's user-profile config directory, mirroring how VS Code itself resolves it
 * (confirmed against VS Code's own docs, not assumed by analogy with another bridge):
 * `%APPDATA%\Code\User` on Windows, `~/Library/Application Support/Code/User` on
 * macOS, `~/.config/Code/User` on Linux. `mcp.json` lives directly inside it, using
 * the same `servers` root key as the project-local file. Like
 * `opencodeGlobalConfigDir` in `./opencode_install.js`, the Windows branch reads
 * `process.env['APPDATA']` directly (falling back to `~/AppData/Roaming` if unset or
 * blank) rather than hardcoding a path, so tests and dogfooding can isolate it the
 * same way they already isolate `HOME`/`USERPROFILE`/`LOCALAPPDATA`.
 */
function vscodeUserConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    const base = appData !== undefined && appData.trim() !== '' ? appData : path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'Code', 'User')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  return path.join(os.homedir(), '.config', 'Code', 'User')
}

export function vscodeUserMcpPath(): string {
  return path.join(vscodeUserConfigDir(), 'mcp.json')
}

export function vscodeProjectMcpPath(projectRoot = process.cwd()): string {
  return path.join(path.resolve(projectRoot), '.vscode', 'mcp.json')
}

/** Resolves the mcp.json path for the requested scope; defaults to user scope, matching every other harness's `-p/--project` convention. */
export function vscodeMcpPath(opts: VscodeScopeOptions = {}): string {
  return opts.project === true ? vscodeProjectMcpPath(opts.projectRoot) : vscodeUserMcpPath()
}

/** The other scope's mcp.json path -- used only to detect a cross-scope duplicate registration. */
function otherScopeMcpPath(opts: VscodeScopeOptions): string {
  return opts.project === true ? vscodeUserMcpPath() : vscodeProjectMcpPath(opts.projectRoot)
}

/**
 * Where the VS Code routing guidance goes for this scope; user scope never touches the current directory.
 *
 * Project scope is the workspace's `.github/copilot-instructions.md`. User scope is a personal instructions file: VS Code 1.136.0's instructions-location list in workbench.desktop.main.js has `{path:"~/.copilot/instructions",source:"copilot-personal",storage:"user"}`, which the default `chat.instructionsFilesLocations` turns on, and a file there counts as instructions when its name ends in `.instructions.md`. Like the hooks directory, VS Code expands that `~/` against the home directory, not COPILOT_HOME.
 */
export function vscodeInstructionsPath(opts: VscodeScopeOptions = {}): string {
  return opts.project === true
    ? path.join(path.resolve(opts.projectRoot ?? process.cwd()), '.github', 'copilot-instructions.md')
    : path.join(os.homedir(), '.copilot', 'instructions', 'token-goat.instructions.md')
}

// applyTo '**' is what makes VS Code attach the personal file to every request: its instructions matcher (_matches in workbench.desktop.main.js) treats '**', '**/*' and '*' as matching everything, while a file with no applyTo is only offered for the model to load on demand by its description.
const USER_INSTRUCTIONS_FRONTMATTER = "---\ndescription: 'token-goat: when to use its MCP tools and CLI instead of reading whole files'\napplyTo: '**'\n---\n"

/**
 * The Copilot-format event keys VS Code maps out of a hooks file; any other key is skipped.
 *
 * Read from the camelCase-to-hook-type table in workbench.desktop.main.js (VS Code 1.136.0), where
 * `userPromptSubmitted` becomes UserPromptSubmit and `agentStop` becomes Stop. The shared hooks file
 * also carries `preCompact` and `postToolUseFailure` for Copilot CLI; VS Code never runs those two.
 */
export const VSCODE_HOOK_FILE_EVENT_KEYS: readonly string[] = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'agentStop',
  'subagentStop',
  'errorOccurred',
]

/**
 * The hooks directory VS Code's agent reads for this scope.
 *
 * Both entries are on VS Code's own hook-source list in workbench.desktop.main.js (1.136.0):
 * `.github/hooks` in the workspace and `~/.copilot/hooks` for the user. VS Code expands that `~/`
 * against the user's home directory, not COPILOT_HOME, so the user scope ignores COPILOT_HOME here
 * even though Copilot CLI honors it; when COPILOT_HOME is unset the two are the same directory and
 * share one hooks file.
 */
export function vscodeHooksDir(opts: VscodeScopeOptions = {}): string {
  return opts.project === true
    ? path.join(path.resolve(opts.projectRoot ?? process.cwd()), '.github', 'hooks')
    : path.join(os.homedir(), '.copilot', 'hooks')
}

/**
 * The scope `--vscode` installs into, from the install/uninstall flags.
 *
 * This is the ONE harness that defaults to project scope, and the inversion is deliberate: VS Code
 * resolves a hook's working directory as `getWorkspaceFolder(hookFile.uri) ?? folders[0]`, and a
 * user-scope hooks file (`~/.copilot/hooks`) is inside no workspace folder, so the lookup misses on
 * every invocation and the cwd is always the FIRST folder. Captured live against 1.137.0: in a
 * two-root workspace the user-scope copy fired once, with `cwd` pinned to root A, while a
 * project-scope copy in root B fired with `cwd` = root B. Since `vscode_path_gate.ts` confines
 * every pre-approval hook to that cwd, read hints, image shrinking and edit interception were
 * silently inert for every folder past the first -- no error, just nothing.
 *
 * `--user` is the explicit opt-out and keeps the old single-file, every-project behaviour, with
 * that multi-root limitation. `-p`/`--project` remains accepted and now selects what is already
 * the default. `tests/guards/harness_scope_defaults.test.ts` fails on any harness whose default is
 * not classified there, so a second inversion cannot arrive unnoticed.
 */
export function vscodeScopeFromFlags(flags: { project?: boolean; user?: boolean }): VscodeScopeOptions {
  return { project: flags.user !== true }
}

/** Whether `install --vscode` has put its hooks in this scope's hooks directory. */
export function vscodeHooksInstalled(opts: VscodeScopeOptions = {}): boolean {
  return readCopilotHooksOwners(vscodeHooksDir(opts)).has('vscode')
}

export function vscodeUserSettingsPath(): string {
  return path.join(vscodeUserConfigDir(), 'settings.json')
}

/**
 * True when VS Code's user settings turn on `chat.useClaudeHooks`, which makes VS Code also run
 * the hooks in `~/.claude/settings.json`. It defaults to false (its configuration entry in
 * workbench.desktop.main.js, 1.136.0). Read only; an unreadable or malformed file reads as false.
 */
export function vscodeUsesClaudeHooks(settingsPath = vscodeUserSettingsPath()): boolean {
  let text: string
  try {
    text = fs.readFileSync(settingsPath, 'utf8')
  } catch {
    return false
  }
  const parsed: unknown = jsonc().parse(text, [], { allowTrailingComma: true, disallowComments: false })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return (parsed as Record<string, unknown>)['chat.useClaudeHooks'] === true
}

function readConfig(filePath: string): ServersJsonConfig {
  return readServersJson(filePath, 'VS Code')
}

const updateConfig = setTokenGoatServer

export interface VscodeInstallResult {
  mcpPath: string
  instructionsPath: string
  /** The shared hooks file VS Code's agent runs (also Copilot CLI's; see CopilotHooksOwner). */
  hooksConfigPath: string
  alreadyInstalled: boolean
  /** True when this run walked an existing user-scope install back before writing the project one. */
  migratedFromUserScope: boolean
  /** Which scope was actually written: 'project' (the default) or 'user' (`--user`). */
  scope: 'project' | 'user'
}

/**
 * Best-effort check for a token-goat-managed entry already sitting in the *other*
 * scope. Writing this scope on top of that would register token-goat twice --
 * VS Code merges user- and workspace-scope `mcp.json` when both name the same
 * server, duplicating all of its tool schemas into the workspace. A malformed or
 * unreadable other-scope file is not this call's problem to raise (that surfaces,
 * loudly, the moment someone actually installs into that scope), so this swallows
 * read/parse failures and reports "no managed entry found" rather than throwing.
 */
export function otherScopeHasManagedServer(opts: VscodeScopeOptions): boolean {
  const otherPath = otherScopeMcpPath(opts)
  if (!fs.existsSync(otherPath)) return false
  try {
    const config = readConfig(otherPath)
    const servers = config.value['servers']
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return false
    return isManagedServer((servers as Record<string, unknown>)['token-goat'])
  } catch {
    return false
  }
}

export interface VscodeDecoderStatus {
  configured: boolean
  checkedPaths: string[]
}

/**
 * Single source of truth for "is the VS Code decoder set up", shared by the extension's
 * ensureDecoderSetup prompt so it can never drift from what installVscode actually writes.
 * Always checks user scope (the default since 9c220be7); also checks the workspace scope
 * when a projectRoot is given, since that is the only case where `.vscode/mcp.json` is
 * relevant at all -- a user-scope install is workspace-independent, so this deliberately
 * does not require projectRoot to report `configured: true`.
 */
export function vscodeDecoderConfigured(opts: { projectRoot?: string } = {}): VscodeDecoderStatus {
  const checkedPaths = [vscodeUserMcpPath()]
  if (opts.projectRoot !== undefined) checkedPaths.push(vscodeProjectMcpPath(opts.projectRoot))
  for (const candidate of checkedPaths) {
    if (!fs.existsSync(candidate)) continue
    try {
      const config = readConfig(candidate)
      const servers = config.value['servers']
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue
      if (isManagedServer((servers as Record<string, unknown>)['token-goat'])) {
        return { configured: true, checkedPaths }
      }
    } catch {
      // Malformed file at this path isn't this check's problem -- it surfaces loudly the
      // moment someone actually installs into that scope. Keep scanning the rest.
    }
  }
  return { configured: false, checkedPaths }
}

function writeGuidance(filePath: string, userScope: boolean): boolean {
  // A new personal instructions file needs its frontmatter ahead of the block; an existing one keeps whatever the user gave it.
  let created = false
  if (userScope && !fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    atomicWriteText(filePath, USER_INSTRUCTIONS_FRONTMATTER)
    created = true
  }
  const body = [
    BEGIN,
    buildGuidanceBody('VS Code’s supported MCP integration and its built-in file-read tools', { gdrive: loadConfig().gdrive.enabled }),
    '',
    '**Compressed payloads:** a message containing a token-goat payload block (recognizable by a `recovery: token-goat retrieve <id>` line) is compressed text, not an answer. Call the MCP tool `retrieve_text` with that id to recover the original text, then answer the question the message asks using the recovered text. Never present the raw payload to the user as the response; if the `retrieve_text` tool is unavailable (the MCP server is not running, or the chat is not in Agent mode), say so plainly and ask the user to switch to Agent mode or run `token-goat install --vscode`.',
    '',
    'VS Code support: token-goat install --vscode configures a stdio MCP server under the servers root key in your user-profile mcp.json by default (add --project for the workspace .vscode/mcp.json instead), and agent hooks that see VS Code’s built-in tool calls. The hooks can deny a repeated read, add a hint, and shrink an image before view_image loads it; they cannot fold or trim what a built-in read returns, and they leave terminal commands unchanged.',
    END,
  ].join('\n')
  return upsertDelimitedBlock(filePath, BEGIN, END, body) || created
}

/**
 * Refuse every project-scope target that resolves outside the project, before anything is read.
 *
 * Runs first in both entry points below, not next to each individual write: the disclosure this
 * closes happens on the READ (`readConfig`, `upsertDelimitedBlock`) and on `backupFile`'s copy,
 * both of which run before the first write. Checking at the write would be too late.
 *
 * User scope passes everything through -- see project_scope_guard.ts for why a symlinked dotfile
 * there is the user's own business.
 */
function assertProjectTargetsAreInTheProject(opts: VscodeScopeOptions): void {
  if (opts.project !== true) return
  const root = path.resolve(opts.projectRoot ?? process.cwd())
  for (const target of [vscodeMcpPath(opts), vscodeInstructionsPath(opts), ...copilotHooksFilePaths(vscodeHooksDir(opts))]) {
    assertProjectScopeTarget(target, root)
  }
}

export function installVscode(opts: VscodeScopeOptions = {}): VscodeInstallResult {
  assertProjectTargetsAreInTheProject(opts)
  const scope: 'project' | 'user' = opts.project === true ? 'project' : 'user'
  const mcpPath = vscodeMcpPath(opts)
  const instructionsPath = vscodeInstructionsPath(opts)
  // Migration, not an error, in the user -> project direction only. `install --vscode` defaults to
  // project scope now, so the FIRST post-upgrade run of the same command every existing user
  // already types lands here: refusing it would make the new default a wall rather than an
  // upgrade. Walking the user-scope install back is also what keeps the two from double-firing --
  // VS Code runs every hooks file it discovers, in both scopes, confirmed live (see
  // vscode_duplicate.ts's header). uninstallVscode() is the migration: it strips the user-scope
  // MCP entry and guidance block and releases this install's claim on the shared
  // `~/.copilot/hooks` files, leaving them in place when `install --copilot` still owns them.
  let migratedFromUserScope = false
  if (scope === 'project' && (otherScopeHasManagedServer(opts) || vscodeHooksInstalled())) {
    // keepBackups: this call is a migration STEP OF AN INSTALL, not an uninstall. It rewrites a
    // user-scope file the user did not ask it to touch, so the recovery copies it makes on the way
    // have to survive it -- uninstallVscode's own backup sweep would otherwise delete, seconds
    // after creating it, the only copy of what that file held before this run.
    migratedFromUserScope = uninstallVscode({ keepBackups: true })
  } else if (otherScopeHasManagedServer(opts)) {
    const otherPath = otherScopeMcpPath(opts)
    throw new Error(
      `token-goat is already registered in VS Code project scope (${otherPath}). Installing into user scope too would register it twice and duplicate its tool schemas in this workspace. Run "token-goat uninstall --vscode --project" first if you want to move it, or drop --vscode from this run.`,
    )
  }
  const config = readConfig(mcpPath)
  const existingServers = config.value['servers']
  if (existingServers !== undefined && (existingServers === null || typeof existingServers !== 'object' || Array.isArray(existingServers))) {
    throw new Error(`malformed VS Code MCP JSON at ${mcpPath}: servers must be an object`)
  }
  const servers = (existingServers as Record<string, unknown> | undefined) ?? {}
  const current = servers['token-goat']
  if (current !== undefined && !isManagedServer(current)) {
    throw new Error(`VS Code MCP JSON at ${mcpPath} already has a non-token-goat-managed server named "token-goat"`)
  }
  const next = updateConfig(config.text, managedServer())
  // Remembered before the write, because afterwards the file exists either way and nothing in it says who made it.
  const mcpExisted = fs.existsSync(mcpPath)
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
  if (config.text !== next) {
    backupFile(mcpPath)
    atomicWriteText(mcpPath, next)
    if (!mcpExisted) recordCreatedConfig(mcpPath)
  }
  const guidanceChanged = writeGuidance(instructionsPath, scope === 'user')
  if (scope === 'project') syncVisualStudioProjectGuidance(instructionsPath)
  const hooks = installCopilotHooksFile(vscodeHooksDir(opts), 'vscode')
  return {
    mcpPath,
    instructionsPath,
    hooksConfigPath: hooks.configPath,
    alreadyInstalled: config.text === next && !guidanceChanged && !hooks.changed && !migratedFromUserScope,
    scope,
    migratedFromUserScope,
  }
}

export function uninstallVscode(opts: VscodeScopeOptions = {}): boolean {
  assertProjectTargetsAreInTheProject(opts)
  const mcpPath = vscodeMcpPath(opts)
  let removed = false
  if (fs.existsSync(mcpPath)) {
    const config = readConfig(mcpPath)
    const servers = config.value['servers']
    if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
      throw new Error(`malformed VS Code MCP JSON at ${mcpPath}: servers must be an object`)
    }
    if (servers && isManagedServer((servers as Record<string, unknown>)['token-goat'])) {
      // Walking back the entry used to leave an empty `servers` object behind as a residue file. The sibling Visual Studio bridge already dropped the empty key and deleted what it had created; this is the same rule, including the part that matters most: a file left empty is only deleted when this install is the one that made it.
      const next = dropEmptyServers(updateConfig(config.text, undefined))
      if (/^\s*\{\s*\}\s*$/.test(next) && takeCreatedConfig(mcpPath)) fs.rmSync(mcpPath, { force: true })
      else {
        backupFile(mcpPath)
        atomicWriteText(mcpPath, next)
      }
      // The timestamped backups this bridge made for mcpPath are token-goat's own litter, so a full uninstall takes them with it. A migration is not a full uninstall and keeps them; see VscodeScopeOptions.keepBackups.
      if (opts.keepBackups !== true) removeCreatedBackups(mcpPath)
      removed = true
    }
  }
  const instructionsPath = vscodeInstructionsPath(opts)
  if (stripDelimitedBlock(instructionsPath, BEGIN, END, opts.keepBackups === true)) {
    removed = true
    // The personal file is one install created: once its block is gone and only the frontmatter install wrote is left, it goes too.
    if (opts.project !== true && fs.readFileSync(instructionsPath, 'utf8').trim() === USER_INSTRUCTIONS_FRONTMATTER.trim()) fs.rmSync(instructionsPath, { force: true })
  }
  // Outside the branch above: a Visual Studio block that leaned on this gate has to carry the full gate itself, and it is stale whether or not this run found a block of ours to strip. Running it only on the success path left an uninstall that did nothing unable to heal one.
  if (opts.project === true) syncVisualStudioProjectGuidance(instructionsPath)
  // Leaves the hooks file in place while `install --copilot` still relies on it.
  if (releaseCopilotHooksFile(vscodeHooksDir(opts), 'vscode', opts.keepBackups === true)) removed = true
  return removed
}
