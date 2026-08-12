// Launches token-goat without a shell and without a workspace-controlled cwd. No import of 'vscode' here so this module is unit-testable without the extension host.
import { execFile, type ExecFileException } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Resolved absolute path to token-goat's own JS entrypoint, cached after the first successful lookup so every command after that skips the PATH scan.
let cachedEntrypoint: string | null = null

// Exposed for tests only: resets the module-level entrypoint cache between cases.
export function resetEntrypointCacheForTests(): void {
  cachedEntrypoint = null
}

// Scans PATH by hand instead of asking a shell to find the file: a shell lookup on Windows consults the current directory before PATH (unless NoDefaultCurrentDirectoryInExePath is set), which is exactly the hijack this file exists to avoid. This search only ever touches PATH directories.
export async function findOnPath(filename: string, pathEnv = process.env.PATH ?? process.env.Path ?? ''): Promise<string | null> {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, filename)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Not in this PATH entry, keep scanning.
    }
  }
  return null
}

// Parses an npm-generated .cmd shim's static text to find the real script it launches, resolving its %dp0% token against the shim's own directory. Exported separately so the regex/resolution logic is unit-testable without touching the filesystem.
export function parseShimScriptPath(shimText: string, shimDir: string): string | null {
  const match = /"([^"]*\.(?:mjs|cjs|js))"\s+%\*/i.exec(shimText)
  if (!match) return null
  return path.normalize(match[1].replace(/%dp0%/gi, `${shimDir}${path.sep}`))
}

// Resolves token-goat's real Node entrypoint so it can be launched directly by process.execPath with an array argv and shell:false. execFile alone is not enough on Windows: a .cmd/.bat target is still routed through cmd.exe even with shell:false (CERT/CC VU#123335), which reopens the same injection surface this file is fixing. On win32 the npm-generated token-goat.cmd shim is a static text file that names the real script it launches (relative to its own directory via %dp0%); we read that text and extract the script path instead of executing the shim. On other platforms the PATH-resolved binary is already the real script (an npm bin symlink to the JS entrypoint with a shebang line, which node ignores when given the file directly), so no shim-unwrapping is needed.
export async function resolveTokenGoatEntrypoint(): Promise<string> {
  if (cachedEntrypoint !== null) return cachedEntrypoint
  if (process.platform === 'win32') {
    const shimPath = await findOnPath('token-goat.cmd')
    if (!shimPath) {
      throw new Error('Could not find token-goat.cmd on PATH. Install token-goat globally (npm install -g token-goat) and reload the window.')
    }
    const shimText = await fs.readFile(shimPath, 'utf8')
    const scriptPath = parseShimScriptPath(shimText, path.dirname(shimPath))
    if (scriptPath === null) {
      throw new Error(`Could not determine which script token-goat.cmd launches (unrecognized shim format at ${shimPath}).`)
    }
    try {
      await fs.access(scriptPath)
    } catch {
      throw new Error(`token-goat.cmd points at a script that does not exist: ${scriptPath}`)
    }
    cachedEntrypoint = scriptPath
    return scriptPath
  }
  const binPath = await findOnPath('token-goat')
  if (!binPath) {
    throw new Error('Could not find the token-goat executable on PATH. Install it globally (npm install -g token-goat) and reload the window.')
  }
  cachedEntrypoint = binPath
  return binPath
}

// Defense in depth beyond the array-argv launch below: a segment starting with '-' could be reinterpreted as a CLI flag by token-goat's own argument parser, and one containing a NUL or newline could confuse argv handling on some platforms.
export function assertSafeArgSegment(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is empty.`)
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains a control character token-goat cannot pass safely.`)
  if (value.startsWith('-')) throw new Error(`${label} starts with '-' and could be mistaken for a flag.`)
}

// Resolved absolute path to a git executable, cached after the first successful lookup.
let cachedGitExecutable: string | null = null

// Exposed for tests only: resets the module-level git-executable cache between cases.
export function resetGitExecutableCacheForTests(): void {
  cachedGitExecutable = null
}

// Same hijack this whole module exists to close, one command over: 'git diff HEAD' run through a shell with cwd set to the workspace root lets a hostile repo shipping git.cmd/git.exe/git.bat at its own root get executed instead of the real git, because cmd.exe searches the current directory before PATH. Resolving git's absolute path off PATH ourselves and invoking it with shell:false removes that search entirely, the same fix already applied to token-goat.cmd above.
export async function resolveGitExecutable(): Promise<string> {
  if (cachedGitExecutable !== null) return cachedGitExecutable
  const candidates = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  for (const name of candidates) {
    const found = await findOnPath(name)
    if (found !== null) {
      cachedGitExecutable = found
      return found
    }
  }
  throw new Error('Could not find a git executable on PATH.')
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; maxBuffer: number; windowsHide: boolean; shell: false; env: NodeJS.ProcessEnv },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

// projectRoot conveys a project root to token-goat's own --cwd flag (an explicit argument) rather than by setting the spawned process's working directory to it: an attacker-controlled workspace directory must never be a directory a launcher resolves a binary name against, and this way it never is one — the process cwd stays wherever the extension host itself runs from. execFileImpl is injectable so tests can assert on the constructed call without actually spawning a process.
export function runTokenGoat(args: string[], projectRoot?: string, execFileImpl: ExecFileLike = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    void resolveTokenGoatEntrypoint().then((entrypoint) => {
      const fullArgs = projectRoot !== undefined ? ['--cwd', projectRoot, ...args] : args
      execFileImpl(
        process.execPath,
        [entrypoint, ...fullArgs],
        {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          shell: false,
          // Electron's own binary is used as process.execPath in the extension host; this env var makes it behave as a plain Node runtime instead of relaunching as an Electron app.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        callback,
      )
    }, reject)

    function callback(error: ExecFileException | null, stdout: string, stderr: string): void {
      if (error) {
        reject(new Error(stderr.trim() || `token-goat exited with code ${error.code ?? 'unknown'}`))
        return
      }
      resolve(stdout.trim())
    }
  })
}

// repoPath is passed to git's own -C flag (an explicit argument), never as the spawned process's cwd, for the same reason projectRoot above is passed to token-goat via --cwd rather than via cwd: an attacker-controlled workspace directory must never be a directory a launcher resolves a binary name against. execFileImpl is injectable so tests can assert on the constructed call without actually spawning a process.
export function runGitDiff(repoPath: string, execFileImpl: ExecFileLike = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    void resolveGitExecutable().then((gitPath) => {
      execFileImpl(
        gitPath,
        ['-C', repoPath, 'diff', 'HEAD'],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          shell: false,
          env: process.env,
        },
        callback,
      )
    }, reject)

    function callback(error: ExecFileException | null, stdout: string, stderr: string): void {
      if (error) {
        reject(new Error(stderr.trim() || 'git diff failed — is this a git repository?'))
        return
      }
      resolve(stdout)
    }
  })
}
