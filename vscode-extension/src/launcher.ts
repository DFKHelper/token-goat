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
      // stat rather than access: access answers yes for a directory too, so a PATH entry holding a
      // directory called `node.exe` ended the scan and returned it as the executable, and the real
      // one further along PATH was never reached. stat follows symlinks, which is what a POSIX npm
      // bin entry is, so the ordinary case is unaffected and a dangling link is skipped rather than
      // returned for a spawn to fail on later.
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch {
      // Not in this PATH entry, keep scanning.
    }
  }
  return null
}

// Parses an npm-generated .cmd shim's static text to find the real script it launches, resolving its dp0 token against the shim's own directory. npm >= 7's shim sets a `dp0` variable via `SET dp0=%~dp0` and then references it as plain `%dp0%` in the launch line, but pnpm and yarn classic both write the tilde form (`%~dp0`) directly into the launch line itself, with no intermediate variable at all -- both dialects are handled here. Exported separately so the regex/resolution logic is unit-testable without touching the filesystem.
export function parseShimScriptPath(shimText: string, shimDir: string): string | null {
  const match = /"([^"]*\.(?:mjs|cjs|js))"\s+%\*/i.exec(shimText)
  if (!match) return null
  // .cmd shims and their %dp0%/%~dp0 tokens are Windows-only syntax with backslash-separated
  // paths, regardless of which OS this function runs on (production only calls it when
  // process.platform === 'win32', but the tests exercise it directly on every CI platform to
  // keep shim-format parsing coverage host-independent). path.win32 is used explicitly here
  // instead of the platform-default path module so normalization and the dp0 separator are
  // always backslash-correct, never POSIX-forward-slash-correct.
  // A plain string replacement is not safe here: JavaScript expands $&, $$ and friends inside
  // the *replacement* text, so a bin directory whose own name contains one of those sequences
  // would be rewritten into a path that does not exist. A replacer function is handed the text
  // verbatim, so the directory reaches the path exactly as the filesystem spells it.
  return path.win32.normalize(match[1].replace(/%~?dp0%?/gi, () => `${shimDir}\\`))
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
  // A standard npm/pnpm/yarn global install puts a symlink on PATH pointing at the real JS
  // entrypoint, which is what makes launching it as `node <resolved path>` below work at all.
  // That assumption breaks for other Node version managers: Volta puts a compiled binary shim
  // on PATH (not a symlink to JS at all), and asdf puts a bash script shim there. Feeding either
  // straight to node as a script produces a baffling SyntaxError instead of naming the real
  // problem, so resolve the real target and verify it is actually JavaScript node can run.
  const resolved = await fs.realpath(binPath).catch(() => binPath)
  if (!(await isNodeExecutableScript(resolved))) {
    throw new Error(
      `Found 'token-goat' on PATH at ${binPath} (resolves to ${resolved}), but it is not a JavaScript file node can run directly. This usually means a Node version manager (Volta, asdf) put a compiled binary or shell-script shim on PATH instead of a symlink to the real entrypoint. Try a plain npm global install (npm install -g token-goat) so PATH resolves straight to the JS entrypoint, or locate the real script yourself (often under a node_modules/token-goat/dist path) and put its directory ahead of the shim on PATH.`,
    )
  }
  cachedEntrypoint = resolved
  return resolved
}

// True when node can run `filePath` directly as a script: either its extension already marks it
// as JavaScript, or its first line is a shebang naming node. False for a compiled binary (Volta)
// or a shell script (asdf), which would otherwise reach node as a script and fail with a
// SyntaxError that names nothing about the real cause.
async function isNodeExecutableScript(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return true
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    return /^#!.*\bnode\b/.test(firstLine)
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

// Defense in depth beyond the array-argv launch below: a segment starting with '-' could be reinterpreted as a CLI flag by token-goat's own argument parser, and one containing a NUL or newline could confuse argv handling on some platforms.
export function assertSafeArgSegment(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is empty.`)
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains a control character token-goat cannot pass safely.`)
  if (value.startsWith('-')) throw new Error(`${label} starts with '-' and could be mistaken for a flag.`)
}

