/** Whether a Claude Code session could be under permission rules no settings file shows, so that rewrite_permission.ts must not answer a rewrite with `allow` (in bypassPermissions for all of the sources below, in every other mode for the skill and plugin files alone): a host that answers prompts itself (an SDK `canUseTool`, any entry point but the terminal CLI), a command-line flag that adds or relays rules (`--disallowedTools`, `--settings`, `--permission-prompt-tool`, any flag not known to be harmless), a PermissionRequest hook in a skill or plugin (whose answers add session rules), a skill, command, agent or plugin whose frontmatter removes a tool by pattern (`disallowed-tools: Bash(curl *)`), and a subagent whose definition the scan did not read. The settings files themselves are read by rewrite_permission.ts. Every doubt (an unreadable process command line or directory, a scan too large to finish) reads as hidden. Imported dynamically by rewrite_permission.ts's loadHiddenRuleCheck with its helpers injected, so it stays off every hook's eager path; it imports only Node built-ins and the two small modules for the PowerShell launcher and the cross-process flag cache. The command-line half is also asked of every other approval (commandLineRuleSource), except in a host whose CLAUDE_CODE_ENTRYPOINT is set and is not the CLI's own (claude.exe 2.1.292 names `claude-vscode`, `claude-desktop`, `local-agent` and `remote*`). Claude Code facts are from claude.exe 2.1.x: hook processes get CLAUDE_PID (the claude process) and inherit CLAUDE_CODE_ENTRYPOINT, which Claude Code sets to `cli`, or `sdk-cli` under `-p`, and which every SDK, IDE and remote host sets to its own value; nested `.claude/skills` directories git ignores are skipped ("[skills] Skipped gitignored skills dir"), judged by `git check-ignore`, which exits 128 for a path past a symbolic link, so a linked directory is never skipped; a hook fired inside a subagent carries `agent_type`, the agent's frontmatter `name` (`plugin:name` for a plugin's agent) or a built-in's. */

import { execFile, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { powerShellCommandArgs, windowsPowerShellPath } from './windows_powershell.js'

export interface HiddenRuleHelpers {
  readonly configDir: () => string
  readonly managedDirs: () => string[]
  readonly selfAndAncestors: (dir: string) => string[]
  readonly sourceAllowed: (source: string) => boolean
  readonly runGit: (args: string[], opts: { cwd: string; timeoutMs: number }) => { readonly exitCode: number; readonly stdout: string }
}

/** What one check is about beyond its session: the clock, and the subagent the hook fired in (the payload's `agent_type`). */
export interface HiddenRuleQuery {
  readonly now?: number
  readonly agentType?: string | undefined
  /** Skip the claude process and its command line: asked of a call outside bypassPermissions, where {@link commandLineRuleSource} answers for them. */
  readonly filesOnly?: boolean
}

// Claude Code flags that add no permission rule and hand no prompt to anyone else; any other flag on the claude command line reads as a hidden rule source.
const HARMLESS_FLAGS: ReadonlySet<string> = new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--name', '-n', '--model', '--fallback-model', '--effort', '--thinking', '--max-thinking-tokens', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--enable-auto-mode', '--verbose', '--debug', '-d', '--debug-file', '--print', '-p', '--output-format', '--include-partial-messages', '--ide', '--chrome', '--no-chrome', '--mcp-config', '--strict-mcp-config', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file', '--max-turns', '--max-budget-usd', '--worktree', '-w', '--tmux', '--version', '-v', '--allowedtools', '--allowed-tools', '--tools', '--disable-slash-commands', '--no-session-persistence'])
const CLI_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'sdk-cli'])
// The agent types claude.exe 2.1.291 defines itself, none of which removes a tool by pattern: Explore, Plan and workflow-subagent remove whole tools only. `teammate` is not one of them: it runs another agent's definition, tools included, under its own name.
const BUILTIN_AGENTS: ReadonlySet<string> = new Set(['Explore', 'Plan', 'general-purpose', 'statusline-setup', 'claude-code-guide', 'web-fetch', 'fork', 'claude', 'worker', 'workflow-subagent', 'comment-thread-analyst'])
const RULE_DIRS: readonly string[] = ['skills', 'commands', 'agents']
// A path, as git prints it, at or inside a `.claude` skill, command or agent directory.
const RULE_PATH = /(?:^|\/)\.claude\/(?:skills|commands|agents)(?:\/|$)/
const AGENT_PATH = /(?:^|\/)\.claude\/agents(?:\/|$)/
const CLAUDE_INSIDE = /(?:^|\/)\.claude\//
const SCAN_BUDGET = 20_000
/** How many folder levels below the project the git path stamps, and at most how many folders. */
const NESTED_STAMP_DEPTH = 3
const NESTED_STAMP_DIRS = 2_000
const SCAN_TTL_MS = 60_000
const FILE_HEAD_BYTES = 256 * 1024

