/** Semantic search works on a default install: no `onnxruntime-node`, embeddings computed by the bundled WebAssembly build of ONNX Runtime. Driven through the built bundle, copied out of the repository into a temporary directory, because inside the repository the devDependency `onnxruntime-node` always resolves and embed_runtime.ts always prefers it, so no in-repo run can reach the WebAssembly path the way a user's install does. The copy carries what a published install carries and nothing more that could resolve the native runtime: dist/ (bundle, chunks and the glue module the build copies beside them), the one runtime dependency, and `sqlite-vec` with its platform package, the optional dependency vector storage needs. `NODE_PATH` is dropped from the child's environment, since it would reach a globally installed onnxruntime-node from anywhere (measured on the development machine this was written on, where it does). Whether all that worked is not assumed: the run asserts, through `semantic --preflight`, `doctor` and the stored provenance stamp, that the WebAssembly build is the one that embedded. Offline throughout. The model weights and the `.wasm` come from the shared model cache (TOKEN_GOAT_MODEL_CACHE_DIR, or this machine's own model directory, which has the same layout), each held to its pin on the way in, so the only network-shaped thing exercised is the verified copy. The download itself is exercised by `npm run model:warm`, which CI runs before the suite, and its refusals by tests/embed_runtime_pins.test.ts. HAND-DERIVED fixture: two notes, and a query sharing no word with either, so keyword search cannot find the right one (the control run proves it) and the ranking has to come from meaning. */
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dataDir } from '../src/constants.js'
import { modelFilesPresent } from '../src/embed_model.js'
import { ORT_WEB_VERSION, wasmBinaryPresent } from '../src/embed_runtime.js'
import Database from '../src/sqlite_driver.js'

import { ROOT } from './helpers/bundle.js'

