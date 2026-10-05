/** Whether a Claude Code session could be under permission rules no settings file shows, so that rewrite_permission.ts must not answer a bypassPermissions rewrite with `allow`: a host that answers prompts itself (an SDK `canUseTool`, any entry point but the terminal CLI), a command-line flag that adds or relays rules (`--disallowedTools`, `--settings`, `--permission-prompt-tool`, any flag not known to be harmless), a PermissionRequest hook in a skill or plugin (whose answers add session rules), and a skill, command, agent or plugin whose frontmatter removes a tool by pattern (`disallowed-tools: Bash(curl *)`). The settings files themselves are read by rewrite_permission.ts. Every doubt (an unreadable process command line or directory, a scan too large to finish) reads as hidden. Imported dynamically by rewrite_permission.ts's loadHiddenRuleCheck with its helpers injected, so it stays off every hook's eager path; it imports only Node built-ins. Claude Code facts are from claude.exe 2.1.x: hook processes get CLAUDE_PID (the claude process) and inherit CLAUDE_CODE_ENTRYPOINT, which Claude Code sets to `cli`, or `sdk-cli` under `-p`, and which every SDK, IDE and remote host sets to its own value; nested `.claude/skills` directories git ignores are skipped ("[skills] Skipped gitignored skills dir"). */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface HiddenRuleHelpers {
  readonly configDir: () => string
  readonly managedDirs: () => string[]
  readonly selfAndAncestors: (dir: string) => string[]
  readonly sourceAllowed: (source: string) => boolean
  readonly runGit: (args: string[], opts: { cwd: string; timeoutMs: number }) => { readonly exitCode: number; readonly stdout: string }
}

// Claude Code flags that add no permission rule and hand no prompt to anyone else; any other flag on the claude command line reads as a hidden rule source.
const HARMLESS_FLAGS: ReadonlySet<string> = new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--name', '-n', '--model', '--fallback-model', '--effort', '--thinking', '--max-thinking-tokens', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--enable-auto-mode', '--verbose', '--debug', '-d', '--debug-file', '--print', '-p', '--output-format', '--include-partial-messages', '--ide', '--chrome', '--no-chrome', '--mcp-config', '--strict-mcp-config', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file', '--max-turns', '--max-budget-usd', '--worktree', '-w', '--tmux', '--version', '-v', '--allowedtools', '--allowed-tools', '--tools', '--setting-sources', '--disable-slash-commands', '--no-session-persistence'])
const CLI_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'sdk-cli'])
const RULE_DIRS: readonly string[] = ['skills', 'commands', 'agents']
const SCAN_BUDGET = 20_000
const SCAN_TTL_MS = 60_000
const FILE_HEAD_BYTES = 256 * 1024

let processCache: { readonly key: string; readonly reason: string | null } | undefined
let scanCache: { readonly key: string; readonly at: number; readonly reason: string | null } | undefined

/** Drop the cached answers, for a test that changes what they read. */
export function resetHiddenRuleCache(): void {
  processCache = undefined
  scanCache = undefined
}

/** The command line of process `pid`, or null when it cannot be read. */
function commandLine(pid: string): string | null {
  try {
    if (process.platform === 'win32') {
      const ps = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const res = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      return res.error === undefined && res.status === 0 ? res.stdout.trim() : null
    }
    if (fs.existsSync('/proc/self/cmdline')) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
    const res = spawnSync('ps', ['-ww', '-o', 'args=', '-p', pid], { encoding: 'utf8', timeout: 15_000 })
    return res.error === undefined && res.status === 0 ? res.stdout.trim() : null
  } catch {
    return null
  }
}

/** Why the claude process itself could carry rules no file shows, or null: its entry point, then every flag on its command line. */
function processReason(env: NodeJS.ProcessEnv): string | null {
  const entrypoint = env['CLAUDE_CODE_ENTRYPOINT'] ?? ''
  if (!CLI_ENTRYPOINTS.has(entrypoint)) return `entry point ${entrypoint === '' ? 'unknown' : entrypoint}`
  const pid = env['CLAUDE_PID'] ?? ''
  if (!/^[1-9]\d{0,9}$/.test(pid)) return 'claude process unknown'
  const line = commandLine(pid)
  if (line === null || line === '') return 'claude command line unreadable'
  for (const raw of line.match(/"[^"]*"?|\S+/g) ?? []) {
    const token = raw.replace(/^"/, '')
    if (token === '--') break
    if (!token.startsWith('-')) continue
    const flag = (token.split('=')[0] as string).toLowerCase()
    if (!HARMLESS_FLAGS.has(flag)) return `claude started with ${flag}`
  }
  return null
}

/** The frontmatter block of a markdown file, or undefined when it has none. */
function frontmatter(text: string): string | undefined {
  return /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1]
}