/** One scan's answer: the reason it found, the stamp of every directory and file it read (for {@link stillCurrent}), and the agent names it read definitions for. */
interface ScanResult {
  readonly reason: string | null
  readonly stamps: ReadonlyMap<string, string>
  readonly agents: ReadonlySet<string>
  readonly pluginAgents: ReadonlySet<string>
}

let processCache: { readonly key: string; readonly reason: string | null } | undefined
let fixedCache: (ScanResult & { readonly key: string; readonly at: number }) | undefined
let nestedCache: (ScanResult & { readonly key: string; readonly at: number }) | undefined

/** Drop the cached answers, for a test that changes what they read. */
export function resetHiddenRuleCache(): void {
  processCache = undefined
  fixedCache = undefined
  nestedCache = undefined
}

function hasProc(): boolean {
  return process.platform !== 'win32' && fs.existsSync('/proc/self/cmdline')
}

/** Process `pid`'s command line read from /proc, undefined where there is no /proc to read, and null when the process retitled itself: Node's `process.title` overwrites the arguments in place and pads the rest of the area with NULs (an empty argument), so what is left says nothing about the flags it was started with. */
function procCommandLine(pid: string): string | null | undefined {
  if (!hasProc()) return undefined
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  return raw.includes('\0\0') ? null : raw.split('\0').join(' ').trim()
}

