// The built bundle, behind a proxy that resets every connection, asked for semantic readiness. Before model_download_gate.ts the preflight could not see a download that failed, so `--warm` reported "load_error ... Check model integrity" and a plain preflight said "run `token-goat index`": neither was the problem, and both sent the user to a fix that could not work. The unit tests in embed_preflight.test.ts drive explainModelDownload with a hand-made failure record; this one lets the shipping bundle make the real request, record the real failure, and read it back in a second process, which is the path a user actually takes. PROVENANCE: CAPTURE. Dogfooded on node v24.12.0 (win32) with HTTPS_PROXY pointing at a local listener that resets every connection and NODE_USE_ENV_PROXY=1: `semantic --preflight --warm --json` exited 1 with status "missing_model_files" and the message "... failed: GET https://huggingface.co/.../tokenizer.json failed: fetch failed (read ECONNRESET). It is tried again automatically after ...", and a following `semantic --preflight --json` returned the same record. The listener is a child process (tests/helpers/resetting_proxy.ts) rather than a closed port such as 127.0.0.1:9, because a closed loopback port is refused only where the OS answers with a reset: on WSL2 with networkingMode=mirrored and the Windows firewall on, the connect is dropped and times out (probed 2026-10-09: ports 9 and 59999 each hung for 12 s with no answer), so ECONNREFUSED was not a portable expectation. A listener that resets gives ECONNRESET on every platform, and no request leaves the machine.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WARM_COMMAND } from '../src/embed_preflight.js'
import { nodeFetchHonoursEnvProxy } from '../src/env_proxy.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { startResettingProxy, type ResettingProxy } from './helpers/resetting_proxy.js'

let proxy: ResettingProxy
beforeAll(async () => {
  proxy = await startResettingProxy()
})
afterAll(() => proxy.stop())

// Without NODE_USE_ENV_PROXY support fetch would ignore the proxy and go to huggingface.co for real, which a test must not do.
describe.skipIf(!nodeFetchHonoursEnvProxy(process.versions.node))('semantic preflight after a model download that could not connect', () => {
  let base: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'tg-dlfail-'))
    env = tgIsolatedEnv(base, {
      TOKEN_GOAT_HOME: path.join(base, 'tg-home'),
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      NODE_USE_ENV_PROXY: '1',
    })
    for (const k of ['TOKEN_GOAT_MODEL_CACHE_DIR', 'TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_REQUIRE_EMBED_MODEL', 'TOKEN_GOAT_BASH_COMPRESS', 'NO_PROXY', 'no_proxy', 'https_proxy', 'http_proxy']) delete env[k]
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const preflight = (...extra: string[]): Record<string, unknown> => {
    const res = runBundle(['semantic', '--preflight', ...extra, '--json'], { cwd: base, env, timeout: 60_000 })
    expect(res.stdout, res.stderr).toMatch(/^\s*\{/)
    return JSON.parse(res.stdout) as Record<string, unknown>
  }

  it('names the connection failure and the proxy, never an index run or a corrupt model', () => {
    const warmed = preflight('--warm')
    const after = preflight()

    for (const result of [warmed, after]) {
      expect(result['status'], JSON.stringify(result)).toBe('missing_model_files')
      expect(result['available']).toBe(false)
      expect(String(result['message'])).toContain('ECONNRESET')
      expect(String(result['message'])).toMatch(/tried again automatically after \d{4}-/)
      expect(String(result['suggestion'])).toContain('HTTPS_PROXY')
      const everything = JSON.stringify(result)
      expect(everything).not.toMatch(/token-goat index/)
      expect(everything).not.toMatch(/model integrity/i)
    }
    // The second process read the record the first one wrote rather than trying again: the same failure, at the same moment.
    expect(after['message']).toBe(warmed['message'])
  })
})

/** Every download-failures.json under `dir`, wherever dataDir() put it. */
function failureRecords(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((p) => path.basename(p) === 'download-failures.json')
}

// The same dead proxy, on a machine that names it in HTTPS_PROXY but never set NODE_USE_ENV_PROXY, which is the usual state (env_proxy.ts). A process started without the flag cannot use the proxy however it later changes its own environment: Node reads the flag once at startup (CAPTURE, node v24.12.0: setting it in process.env before the first fetch left fetch connecting directly). The inherited TOKEN_GOAT_NO_WORKER_SPAWN=1 from tests/setup/isolate-home.ts keeps the foreground run from starting a real worker, so nothing else writes a failure record while the test looks for one. PROVENANCE: CAPTURE. Dogfooded on node v24.12.0 (win32) with HTTPS_PROXY=http://127.0.0.1:9 and NODE_USE_ENV_PROXY unset: `semantic --preflight --warm --json` reported "fetch failed (connect ECONNREFUSED 127.0.0.1:9)", which only a child started with the flag can produce, and `semantic <query>` printed the worker notice and wrote no download-failures.json.
describe.skipIf(!nodeFetchHonoursEnvProxy(process.versions.node))('semantic behind a proxy the process was not started to use', () => {
  let base: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'tg-dlflag-'))
    env = tgIsolatedEnv(base, { TOKEN_GOAT_HOME: path.join(base, 'tg-home'), HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url })
    for (const k of ['NODE_USE_ENV_PROXY', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_REQUIRE_EMBED_MODEL', 'TOKEN_GOAT_BASH_COMPRESS', 'NO_PROXY', 'no_proxy', 'https_proxy', 'http_proxy']) delete env[k]
    env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  // Without the re-run this process would connect to huggingface.co directly: on a machine with open internet the download then succeeds and the status reads something other than missing_model_files, so the test still fails, only slower.
  it('--warm runs itself again with the flag, so the download goes through the proxy', () => {
    const res = runBundle(['semantic', '--preflight', '--warm', '--json'], { cwd: base, env, timeout: 60_000 })
    expect(res.stdout, res.stderr).toMatch(/^\s*\{/)
    const result = JSON.parse(res.stdout) as Record<string, unknown>
    expect(result['status'], JSON.stringify(result)).toBe('missing_model_files')
    expect(String(result['message'])).toContain('ECONNRESET')
  })

  it('a plain search leaves the download to the worker and records no failure', () => {
    writeFileSync(path.join(base, 'auth.ts'), 'export function refreshCredential(id: string): string {\n  return id\n}\n')
    const res = runBundle(['semantic', 'refresh a credential'], { cwd: base, env, timeout: 60_000 })
    expect(res.stderr).toContain('background worker downloads it')
    expect(res.stderr).toContain(WARM_COMMAND)
    expect(failureRecords(base)).toEqual([])
  })
})