/** Whether a frontmatter block could add a rule: a PermissionRequest hook, or a disallowed-tools entry that is more than a bare tool name (a bare name removes the tool, so no call to it ever reaches a hook). */
export function frontmatterAddsRule(front: string): boolean {
  if (front.includes('PermissionRequest')) return true
  const lines = front.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*["']?disallowed[-_]?tools["']?\s*:(.*)$/i.exec(lines[i] as string)
    if (m === null) continue
    let value = m[1] as string
    for (let j = i + 1; j < lines.length && /^[\s-]/.test(lines[j] as string); j++) value += ` ${lines[j] as string}`
    if (value.split(/[\s,[\]"'-]+/).some((t) => t !== '' && !/^[A-Za-z0-9_*.]+$/.test(t))) return true
  }
  return false
}

interface Scan {
  budget: number
  reason: string | null
}

/** The first bytes of a file, or null when it cannot be read. */
function head(file: string): string | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(FILE_HEAD_BYTES)
    return buf.subarray(0, fs.readSync(fd, buf, 0, FILE_HEAD_BYTES, 0)).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function checkFile(file: string, scan: Scan): void {
  const lower = file.toLowerCase()
  const json = lower.endsWith('.json')
  if (!json && !lower.endsWith('.md')) return
  const text = head(file)
  if (text === null) scan.reason = `cannot read ${file}`
  else if (json ? text.includes('PermissionRequest') : frontmatterAddsRule(frontmatter(text) ?? '')) scan.reason = `rule source ${file}`
}

/** Check every markdown and JSON file under `dir`, following links, within the scan's budget. */
function scanDir(dir: string, scan: Scan, helpers: HiddenRuleHelpers, depth = 0): void {
  if (scan.reason !== null || !helpers.sourceAllowed(dir)) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') scan.reason = `cannot read ${dir}`
    return
  }
  for (const entry of entries) {
    if (scan.reason !== null) return
    if (--scan.budget < 0) {
      scan.reason = 'too many files to check'
      return
    }
    const full = path.join(dir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const st = fs.statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isDir && entry.name !== 'node_modules' && entry.name !== '.git') {
      if (depth >= 32) scan.reason = `too deep under ${dir}`
      else scanDir(full, scan, helpers, depth + 1)
    } else if (isFile) {
      checkFile(full, scan)
    }
  }
}

/** Find nested `.claude` directories under `dir` outside a git checkout, where Claude Code discovers skills from any of them. */
function walkForClaudeDirs(dir: string, scan: Scan, helpers: HiddenRuleHelpers, depth = 0): void {
  if (scan.reason !== null || !helpers.sourceAllowed(dir)) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') scan.reason = `cannot read ${dir}`
    return
  }
  for (const entry of entries) {
    if (scan.reason !== null) return
    if (--scan.budget < 0) {
      scan.reason = 'too many files to check'
      return
    }
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.name === '.claude') for (const sub of RULE_DIRS) scanDir(path.join(full, sub), scan, helpers)
    else if (depth >= 32) scan.reason = `too deep under ${dir}`
    else walkForClaudeDirs(full, scan, helpers, depth + 1)
  }
}

/** Every skill, command and agent directory Claude Code could load for a session in `cwd` whose project is `project`, plus installed plugins, checked for a rule-adding file. */
function scanReason(cwd: string, project: string, helpers: HiddenRuleHelpers): string | null {
  const scan: Scan = { budget: SCAN_BUDGET, reason: null }
  const configDir = helpers.configDir()
  const roots = [configDir, ...[cwd, project].flatMap(helpers.selfAndAncestors).map((d) => path.join(d, '.claude')), ...helpers.managedDirs().map((d) => path.join(d, '.claude'))]
  const seen = new Set<string>()
  for (const root of roots) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (seen.has(key)) continue
    seen.add(key)
    for (const sub of RULE_DIRS) scanDir(path.join(root, sub), scan, helpers)
  }
  // Installed plugins run from the plugin cache; the marketplace clones and the plugin directory listing beside it only describe plugins, and the listing names PermissionRequest in their descriptions.
  scanDir(path.join(configDir, 'plugins', 'cache'), scan, helpers)
  if (scan.reason !== null) return scan.reason
  // Nested skill directories: inside a git checkout Claude Code skips ignored ones, so git lists exactly the candidates; outside one every directory is walked.
  const inRepo = helpers.selfAndAncestors(project).some((d) => fs.existsSync(path.join(d, '.git')))
  if (inRepo) {
    const res = helpers.runGit(['ls-files', '-co', '--exclude-standard', '-z', '--', ...RULE_DIRS.map((d) => `:(glob)**/.claude/${d}/**`)], { cwd: project, timeoutMs: 15_000 })
    if (res.exitCode !== 0) return 'cannot list nested skills'
    for (const rel of res.stdout.split('\0')) {
      if (rel === '') continue
      if (--scan.budget < 0) return 'too many files to check'
      checkFile(path.join(project, rel), scan)
      if (scan.reason !== null) return scan.reason
    }
  } else {
    walkForClaudeDirs(project, scan, helpers)
  }
  return scan.reason
}

/** Why the session behind this hook could be under a permission rule no settings file shows, or null when every source was read and none adds one. `env` is the hook's environment, which Claude Code builds. */
export function hiddenRuleSource(cwd: string, projectDir: string | undefined, env: NodeJS.ProcessEnv, helpers: HiddenRuleHelpers, now = Date.now()): string | null {
  const processKey = `${env['CLAUDE_CODE_SESSION_ID'] ?? ''}:${env['CLAUDE_PID'] ?? ''}:${env['CLAUDE_CODE_ENTRYPOINT'] ?? ''}`
  if (processCache?.key !== processKey) processCache = { key: processKey, reason: processReason(env) }
  if (processCache.reason !== null) return processCache.reason
  const here = path.resolve(cwd)
  const project = projectDir !== undefined && path.isAbsolute(projectDir) ? path.resolve(projectDir) : here
  const scanKey = `${processKey}:${here}:${project}`
  if (scanCache?.key !== scanKey || now - scanCache.at > SCAN_TTL_MS) scanCache = { key: scanKey, at: now, reason: scanReason(here, project, helpers) }
  return scanCache.reason
}