/** The command that prints process `pid`'s command line, where /proc cannot be read. */
function commandLineQuery(pid: string): readonly [string, string[]] {
  if (process.platform === 'win32') return [windowsPowerShellPath(), powerShellCommandArgs(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`)]
  return ['ps', ['-ww', '-o', 'args=', '-p', pid]]
}

/** The command that prints the path of the executable process `pid` runs, which no retitling changes. */
function executableQuery(pid: string): readonly [string, string[]] {
  return ['ps', ['-ww', '-o', 'comm=', '-p', pid]]
}

/** The real path of a command word the way the shell finds it: as given when it holds a slash, else the first match on PATH. Null when nothing is found. */
function resolveCommand(word: string): string | null {
  const candidates = word.includes('/') ? [path.resolve(word)] : (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '').map((d) => path.join(d, word))
  for (const candidate of candidates) {
    try {
      return fs.realpathSync(candidate)
    } catch {
      continue
    }
  }
  return null
}

/** The command line `ps` printed for a process, or null when it shows signs of a retitled process. libuv's process.title overwrites the arguments in place on macOS as on Linux, and what `ps` then prints is a bare title with no flags, which would read as a claude started with none: output padded with blanks (the NUL-filled rest of the area), or a first word that is not the executable the process runs (the kernel's path, from `ps -o comm=`) reads as retitled. Anything that cannot be matched to the executable is doubt, and doubt is strict. A title that resolves to the same executable and leaves no padding cannot be told apart from a plain start; the CI runner on macOS is where this is observed. */
function untitledLine(printed: string, executable: string | null): string | null {
  const line = printed.replace(/\r?\n$/, '')
  if (/\s$/.test(line) || executable === null) return null
  const first = line.trim().split(/\s+/)[0] ?? ''
  const real = first === '' ? null : resolveCommand(first)
  const exec = executable.trim()
  let execReal: string | null
  try {
    execReal = exec === '' ? null : fs.realpathSync(exec)
  } catch {
    execReal = null
  }
  return real !== null && real === execReal ? line.trim() : null
}

/** The command line of process `pid`, or null when it cannot be read. */
function commandLine(pid: string): string | null {
  try {
    const proc = procCommandLine(pid)
    if (proc !== undefined) return proc
    const [file, args] = commandLineQuery(pid)
    const res = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    if (res.error !== undefined || res.status !== 0) return null
    if (process.platform === 'win32') return res.stdout.trim()
    const [exeFile, exeArgs] = executableQuery(pid)
    const exe = spawnSync(exeFile, exeArgs, { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    return untitledLine(res.stdout, exe.error === undefined && exe.status === 0 ? exe.stdout : null)
  } catch {
    return null
  }
}

/** Run a query without blocking the event loop: its stdout, or null when it failed. */
function queryAsync(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve(err === null ? stdout : null))
  })
}

/** {@link commandLine} without blocking the event loop while the query runs. */
async function commandLineAsync(pid: string): Promise<string | null> {
  try {
    const proc = procCommandLine(pid)
    if (proc !== undefined) return proc
    const [file, args] = commandLineQuery(pid)
    const printed = await queryAsync(file, args)
    if (printed === null) return null
    if (process.platform === 'win32') return printed.trim()
    const [exeFile, exeArgs] = executableQuery(pid)
    return untitledLine(printed, await queryAsync(exeFile, exeArgs))
  } catch {
    return null
  }
}

/** What identifies the claude process a cached command-line answer was read for: its session, pid and entry point, so a new session (or a pid reused by another) reads the command line afresh. */
function processKeyOf(env: NodeJS.ProcessEnv): string {
  return `${env['CLAUDE_CODE_SESSION_ID'] ?? ''}:${env['CLAUDE_PID'] ?? ''}:${env['CLAUDE_CODE_ENTRYPOINT'] ?? ''}`
}

/** Why the claude process cannot be checked at all (a host other than the terminal CLI, or no usable CLAUDE_PID), or null when its command line is the next thing to read. */
function entryReason(env: NodeJS.ProcessEnv): string | null {
  const entrypoint = env['CLAUDE_CODE_ENTRYPOINT'] ?? ''
  if (!CLI_ENTRYPOINTS.has(entrypoint)) return `entry point ${entrypoint === '' ? 'unknown' : entrypoint}`
  if (!/^[1-9]\d{0,9}$/.test(env['CLAUDE_PID'] ?? '')) return 'claude process unknown'
  return null
}

/** A flag on a claude command line: its name lower-cased, and its value (after `=`, or the next word when that is not a flag). */
interface Flag {
  readonly name: string
  readonly value: string | undefined
}

function flagsOf(line: string): Flag[] {
  const flags: Flag[] = []
  const words = (line.match(/"[^"]*"?|\S+/g) ?? []).map((raw) => raw.replace(/^"/, '').replace(/"$/, ''))
  for (let i = 0; i < words.length; i++) {
    const token = words[i] as string
    if (token === '--') break
    if (!token.startsWith('-')) continue
    const eq = token.indexOf('=')
    const next = words[i + 1]
    flags.push({ name: (eq < 0 ? token : token.slice(0, eq)).toLowerCase(), value: eq >= 0 ? token.slice(eq + 1) : next !== undefined && !next.startsWith('-') ? next : undefined })
  }
  return flags
}

/** The settings sources token-goat's allow proof reads; a `--setting-sources` that leaves one out would drop a deny or ask rule from a file token-goat read. */
const PROOF_SOURCES: readonly string[] = ['user', 'project', 'local']

/** Why a set of claude flags could carry rules no file shows: the first one not known to be harmless, or a `--setting-sources` that names fewer sources than the settings token-goat read. */
function flagsReason(flags: readonly Flag[]): string | null {
  for (const { name, value } of flags) {
    if (name === '--setting-sources') {
      const given = new Set((value ?? '').toLowerCase().split(',').map((v) => v.trim()))
      const dropped = PROOF_SOURCES.find((source) => !given.has(source))
      if (dropped !== undefined) return `claude started with --setting-sources without ${dropped}`
    } else if (!HARMLESS_FLAGS.has(name)) return `claude started with ${name}`
  }
  return null
}

/** Why the claude command line could carry rules no file shows: any flag not known to be harmless. */
function commandLineReason(line: string | null): string | null {
  return line === null || line === '' ? 'claude command line unreadable' : flagsReason(flagsOf(line))
}

/** Why the claude process behind this hook could be under rules its command line adds, or null when it cannot be: the cached answer for this session, else the entry point and command line read now. Nothing is remembered between processes (a record a hook left in a file the same user can write is a record the agent can write, and a forged "no flags" would approve what `--disallowedTools` refuses). Only a definitive answer is kept in memory (the entry point alone, or a command line that was read): a read that timed out or failed is strict for this call and read again on the next, so one slow query does not end approvals for the session. */
function processReason(env: NodeJS.ProcessEnv): string | null {
  const key = processKeyOf(env)
  if (processCache?.key === key) return processCache.reason
  const entry = entryReason(env)
  const line = entry === null ? commandLine(env['CLAUDE_PID'] as string) : null
  const reason = entry ?? commandLineReason(line)
  if (entry !== null || line !== null) processCache = { key, reason }
  return reason
}

/** Whether `env` names a host other than the terminal CLI, on the evidence of its entry point alone: a value that is set and is not one of the CLI's own. A missing or empty value is no evidence, so it takes the strict path. */
function isOtherHost(env: NodeJS.ProcessEnv): boolean {
  const entrypoint = env['CLAUDE_CODE_ENTRYPOINT'] ?? ''
  return entrypoint !== '' && !CLI_ENTRYPOINTS.has(entrypoint)
}

/** Why the claude command line could add a permission rule to a call that is not in bypassPermissions mode, or null when it adds none or the session is a host's rather than the terminal CLI (whose flags the hook cannot see; an accepted limit). A CLI session whose command line cannot be read counts as adding one. */
export function commandLineRuleSource(env: NodeJS.ProcessEnv): string | null {
  return isOtherHost(env) ? null : processReason(env)
}

/** Read the claude process's command line for this session ahead of {@link hiddenRuleSource}, without blocking: the resident hook server awaits this before a call that may be approved, so its event loop keeps answering while the query runs (about a second on Windows) and the check then finds the answer cached. A read that timed out or failed is not kept, so the next call reads again. */
export async function primeProcessReason(env: NodeJS.ProcessEnv): Promise<void> {
  const key = processKeyOf(env)
  if (processCache?.key === key) return
  const entry = entryReason(env)
  const line = entry === null ? await commandLineAsync(env['CLAUDE_PID'] as string) : null
  if (entry !== null || line !== null) processCache = { key, reason: entry ?? commandLineReason(line) }
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
  readonly helpers: HiddenRuleHelpers
  budget: number
  reason: string | null
  /** Set for the scans whose clean answer is re-checked against these stamps on every call: the fixed folders and the nested search. */
  readonly stamps: Map<string, string> | undefined
  readonly agents: Set<string>
  readonly pluginAgents: Set<string>
  /** Real paths of the directories already walked, so a link back up the tree is walked once. */
  readonly walked: Set<string>
  /** Set inside a git checkout: the text of a tracked file as the index holds it, undefined for a path git does not track, null when git could not print it. */
  indexedText?: (file: string) => string | null | undefined
}

/** Where a directory or file sits: how deep below its scan root, inside an agents directory, and inside the plugin cache. */
interface Place {
  readonly depth: number
  readonly agents: boolean
  readonly plugin: boolean
}

function newScan(helpers: HiddenRuleHelpers, stamped: boolean): Scan {
  return { helpers, budget: SCAN_BUDGET, reason: null, stamps: stamped ? new Map() : undefined, agents: new Set(), pluginAgents: new Set(), walked: new Set() }
}

function result(scan: Scan): ScanResult {
  return { reason: scan.reason, stamps: scan.stamps ?? new Map(), agents: scan.agents, pluginAgents: scan.pluginAgents }
}

/** What a later call compares to tell whether `file` changed: its modification time, and its size for a file. */
function stamp(file: string): string {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.isDirectory() ? 'dir' : st.size}`
  } catch {
    return 'absent'
  }
}

/** Whether every directory and file a scan read still carries the stamp it had then. */
function stillCurrent(stamps: ReadonlyMap<string, string>): boolean {
  for (const [file, was] of stamps) if (stamp(file) !== was) return false
  return true
}

/** The first bytes of a file, or why there are none: `missing` when there is no such file (no entry, a link to nothing, or a parent that is not a directory), `unreadable` when it exists but cannot be read. */
function head(file: string): { readonly text: string } | { readonly failure: 'missing' | 'unreadable' } {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(FILE_HEAD_BYTES)
    return { text: buf.subarray(0, fs.readSync(fd, buf, 0, FILE_HEAD_BYTES, 0)).toString('utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { failure: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function checkFile(file: string, scan: Scan, place: Place): void {
  const lower = file.toLowerCase()
  const json = lower.endsWith('.json')
  if (!json && !lower.endsWith('.md')) return
  scan.stamps?.set(file, stamp(file))
  const read = head(file)
  let text: string
  if ('failure' in read) {
    // A file that exists and cannot be read might add a rule. One that is not there adds none unless git tracks it: Claude Code reads skills from disk, but a skill moved away and back between two calls is the same skill, so the index copy answers for it.
    if (read.failure === 'unreadable') {
      scan.reason = `cannot read ${file}`
      return
    }
    const indexed = scan.indexedText?.(file)
    if (indexed === undefined) return
    if (indexed === null) {
      scan.reason = `cannot read ${file} from the index`
      return
    }
    text = indexed.slice(0, FILE_HEAD_BYTES)
  } else {
    text = read.text
  }
  const front = json ? undefined : (frontmatter(text) ?? '')
  if (front === undefined ? text.includes('PermissionRequest') : frontmatterAddsRule(front)) scan.reason = `rule source ${file}`
  else if (front !== undefined && place.agents) {
    // An agent's type is its frontmatter name, not its file name.
    const name = /^name[ \t]*:(.*)$/m.exec(front)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
    if (name !== undefined && name !== '') (place.plugin ? scan.pluginAgents : scan.agents).add(name)
  }
}

/** Whether `full` is a symbolic link or junction to a directory. */
function linksToDir(full: string): boolean {
  try {
    return fs.lstatSync(full).isSymbolicLink() && fs.statSync(full).isDirectory()
  } catch {
    return false
  }
}

/** Check every markdown and JSON file under `dir`, following links, within the scan's budget. */
function scanDir(dir: string, scan: Scan, place: Place): void {
  if (scan.reason !== null || !scan.helpers.sourceAllowed(dir)) return
  scan.stamps?.set(dir, stamp(dir))
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
      if (place.depth >= 32) scan.reason = `too deep under ${dir}`
      else scanDir(full, scan, { ...place, depth: place.depth + 1, agents: place.agents || entry.name === 'agents' })
    } else if (isFile) {
      checkFile(full, scan, place)
    }
  }
}

/** Check the skill, command and agent directories of one `.claude` directory. */
function scanClaudeDir(claudeDir: string, scan: Scan): void {
  for (const sub of RULE_DIRS) scanDir(path.join(claudeDir, sub), scan, { depth: 0, agents: sub === 'agents', plugin: false })
}

/** Whether `dir` is walked for the first time in this scan, by its real path. */
function firstWalk(dir: string, scan: Scan): boolean {
  let real: string
  try {
    real = fs.realpathSync.native(dir)
  } catch {
    return true
  }
  const key = process.platform === 'win32' ? real.toLowerCase() : real
  if (scan.walked.has(key)) return false
  scan.walked.add(key)
  return true
}

/** Find nested `.claude` directories under `dir`, following links and junctions (Claude Code discovers skills from any of them), and every `node_modules` too, which Claude Code does not skip. */
function walkForClaudeDirs(dir: string, scan: Scan, depth = 0): void {
  if (scan.reason !== null || !scan.helpers.sourceAllowed(dir) || !firstWalk(dir, scan)) return
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
    if (entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && linksToDir(full))) continue
    if (entry.name === '.claude') scanClaudeDir(full, scan)
    else if (depth >= 32) scan.reason = `too deep under ${dir}`
    else walkForClaudeDirs(full, scan, depth + 1)
  }
}