/** vec0 has to load for vectors to be stored at all; an absent sqlite-vec is a platform skip, the same gate tests/semantic_embeddings_e2e.test.ts uses. */
function vec0Works(): boolean {
  try {
    const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

/** Where the child copies the pinned files from. The model directory has the shared cache's layout (`<root>/<org>/<model>/<revision>`, `<root>/onnxruntime-web/<version>`), so it serves as one when no shared cache is configured. */
const SHARED_CACHE = process.env['TOKEN_GOAT_MODEL_CACHE_DIR']?.trim() || path.join(dataDir(), 'models')
const canRun = vec0Works() && modelFilesPresent() && wasmBinaryPresent()

const FILES: Record<string, string> = {
  'brewing.md': '# Brewing\n\nSteep coarse grounds in chilled water for eighteen hours, then filter through paper.\n',
  'gardening.md': '# Gardening\n\nTomatoes need full sun and deep watering twice a week.\n',
}
const QUERY = 'how long should iced coffee soak'

let root: string
let pkg: string
let project: string
let home: string

function copyPackage(name: string): void {
  fs.cpSync(path.join(ROOT, 'node_modules', name), path.join(pkg, 'node_modules', name), { recursive: true, dereference: true })
}

function run(args: string[], extra: NodeJS.ProcessEnv = {}, dataHome: string = home): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dataHome,
    USERPROFILE: dataHome,
    LOCALAPPDATA: dataHome,
    XDG_DATA_HOME: dataHome,
    TOKEN_GOAT_HOME: path.join(dataHome, '.token-goat'),
    CLAUDE_CONFIG_DIR: path.join(dataHome, '.claude'),
    TOKEN_GOAT_NO_WORKER: '1',
    TOKEN_GOAT_OFFLINE: '1',
    TOKEN_GOAT_MODEL_CACHE_DIR: SHARED_CACHE,
    TOKEN_GOAT_EMBEDDINGS_ENABLED: 'true',
    ...extra,
  }
  delete env['NODE_PATH']
  const res = spawnSync(process.execPath, [path.join(pkg, 'dist', 'token-goat.mjs'), ...args], { cwd: project, env, encoding: 'utf8', timeout: 120_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Every file called `name` under the isolated data root; the layout differs per platform, so it is found rather than spelled. */
function filesNamed(dir: string, name: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) out.push(path.join(entry.parentPath, entry.name))
  }
  return out
}

describe.skipIf(!canRun)('semantic on the bundled WebAssembly runtime, from an install with no onnxruntime-node', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wasm-e2e-'))
    pkg = path.join(root, 'pkg')
    project = path.join(root, 'project')
    home = path.join(root, 'home')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(project, name), text)

    fs.cpSync(path.join(ROOT, 'dist'), path.join(pkg, 'dist'), { recursive: true, filter: (src) => path.basename(src) !== 'native' })
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of Object.keys(manifest.dependencies ?? {})) copyPackage(name)
    copyPackage('sqlite-vec')
    const vecManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'sqlite-vec', 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
    for (const name of Object.keys(vecManifest.optionalDependencies ?? {})) {
      if (fs.existsSync(path.join(ROOT, 'node_modules', name))) copyPackage(name)
    }
  }, 60_000)

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  })

  it('cannot resolve onnxruntime-node from where the copied bundle sits, so the run below cannot reach it', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env['NODE_PATH']
    const probe = spawnSync(process.execPath, ['-e', "try { require.resolve('onnxruntime-node'); console.log('resolved') } catch { console.log('absent') }"], { cwd: path.join(pkg, 'dist'), env, encoding: 'utf8' })
    expect(probe.stdout.trim()).toBe('absent')
  })

  it('control: keyword search alone does not find the note', () => {
    const idx = run(['index', '.', '--walk'], { TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' })
    expect(idx.status, idx.stderr).toBe(0)
    const r = run(['semantic', QUERY], { TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' })
    expect(r.stdout).not.toContain('brewing.md')
  }, 120_000)

  it('embeds on the WebAssembly build, stamps the vectors with it, and finds the note by meaning', () => {
    const idx = run(['index', '.', '--walk'])
    expect(idx.status, idx.stderr).toBe(0)

    const r = run(['semantic', QUERY])
    expect(r.status, r.stderr).toBe(0)
    const first = r.stdout.split('\n').find((line) => line.startsWith('# 1.'))
    expect(first, r.stdout).toContain('brewing.md')

    const preflight = run(['semantic', '--preflight'])
    expect(preflight.stdout).toContain(`ONNX runtime (onnxruntime-web): available (${ORT_WEB_VERSION})`)
    expect(preflight.stdout).toContain('Runtime binary (ort-wasm-simd-threaded.wasm, ~14 MB): downloaded')

    const doctor = run(['doctor'])
    expect(doctor.stdout).toMatch(new RegExp(`Embeddings: available \\(bundled WebAssembly runtime, onnxruntime-web ${ORT_WEB_VERSION.replaceAll('.', '\\.')}; runtime binary downloaded\\)`))

    const dbs = filesNamed(home, 'global.db')
    expect(dbs).toHaveLength(1)
    const db = new Database(dbs[0]!, { readonly: true })
    try {
      const stamp = db.prepare('SELECT provenance FROM embedding_provenance WHERE id = 1').pluck().get() as string
      expect(stamp).toContain(`/onnxruntime-web@${ORT_WEB_VERSION.split('.').slice(0, 2).join('.')}/`)
      expect(stamp).not.toContain('onnxruntime-node')
    } finally {
      db.close()
    }
  }, 240_000)

  it('holds a failure to start against later processes, so preflight and doctor report it, until Node or its flags change', () => {
    // `--jitless` turns WebAssembly off, so the bundled runtime cannot start, while every other step (the copy of the pinned binary, the model) succeeds. Its own data root, so nothing the test above stored is in play. CAPTURE: "no available backend found" is the prefix of what onnxruntime-web 1.30.0 threw when `node --jitless` created a session on this machine ("no available backend found. ERR: [wasm] Error: WebAssembly SIMD is not supported in the current environment., [cpu] Error: previous call to 'initWasm()' failed."), not a string read off our own matcher.
    const failedHome = path.join(root, 'home-jitless')
    fs.mkdirSync(failedHome, { recursive: true })
    const jitless = { NODE_OPTIONS: '--jitless' }

    const idx = run(['index', '.', '--walk'], jitless, failedHome)
    expect(idx.status, idx.stderr).toBe(0)

    // A second process, which never starts the runtime, has to learn of the failure from the first.
    const preflight = run(['semantic', '--preflight'], jitless, failedHome)
    const reported = preflight.stdout + preflight.stderr
    expect(reported).toContain('Semantic embedding status: MISSING_RUNTIME')
    expect(reported).toContain('ONNX runtime (onnxruntime-web): unavailable')
    expect(reported).toContain('no available backend found')
    expect(reported).toContain('in an earlier run')

    const doctor = run(['doctor'], jitless, failedHome)
    expect(doctor.stdout, doctor.stderr).toMatch(/Embeddings: unavailable, so semantic falls back to keyword search: the bundled WebAssembly runtime, onnxruntime-web [\d.]+ failed to start \(no available backend found/)
    expect(filesNamed(failedHome, 'start-failure.json')).toHaveLength(1)

    // Without the flag the key differs, so the record does not apply and the runtime starts. The record still describes `--jitless`, so it stays.
    const fixed = run(['semantic', '--preflight'], {}, failedHome)
    expect(fixed.stdout + fixed.stderr).toContain(`ONNX runtime (onnxruntime-web): available (${ORT_WEB_VERSION})`)
    const reindex = run(['index', '.', '--walk', '--force'], {}, failedHome)
    expect(reindex.status, reindex.stderr).toBe(0)
    const found = run(['semantic', QUERY], {}, failedHome)
    expect(found.stdout.split('\n').find((line) => line.startsWith('# 1.')), found.stdout).toContain('brewing.md')
    const [record] = filesNamed(failedHome, 'start-failure.json')
    expect(record).toBeDefined()
    const still = run(['semantic', '--preflight'], jitless, failedHome)
    expect(still.stdout + still.stderr).toContain('ONNX runtime (onnxruntime-web): unavailable')

    // A record under this run's own key that has outlived its day is not held against it, and the start that follows removes it. The key is rewritten to the one a run without the flag presents: NODE_OPTIONS is its last element (startFailureKey in src/embed_runtime.ts).
    const stored = JSON.parse(fs.readFileSync(record!, 'utf8')) as { key: string; message: string; at: number }
    const key = JSON.parse(stored.key) as unknown[]
    expect(key.at(-1)).toBe('--jitless')
    key[key.length - 1] = ''
    const dayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1000
    fs.writeFileSync(record!, JSON.stringify({ ...stored, key: JSON.stringify(key), at: dayAndAnHourAgo }))
    const lapsed = run(['index', '.', '--walk', '--force'], {}, failedHome)
    expect(lapsed.status, lapsed.stderr).toBe(0)
    expect(filesNamed(failedHome, 'start-failure.json')).toHaveLength(0)
  }, 240_000)

  it('keys a failure in the resident server to the flags the server runs under, not those of the caller it served', async () => {
    // The server answers `semantic` with its caller's environment swapped in, but V8 runs under the flags the server started with. Started under `--jitless`, it fails to start the runtime for a caller without the flag, and that failure belongs to `--jitless`: a caller without it, running on its own, can embed.
    const serverHome = path.join(root, 'home-server')
    fs.mkdirSync(serverHome, { recursive: true })
    const on = { TOKEN_GOAT_HOOK_SERVER: '1' }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: serverHome, USERPROFILE: serverHome, LOCALAPPDATA: serverHome, XDG_DATA_HOME: serverHome, TOKEN_GOAT_HOME: path.join(serverHome, '.token-goat'), CLAUDE_CONFIG_DIR: path.join(serverHome, '.claude'), TOKEN_GOAT_NO_WORKER: '1', TOKEN_GOAT_OFFLINE: '1', TOKEN_GOAT_MODEL_CACHE_DIR: SHARED_CACHE, TOKEN_GOAT_EMBEDDINGS_ENABLED: 'true', NODE_OPTIONS: '--jitless', ...on }
    delete env['NODE_PATH']
    const server = spawn(process.execPath, [path.join(pkg, 'dist', 'token-goat.mjs'), 'hook-server', 'run', '--slot', '0'], { cwd: project, env, stdio: 'ignore' })
    const exited = new Promise((resolve) => server.once('exit', resolve))
    try {
      const deadline = Date.now() + 30_000
      const served = (): number | undefined => {
        const status = run(['hook-server', 'status', '--json'], { TOKEN_GOAT_HOOK_SERVER: '0' }, serverHome)
        return (JSON.parse(status.stdout || '[]') as { slot: number; served: number }[]).find((s) => s.slot === 0)?.served
      }
      while (served() === undefined) {
        if (Date.now() > deadline) throw new Error('the hook server did not come up')
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      const before = served() ?? 0
      // Keyword search finds nothing for this query (the control above), so the exit status says nothing here.
      const warm = run(['semantic', QUERY], on, serverHome)
      expect(served(), 'the query was answered in this process instead of by the server').toBeGreaterThan(before)
      expect(warm.stdout + warm.stderr).toContain('no available backend found')
      expect(filesNamed(serverHome, 'start-failure.json')).toHaveLength(1)

      const alone = run(['semantic', '--preflight'], { TOKEN_GOAT_HOOK_SERVER: '0' }, serverHome)
      expect(alone.stdout + alone.stderr).toContain(`ONNX runtime (onnxruntime-web): available (${ORT_WEB_VERSION})`)
    } finally {
      run(['hook-server', 'stop'], { TOKEN_GOAT_HOOK_SERVER: '0' }, serverHome)
      if (server.exitCode === null) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
        server.kill()
      }
    }
  }, 240_000)
})