// A cached first-hit scan of PATH. resolveGitExecutable and resolveNodeExecutable below were the
// same fifteen lines twice over -- a module-level cache cell, a platform-dependent candidate list,
// a first-hit loop -- differing only in what to do when the scan comes up empty. One copy means a
// change to how PATH is searched reaches both, rather than reaching whichever one was edited.
interface CachedPathLookup {
  /** First candidate found on PATH, or null when none of them is there. */
  resolve: () => Promise<string | null>
  /** Seeds the cache with a caller-chosen fallback, so a fruitless scan is not repeated. */
  adopt: (value: string) => string
  reset: () => void
}

function cachedPathLookup(candidates: () => string[]): CachedPathLookup {
  let cached: string | null = null
  return {
    resolve: async () => {
      if (cached !== null) return cached
      for (const name of candidates()) {
        const found = await findOnPath(name)
        if (found !== null) {
          cached = found
          return found
        }
      }
      return null
    },
    adopt: (value) => {
      cached = value
      return value
    },
    reset: () => {
      cached = null
    },
  }
}

// The candidate list is rebuilt per call rather than captured once, because tests stub
// process.platform between cases and a list frozen at module load would not follow.
const gitExecutable = cachedPathLookup(() => (process.platform === 'win32' ? ['git.exe'] : ['git']))

// Exposed for tests only: resets the module-level git-executable cache between cases.
export function resetGitExecutableCacheForTests(): void {
  gitExecutable.reset()
}

// Same hijack this whole module exists to close, one command over: 'git diff HEAD' run through a shell with cwd set to the workspace root lets a hostile repo shipping git.cmd/git.exe/git.bat at its own root get executed instead of the real git, because cmd.exe searches the current directory before PATH. Resolving git's absolute path off PATH ourselves and invoking it with shell:false removes that search entirely, the same fix already applied to token-goat.cmd above. On win32 only 'git.exe' is accepted: execFile still routes a .cmd/.bat target through cmd.exe even with shell:false (the CERT/CC VU#123335 class), which would reopen the exact shell-parsing surface this module exists to close for the workspace-derived -C argument runGitDiff passes. Git for Windows ships git.exe; if only a git.cmd wrapper is on PATH, that is not a real git binary this module can safely invoke.
export async function resolveGitExecutable(): Promise<string> {
  const found = await gitExecutable.resolve()
  if (found !== null) return found
  throw new Error(
    process.platform === 'win32'
      ? "Could not find git.exe on PATH. token-goat will not invoke a git.cmd/git.bat wrapper, since execFile still routes those through cmd.exe even with shell:false. Install Git for Windows (which provides git.exe) and reload the window."
      : 'Could not find a git executable on PATH.',
  )
}

const nodeExecutable = cachedPathLookup(() => (process.platform === 'win32' ? ['node.exe'] : ['node']))

// Exposed for tests only: resets the module-level node-executable cache between cases.
export function resetNodeExecutableCacheForTests(): void {
  nodeExecutable.reset()
}

// Prefer a real Node runtime on PATH over process.execPath (Electron in VS Code).
// Native addons (like better-sqlite3) fail under Electron when run with ELECTRON_RUN_AS_NODE
// due to Node ABI version mismatch between Electron and native npm modules.
// The fallback is adopted into the cache rather than merely returned, so a host with no node on
// PATH does not rescan every PATH entry on every single CLI invocation.
export async function resolveNodeExecutable(): Promise<string> {
  return (await nodeExecutable.resolve()) ?? nodeExecutable.adopt(process.execPath)
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; maxBuffer: number; windowsHide: boolean; shell: false; env: NodeJS.ProcessEnv },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