/** Nested skill directories inside a git checkout. Claude Code skips one whose holding folder `git check-ignore` reports, so git lists the candidates: every file in a skill, command or agent directory, and every ignored folder at or inside a `.claude`. A link is never skipped, since check-ignore exits 128 past one, so every link git can see (tracked, untracked, or ignored but not inside an ignored directory) that leads to a directory is followed. */
function scanGitCheckout(project: string, scan: Scan): void {
  const list = (args: string[]): string[] | null => {
    const res = scan.helpers.runGit(['ls-files', '-z', ...args], { cwd: project, timeoutMs: 15_000 })
    return res.exitCode === 0 ? res.stdout.split('\0').filter((entry) => entry !== '') : null
  }
  const tracked = list(['-s'])
  const untracked = list(['-o', '--exclude-standard'])
  const ignored = list(['-o', '-i', '--exclude-standard', '--directory'])
  if (tracked === null || untracked === null || ignored === null) {
    scan.reason = 'cannot list nested skills'
    return
  }
  stampShallowDirs(project, [...tracked.map((record) => record.slice(record.indexOf('\t') + 1)), ...untracked, ...ignored], scan)
  // Claude Code asks check-ignore about the folder holding `.claude`, never the skill itself, so an ignored file git lists on its own is still loaded: its folder would have been listed whole had it been ignored.
  const candidates: string[] = [...untracked, ...ignored.filter((rel) => !rel.endsWith('/'))]
  const objects = new Map<string, string>()
  for (const record of tracked) {
    // `<mode> <object> <stage>\t<path>`; mode 120000 is a link.
    const tab = record.indexOf('\t')
    const rel = record.slice(tab + 1)
    if (record.startsWith('120000 ') || RULE_PATH.test(rel)) candidates.push(rel)
    if (RULE_PATH.test(rel)) objects.set(path.join(project, rel), record.slice(0, tab).split(' ')[1] as string)
  }
  scan.indexedText = (file) => {
    const object = objects.get(file)
    if (object === undefined) return undefined
    const res = scan.helpers.runGit(['cat-file', 'blob', object], { cwd: project, timeoutMs: 15_000 })
    return res.exitCode === 0 ? res.stdout : null
  }
  // A path ending in `/` with nothing listed beneath it is a folder git did not look inside; git also lists the folders above an ignored file. Only one at or inside a `.claude` can be loaded, since the folder holding that `.claude` is not ignored.
  const sorted = [...ignored].sort()
  const ignoredDirs = sorted.filter((rel, i) => rel.endsWith('/') && sorted[i + 1]?.startsWith(rel) !== true && CLAUDE_INSIDE.test(rel))
  for (const rel of [...candidates, ...ignoredDirs]) {
    if (scan.reason !== null) return
    if (--scan.budget < 0) {
      scan.reason = 'too many files to check'
      return
    }
    const full = path.join(project, rel)
    const place: Place = { depth: 0, agents: AGENT_PATH.test(rel), plugin: false }
    if (rel.endsWith('/') || linksToDir(full)) {
      if (RULE_PATH.test(rel)) scanDir(full, scan, place)
      else if (path.basename(full) === '.claude') scanClaudeDir(full, scan)
      else if (!rel.endsWith('/')) walkForClaudeDirs(full, scan)
    } else if (RULE_PATH.test(rel)) {
      checkFile(full, scan, place)
    }
  }
}

