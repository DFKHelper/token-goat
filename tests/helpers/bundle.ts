import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(HERE, '..', '..')
export const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')
// The code itself. BUNDLE is only a launcher that enables the V8 compile cache before importing this file (see esbuild.config.mjs), so any assertion about what survived bundling -- a symbol being present, a stub being absent -- must read CORE_BUNDLE. Reading BUNDLE for that would pass or fail on a few hundred bytes of launcher that contain none of the product code.
export const CORE_BUNDLE = path.join(ROOT, 'dist', 'token-goat.core.mjs')
// Prefix of the build's hashed code chunks -- must match esbuild.config.mjs's CHUNK_PREFIX. One build emits both entries, so the CLI and the hook library share this single set of chunks.
const CORE_CHUNK_PREFIX = 'token-goat-chunk-'

/** All of the emitted code the core entry can reach, as one string: the entry plus every chunk. The build uses `splitting: true`, so CORE_BUNDLE itself is a few hundred bytes that import the chunks holding the product code. An assertion about what survived bundling -- a symbol being present, a stub being absent -- must therefore read the whole emitted set, not the entry alone, or it fails on every symbol whichever way the code is arranged. */
export function readCoreBundleText(): string {
  const dist = path.join(ROOT, 'dist')
  const parts = [fs.readFileSync(CORE_BUNDLE, 'utf8')]
  for (const f of fs.readdirSync(dist)) {
    if (f.startsWith(CORE_CHUNK_PREFIX)) parts.push(fs.readFileSync(path.join(dist, f), 'utf8'))
  }
  return parts.join('\n')
}
// The in-process hook library bundle (src/hook_lib.ts) -- a sibling of BUNDLE with zero load-time side effects, exporting relayInProcess() for bridges to import() directly instead of spawnSync-ing a second `token-goat hook <event>` process. See esbuild.config.mjs.
export const HOOK_BUNDLE = path.join(ROOT, 'dist', 'token-goat-hook.mjs')

export interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export function tgIsolatedEnv(base: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: base,
    USERPROFILE: base,
    LOCALAPPDATA: base,
    XDG_DATA_HOME: base,
    ...extra,
  }
}

export interface BundleProject {
  readonly root: string
  readonly project: string
  readonly env: NodeJS.ProcessEnv
}

/** A scratch project under a fresh temp root plus the fully isolated env the *_bundle_e2e files spawn the shipped bundle with: TOKEN_GOAT_HOME, data dirs and a throwaway HOME (with its AppData/Roaming created) all under that root, embeddings off. The caller removes `root` when done. */
export function makeBundleProject(prefix: string): BundleProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const project = path.join(root, 'project')
  const home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_DATA_HOME: path.join(root, 'data'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
  return { root, project, env }
}

/** Runs the bundle in `project` under `env` with the 60 s timeout the bundle e2e files use. */
export function bundleTg(project: string, env: NodeJS.ProcessEnv, args: string[]): RunResult {
  return runBundle(args, { cwd: project, env, timeout: 60000 })
}

export function runBundle(
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number },
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts?.cwd,
    env: opts?.env,
    input: opts?.input,
    timeout: opts?.timeout,
    encoding: 'utf8',
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

export function runCli(args: string[], input = ''): RunResult {
  return runBundle(args, { input })
}