// Runs a resolved binary and captures its stdout, with the launch options every call in this module
// must share. They are stated once here rather than at each call site because they are the whole
// point of the module: `shell: false` plus an already-resolved absolute path is what keeps a
// workspace-controlled string out of a shell, and a third call site that restated the options by
// hand could quietly omit it. `prepare` is a callback rather than a value so binary resolution
// (which is async and can reject) happens inside the promise and its rejection reaches the caller.
interface ExecSpec {
  file: string
  args: readonly string[]
  maxBuffer: number
  env: NodeJS.ProcessEnv
  // Each command explains its own failure in its own terms, so the message is theirs to build.
  describeError: (error: ExecFileException, stderr: string) => string
  // git diff's output is whitespace-significant; token-goat's single-value output is not.
  transform: (stdout: string) => string
}

function execCapturing(prepare: () => Promise<ExecSpec>, execFileImpl: ExecFileLike): Promise<string> {
  return new Promise((resolve, reject) => {
    void prepare().then((spec) => {
      // execFile validates its arguments synchronously and throws, rather than calling back, for a
      // NUL byte in one of them. Thrown from inside this callback the error would reject the
      // discarded chained promise instead of this one, so the caller waited forever on a promise
      // that could never settle while the failure surfaced only as an unhandled rejection.
      try {
        execFileImpl(
          spec.file,
          spec.args,
          { encoding: 'utf8', maxBuffer: spec.maxBuffer, windowsHide: true, shell: false, env: spec.env },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(spec.describeError(error, stderr)))
              return
            }
            resolve(spec.transform(stdout))
          },
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }, reject)
  })
}

// projectRoot conveys a project root to token-goat's own --cwd flag (an explicit argument) rather than by setting the spawned process's working directory to it: an attacker-controlled workspace directory must never be a directory a launcher resolves a binary name against, and this way it never is one — the process cwd stays wherever the extension host itself runs from. execFileImpl is injectable so tests can assert on the constructed call without actually spawning a process.
export function runTokenGoat(args: string[], projectRoot?: string, execFileImpl: ExecFileLike = execFile): Promise<string> {
  return execCapturing(async () => {
    const [entrypoint, nodePath] = await Promise.all([resolveTokenGoatEntrypoint(), resolveNodeExecutable()])
    const fullArgs = projectRoot !== undefined ? ['--cwd', projectRoot, ...args] : args
    return {
      file: nodePath,
      args: [entrypoint, ...fullArgs],
      maxBuffer: 4 * 1024 * 1024,
      // Electron's own binary is used as process.execPath in the extension host; this env var makes it behave as a plain Node runtime instead of relaunching as an Electron app.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      describeError: (error, stderr) => stderr.trim() || `token-goat exited with code ${error.code ?? 'unknown'}`,
      transform: (stdout) => stdout.trim(),
    }
  }, execFileImpl)
}

// repoPath is passed to git's own -C flag (an explicit argument), never as the spawned process's cwd, for the same reason projectRoot above is passed to token-goat via --cwd rather than via cwd: an attacker-controlled workspace directory must never be a directory a launcher resolves a binary name against. execFileImpl is injectable so tests can assert on the constructed call without actually spawning a process.
export function runGitDiff(repoPath: string, execFileImpl: ExecFileLike = execFile): Promise<string> {
  return execCapturing(async () => ({
    file: await resolveGitExecutable(),
    // --no-ext-diff and --no-textconv because a repository configures both in its own .git/config:
    // a `diff.<name>.textconv` or `diff.external` entry names a program git runs while producing the
    // diff. Resolving git's own path and launching it without a shell does nothing about that, since
    // it is git itself doing the launching. Reading a diff to send to chat needs neither.
    args: ['-C', repoPath, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
    describeError: (_error, stderr) => stderr.trim() || 'git diff failed — is this a git repository?',
    transform: (stdout) => stdout,
  }), execFileImpl)
}