/** Every skill, command and agent directory Claude Code reads from a fixed place for a session in `cwd` whose project is `project` (the config directory, each `.claude` from the project up, the managed directories), plus installed plugins. Each directory and file read is stamped, so a clean answer is re-checked on every call. */
function scanFixed(cwd: string, project: string, helpers: HiddenRuleHelpers): ScanResult {
  const scan = newScan(helpers, true)
  const configDir = helpers.configDir()
  const roots = [configDir, ...[cwd, project].flatMap(helpers.selfAndAncestors).map((d) => path.join(d, '.claude')), ...helpers.managedDirs().map((d) => path.join(d, '.claude'))]
  const seen = new Set<string>()
  for (const root of roots) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (seen.has(key)) continue
    seen.add(key)
    scanClaudeDir(root, scan)
  }
  // Installed plugins run from the plugin cache; the marketplace clones and the plugin directory listing beside it only describe plugins, and the listing names PermissionRequest in their descriptions.
  scanDir(path.join(configDir, 'plugins', 'cache'), scan, { depth: 0, agents: false, plugin: true })
  return result(scan)
}

/** The git directory of the checkout rooted at `root`: `.git` itself, or the directory a linked worktree's `.git` file names. */
function gitDirOf(root: string): string {
  const dot = path.join(root, '.git')
  try {
    if (fs.statSync(dot).isDirectory()) return dot
    const line = fs.readFileSync(dot, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'))
    const named = line?.slice('gitdir:'.length).trim()
    return named === undefined || named === '' ? dot : path.resolve(root, named)
  } catch {
    return dot
  }
}

/** Stamp the checkout's index and HEAD, which a pull, checkout, merge, reset or `git add` rewrites, so a skill file that arrives that way drops a clean nested answer at once instead of after the minute. */
function stampGitState(root: string, scan: Scan): void {
  const gitDir = gitDirOf(root)
  for (const name of ['index', 'HEAD']) scan.stamps?.set(path.join(gitDir, name), stamp(path.join(gitDir, name)))
}

/** The directories down to {@link NESTED_STAMP_DEPTH} levels below `project` that hold something git lists, stamped so an untracked skill or `.claude` folder added in one of them drops a clean nested answer at once. Deeper folders keep the minute. */
function stampShallowDirs(project: string, listed: readonly string[], scan: Scan): void {
  const dirs = new Set<string>([project])
  for (const rel of listed) {
    const parts = rel.split('/').filter((part) => part !== '')
    for (let n = 1; n <= Math.min(parts.length - 1, NESTED_STAMP_DEPTH); n++) dirs.add(path.join(project, ...parts.slice(0, n)))
    if (dirs.size >= NESTED_STAMP_DIRS) break
  }
  for (const dir of dirs) scan.stamps?.set(dir, stamp(dir))
}

/** Nested skill directories anywhere under `project`: listed by git inside a checkout, walked outside one. The directories and files it read are stamped like the fixed folders', so a clean answer is dropped the moment one changed, and kept for a minute otherwise (a file git has never listed leaves no stamp). */
function scanNested(project: string, helpers: HiddenRuleHelpers): ScanResult {
  const scan = newScan(helpers, true)
  const root = helpers.selfAndAncestors(project).find((d) => fs.existsSync(path.join(d, '.git')))
  if (root !== undefined) {
    stampGitState(root, scan)
    scanGitCheckout(project, scan)
  } else walkForClaudeDirs(project, scan)
  return result(scan)
}

/** Why the subagent the hook fired in could carry rules the scans did not see: an agent type that is neither built in nor named by a definition they read. */
function agentReason(agentType: string | undefined, scans: readonly ScanResult[]): string | null {
  if (agentType === undefined || BUILTIN_AGENTS.has(agentType)) return null
  const colon = agentType.lastIndexOf(':')
  const known = colon < 0 ? scans.some((s) => s.agents.has(agentType)) : scans.some((s) => s.pluginAgents.has(agentType.slice(colon + 1)))
  return known ? null : `agent ${agentType} not checked`
}

/** Why the session behind this hook could be under a permission rule no settings file shows, or null when every source was read and none adds one. `env` is the hook's environment, which Claude Code builds. The fixed folders are re-stamped on every call and rescanned the moment one changed; the nested search is redone after a minute. */
export function hiddenRuleSource(cwd: string, projectDir: string | undefined, env: NodeJS.ProcessEnv, helpers: HiddenRuleHelpers, query: HiddenRuleQuery = {}): string | null {
  const now = query.now ?? Date.now()
  const processKey = processKeyOf(env)
  const processReasonNow = query.filesOnly === true ? null : processReason(env)
  if (processReasonNow !== null) return processReasonNow
  const here = path.resolve(cwd)
  const project = projectDir !== undefined && path.isAbsolute(projectDir) ? path.resolve(projectDir) : here
  const scanKey = `${processKey}:${here}:${project}`
  // A stale "hidden" only skips a rewrite, so a found reason keeps its minute; a clean answer is trusted only while nothing it read has changed.
  if (fixedCache?.key !== scanKey || (fixedCache.reason !== null ? now - fixedCache.at > SCAN_TTL_MS : !stillCurrent(fixedCache.stamps))) fixedCache = { key: scanKey, at: now, ...scanFixed(here, project, helpers) }
  if (fixedCache.reason !== null) return fixedCache.reason
  if (nestedCache?.key !== scanKey || now - nestedCache.at > SCAN_TTL_MS || (nestedCache.reason === null && !stillCurrent(nestedCache.stamps))) nestedCache = { key: scanKey, at: now, ...scanNested(project, helpers) }
  return nestedCache.reason ?? agentReason(query.agentType, [fixedCache, nestedCache])
}

/** The three questions the rewrite decision asks of the unseen rule sources, bound to the caller's helpers: whether a rule source the hook cannot read could apply to a call in `cwd` for `agentType`, whether the claude command line could, and a read of the claude process ahead of both. */
export function hiddenRules(helpers: HiddenRuleHelpers): {
  readonly hidden: (cwd: string, agentType: string | undefined, filesOnly: boolean) => boolean
  readonly lineRules: () => boolean
  readonly prime: (env: NodeJS.ProcessEnv) => Promise<void>
} {
  return {
    hidden: (cwd, agentType, filesOnly) => hiddenRuleSource(cwd, process.env['CLAUDE_PROJECT_DIR'], process.env, helpers, { agentType, filesOnly }) !== null,
    lineRules: () => commandLineRuleSource(process.env) !== null,
    prime: (env) => primeProcessReason(env),
  }
}
