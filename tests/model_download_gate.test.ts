/** A failed model download is remembered on disk, so the next caller waits it out instead of repeating it (src/model_download_gate.ts, enforced in src/pinned_fetch.ts). Before it, nothing was remembered: with the network blocked, a worker draining 30 files asked huggingface.co for the tokenizer 30 times and logged 60 lines in 25 s, and every log line said only "fetch failed" because the cause (ECONNREFUSED, the proxy's address) was dropped. Why didn't a test catch this: every download test stubbed `fetch` for exactly one call and asserted on that call's error, so no test ever made a second call after a failure, which is where the cost was. These drive the real `ensureModelFiles` repeatedly against one data directory. PROVENANCE: CAPTURE for the rejection shape. node v24.12.0, `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 node -e "fetch('https://huggingface.co/')"` rejects with TypeError('fetch failed') whose `cause` is an Error with code 'ECONNREFUSED' and message 'connect ECONNREFUSED 127.0.0.1:9'. HAND-DERIVED for the hold arithmetic (10 min doubling per consecutive failure, capped at 1 h) and for the 403/503 responses. The tokenizer bytes are the genuine pinned file (tests/fixtures/wordpiece/tokenizer.json.gz), as in tests/embed_model.test.ts. */
import { spawn } from 'node:child_process'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { ensureModelFiles } from '../src/embed_model.js'
import {
  DownloadCooldownError,
  MODEL_DOWNLOAD_HOST,
  activeDownloadCooldown,
  describeCause,
  downloadFailureRecordPath,
  downloadHoldMs,
  failedAtOf,
  lastDownloadFailure,
  recordDownloadFailure,
  withExplicitDownload,
} from '../src/model_download_gate.js'
import { setPinnedRetryDelayForTesting } from '../src/pinned_fetch.js'
import { clearModuleCaches } from '../src/reset.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL_TOKENIZER: Buffer = zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'fixtures', 'wordpiece', 'tokenizer.json.gz')))

const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR'] as const
const MINUTE = 60 * 1000

let tmp: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-download-gate-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['LOCALAPPDATA'] = tmp
  process.env['XDG_DATA_HOME'] = tmp
  delete process.env['TOKEN_GOAT_OFFLINE']
  // A shared cache would answer the tokenizer from disk, and every assertion here is about what reaches the network.
  delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  setPinnedRetryDelayForTesting(0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setPinnedRetryDelayForTesting(null)
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The rejection Node's fetch gives when the proxy it was told to use refuses the connection (see PROVENANCE). */
function refused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect', address: '127.0.0.1', port: 9 })
  return new TypeError('fetch failed', { cause })
}

function stubFetch(handler: (url: string, call: number) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    return handler(url, urls.length)
  })
  return { urls }
}

const body = (bytes: Uint8Array): Response => new Response(bytes as unknown as BodyInit, { status: 200 })

describe('a download that cannot reach the host', () => {
  it('retries the connection, then records the failure with its cause and throws it', async () => {
    const { urls } = stubFetch(() => {
      throw refused()
    })
    const err: unknown = await ensureModelFiles().catch((e: unknown) => e)
    expect(String(err)).toContain('connect ECONNREFUSED 127.0.0.1:9')
    expect(urls, 'three attempts at the first file, then stop').toHaveLength(3)
    expect(new Set(urls).size).toBe(1)
    expect(new URL(urls[0]!).host, 'the host the gate is keyed on is the one the model is fetched from').toBe(MODEL_DOWNLOAD_HOST)

    const record = lastDownloadFailure()
    expect(record).toMatchObject({ failures: 1, url: urls[0] })
    expect(record!.message).toContain('ECONNREFUSED')
    expect(failedAtOf(err), 'the error carries the time of the failure it recorded').toBe(record!.at)
  })

  it('does not reach the network again while the failure is held, and says when it will', async () => {
    const { urls } = stubFetch(() => {
      throw refused()
    })
    await expect(ensureModelFiles()).rejects.toThrow(/ECONNREFUSED/)
    const before = urls.length

    const err: unknown = await ensureModelFiles().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DownloadCooldownError)
    expect(urls, 'a held failure makes no request at all').toHaveLength(before)
    const held = err as DownloadCooldownError
    expect(held.message).toContain('ECONNREFUSED')
    expect(held.retryAt - held.failedAt).toBe(10 * MINUTE)
    expect(failedAtOf(err), 'the held error names the same failure, so a log can tell it is not a new one').toBe(lastDownloadFailure()!.at)
    expect(lastDownloadFailure()!.failures, 'being turned away is not another failure').toBe(1)
  })

  it('lets a download the user asked for go through the hold, and counts its failure', async () => {
    const { urls } = stubFetch(() => {
      throw refused()
    })
    await expect(ensureModelFiles()).rejects.toThrow(/ECONNREFUSED/)
    await expect(withExplicitDownload(() => ensureModelFiles())).rejects.toThrow(/ECONNREFUSED/)
    expect(urls).toHaveLength(6)
    expect(lastDownloadFailure()!.failures).toBe(2)
    expect(activeDownloadCooldown()!.retryAt - lastDownloadFailure()!.at).toBe(20 * MINUTE)
  })

  it('forgets the failure as soon as a download succeeds', async () => {
    recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/x`, 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)')
    const { urls } = stubFetch((url) => (url.endsWith('tokenizer.json') ? body(REAL_TOKENIZER) : body(new Uint8Array(0))))
    // The onnx file gets an empty body, which is a wrong file rather than an unreachable host: it fails without being remembered.
    await expect(withExplicitDownload(() => ensureModelFiles())).rejects.toThrow(/model_quantized\.onnx is 0 bytes/)
    expect(urls.filter((u) => u.endsWith('tokenizer.json'))).toHaveLength(1)
    expect(lastDownloadFailure()).toBeNull()
    expect(activeDownloadCooldown()).toBeNull()
  })

  it('does not retry a refusal from the server, but still remembers it', async () => {
    const { urls } = stubFetch(() => new Response('nope', { status: 403, statusText: 'Forbidden' }))
    await expect(ensureModelFiles()).rejects.toThrow(/returned 403 Forbidden/)
    expect(urls).toHaveLength(1)
    expect(lastDownloadFailure()).toMatchObject({ failures: 1 })
    expect(lastDownloadFailure()!.message).toContain('403 Forbidden')
  })

  it('retries a server error and needs no record when a retry succeeds', async () => {
    const { urls } = stubFetch((url, call) => {
      if (call <= 2) return new Response('busy', { status: 503, statusText: 'Service Unavailable' })
      return url.endsWith('tokenizer.json') ? body(REAL_TOKENIZER) : body(new Uint8Array(0))
    })
    await expect(ensureModelFiles()).rejects.toThrow(/model_quantized\.onnx is 0 bytes/)
    expect(urls.filter((u) => u.endsWith('tokenizer.json'))).toHaveLength(3)
    expect(lastDownloadFailure()).toBeNull()
  })

  // PROVENANCE: HAND-DERIVED for 429, the status RFC 6585 §4 defines as "too many requests", which a retry after a pause can clear.
  it('retries a rate limit the way it retries a server error', async () => {
    const { urls } = stubFetch((url, call) => {
      if (call <= 2) return new Response('slow down', { status: 429, statusText: 'Too Many Requests' })
      return url.endsWith('tokenizer.json') ? body(REAL_TOKENIZER) : body(new Uint8Array(0))
    })
    await expect(ensureModelFiles()).rejects.toThrow(/model_quantized\.onnx is 0 bytes/)
    expect(urls.filter((u) => u.endsWith('tokenizer.json'))).toHaveLength(3)
    expect(lastDownloadFailure()).toBeNull()
  })

  // PROVENANCE: CAPTURE. node v24.12.0, `fetch('https://tg-nonexistent-host.invalid/')` rejects with TypeError('fetch failed') whose `cause` is an Error 'getaddrinfo ENOTFOUND tg-nonexistent-host.invalid' with code 'ENOTFOUND' and syscall 'getaddrinfo'.
  it('does not retry a host name that does not resolve, since the answer will not change in a second', async () => {
    const { urls } = stubFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'huggingface.co' }) })
    })
    await expect(ensureModelFiles()).rejects.toThrow(/ENOTFOUND/)
    expect(urls).toHaveLength(1)
    expect(lastDownloadFailure()!.message).toContain('ENOTFOUND')
  })

  // PROVENANCE: CAPTURE for the shape. node v24.12.0, `new DOMException('The operation was aborted due to timeout', 'TimeoutError')` is `instanceof Error` with name 'TimeoutError', the rejection the WHATWG DOM spec gives AbortSignal.timeout().
  it('retries a request that timed out', async () => {
    const { urls } = stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    await expect(ensureModelFiles()).rejects.toThrow(/timeout/)
    expect(urls).toHaveLength(3)
  })

  // PROVENANCE: CAPTURE. node v24.12.0 against badssl.com hosts: `fetch('https://self-signed.badssl.com/')` and its siblings reject with TypeError('fetch failed') whose `cause` is an Error carrying the code below, which is not in its message. `fetch('not a url')` rejects with TypeError('Failed to parse URL from not a url') whose cause is a TypeError with code ERR_INVALID_URL. A retry a quarter second later meets the same certificate or the same string, so each is tried once.
  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames: Host: huggingface.co. is not in the cert's altnames: DNS:*.badssl.com, DNS:badssl.com"],
    ['ERR_INVALID_URL', 'Invalid URL'],
  ])('does not retry a %s rejection, whose answer will not change in a second, but records it', async (code, message) => {
    const { urls } = stubFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(code === 'ERR_INVALID_URL' ? new TypeError(message) : new Error(message), { code }) })
    })
    await expect(ensureModelFiles()).rejects.toThrow(message.slice(0, 20))
    expect(urls).toHaveLength(1)
    expect(lastDownloadFailure()).toMatchObject({ failures: 1 })
  })

  it('cancels the body of a response it will not use, so an error page does not hold its connection open', async () => {
    const cancelled: number[] = []
    stubFetch((_url, call) => {
      const stream = new ReadableStream<Uint8Array>({ pull: () => undefined, cancel: () => void cancelled.push(call) })
      return new Response(stream as unknown as BodyInit, { status: 403, statusText: 'Forbidden' })
    })
    await expect(ensureModelFiles()).rejects.toThrow(/returned 403 Forbidden/)
    expect(cancelled, 'the one refused response had its body cancelled').toEqual([1])
  })

  // PROVENANCE: CAPTURE for the shape. node v24.12.0, a local http server that sent `content-length: 100000`, wrote 1000 bytes and destroyed the socket: iterating `(await fetch(url)).body` rejects with TypeError('terminated') whose `cause` is a SocketError with code 'UND_ERR_SOCKET' and message 'other side closed'.
  function breaksOff(bytes: Uint8Array): Response {
    const socket = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' })
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError('terminated', { cause: socket }))
        else controller.enqueue(bytes.subarray(0, 1000))
        sent = true
      },
    })
    return new Response(stream as unknown as BodyInit, { status: 200 })
  }

  const partials = (): string[] => (fs.readdirSync(tmp, { recursive: true }) as string[]).filter((f) => f.endsWith('.partial'))

  it('retries a body that breaks off partway, and records the host failure when every try does', async () => {
    const { urls } = stubFetch(() => breaksOff(REAL_TOKENIZER))
    const err: unknown = await ensureModelFiles().catch((e: unknown) => e)
    expect(String(err)).toMatch(new RegExp(`broke off after 1000 of ${REAL_TOKENIZER.length} bytes: terminated \\(other side closed\\)`))
    expect(urls, 'three attempts at the first file, then stop').toHaveLength(3)
    expect(lastDownloadFailure()).toMatchObject({ failures: 1 })
    expect(lastDownloadFailure()!.message).toContain('other side closed')
    expect(failedAtOf(err)).toBe(lastDownloadFailure()!.at)
    expect(partials(), 'no attempt leaves its scratch file behind').toEqual([])
  })

  it('keeps a download whose body broke off once and then arrived whole, with nothing recorded', async () => {
    const { urls } = stubFetch((url, call) => {
      if (call === 1) return breaksOff(REAL_TOKENIZER)
      return url.endsWith('tokenizer.json') ? body(REAL_TOKENIZER) : body(new Uint8Array(0))
    })
    await expect(ensureModelFiles()).rejects.toThrow(/model_quantized\.onnx is 0 bytes/)
    expect(urls.filter((u) => u.endsWith('tokenizer.json'))).toHaveLength(2)
    expect(lastDownloadFailure()).toBeNull()
    expect(partials()).toEqual([])
  })

  // PROVENANCE: HAND-DERIVED. The genuine tokenizer with its first byte changed: the right length and the wrong digest.
  it('neither retries nor records a file that arrived whole with the wrong digest, since the host did answer', async () => {
    const wrong = Buffer.from(REAL_TOKENIZER)
    wrong[0] = wrong[0]! ^ 1
    const { urls } = stubFetch(() => body(wrong))
    await expect(ensureModelFiles()).rejects.toThrow(/tokenizer\.json has sha256 /)
    expect(urls).toHaveLength(1)
    expect(lastDownloadFailure()).toBeNull()
  })

  it('treats a record it cannot parse as no record, rather than as a failure or a crash', async () => {
    fs.mkdirSync(path.dirname(downloadFailureRecordPath()), { recursive: true })
    fs.writeFileSync(downloadFailureRecordPath(), '{"huggingface.co": {"at": "yesterday"')
    expect(lastDownloadFailure()).toBeNull()
    expect(activeDownloadCooldown()).toBeNull()
    const { urls } = stubFetch(() => {
      throw refused()
    })
    await expect(ensureModelFiles()).rejects.toThrow(/ECONNREFUSED/)
    expect(urls).toHaveLength(3)
    expect(lastDownloadFailure()!.failures).toBe(1)
  })

  it('keeps each host apart, so a failure on one does not hold a download from another', () => {
    recordDownloadFailure('https://registry.npmjs.org/onnxruntime-web/-/x.tgz', 'fetch failed')
    expect(activeDownloadCooldown('registry.npmjs.org')).not.toBeNull()
    expect(activeDownloadCooldown(MODEL_DOWNLOAD_HOST)).toBeNull()
  })
})

describe('the hold', () => {
  it('is 10 minutes, doubles with each consecutive failure, and stops at an hour', () => {
    expect([1, 2, 3, 4, 5, 50].map((n) => downloadHoldMs(n) / MINUTE)).toEqual([10, 20, 40, 60, 60, 60])
  })

  it('ends when its time is up, and the next failure is held longer', () => {
    const t0 = Date.UTC(2026, 8, 29, 12, 0, 0)
    const url = `https://${MODEL_DOWNLOAD_HOST}/f`
    recordDownloadFailure(url, 'fetch failed', t0)
    expect(activeDownloadCooldown(MODEL_DOWNLOAD_HOST, t0 + 10 * MINUTE - 1)).not.toBeNull()
    expect(activeDownloadCooldown(MODEL_DOWNLOAD_HOST, t0 + 10 * MINUTE)).toBeNull()
    recordDownloadFailure(url, 'fetch failed', t0 + 10 * MINUTE)
    expect(activeDownloadCooldown(MODEL_DOWNLOAD_HOST, t0 + 10 * MINUTE)).toMatchObject({ failures: 2, retryAt: t0 + 30 * MINUTE })
  })

  it('does not hold for days when the clock has gone backwards past the recorded failure', () => {
    const now = Date.UTC(2026, 8, 29, 12, 0, 0)
    recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/f`, 'fetch failed', now + 24 * 60 * MINUTE)
    expect(activeDownloadCooldown(MODEL_DOWNLOAD_HOST, now)).toBeNull()
  })
})

describe('describeCause', () => {
  it('follows the cause chain, which is where fetch keeps the reason', () => {
    expect(describeCause(refused())).toBe('fetch failed (connect ECONNREFUSED 127.0.0.1:9)')
  })

  it('names a code when the cause has no message, and does not repeat what the outer message says', () => {
    expect(describeCause(new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }) }))).toBe('fetch failed (ENOTFOUND)')
    expect(describeCause(new Error('connect ECONNREFUSED 1.2.3.4:443', { cause: new Error('ECONNREFUSED') }))).toBe('connect ECONNREFUSED 1.2.3.4:443')
    expect(describeCause('plain string')).toBe('plain string')
  })

  // HAND-DERIVED: an error with neither a message nor a code still has a name, and "GET … failed: " ending on nothing reads as a truncated line rather than as a reason.
  it('names the error type when there is neither a message nor a code', () => {
    expect(describeCause(new TypeError(''))).toBe('TypeError')
    expect(describeCause(new TypeError('fetch failed', { cause: new RangeError('') }))).toBe('fetch failed (RangeError)')
  })

  it('reads the first of an AggregateError cause, which is what a failed dual-stack connect gives', () => {
    const agg = new AggregateError([Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' })], '')
    expect(describeCause(new TypeError('fetch failed', { cause: agg }))).toBe('fetch failed (connect ETIMEDOUT 10.0.0.1:443)')
  })
})

describe('the record under concurrent writers', () => {
  // HAND-DERIVED: the worker, the CLI and the MCP server are separate processes, and each host's entry is the only thing that holds its downloads back, so an entry one process wrote must survive another process writing a different host.
  it('keeps every host when several processes record failures at once', () => {
    const script = path.join(tmp, 'writer.ts')
    const gate = pathToFileURL(path.join(HERE, '..', 'src', 'model_download_gate.ts')).href
    fs.writeFileSync(script, [`import { recordDownloadFailure } from '${gate}'`, 'const host = process.argv[2]', "for (let i = 0; i < 40; i++) recordDownloadFailure('https://' + host + '/f', 'fetch failed')", ''].join('\n'))
    const hosts = Array.from({ length: 6 }, (_, i) => `host${i}.example`)
    const children = hosts.map((host) => spawn(process.execPath, tsxProcessArgs(script, host), { cwd: path.join(HERE, '..'), env: process.env, stdio: 'pipe' }))
    return Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.on('close', resolve)))).then((codes) => {
      expect(codes).toEqual(hosts.map(() => 0))
      for (const host of hosts) expect(lastDownloadFailure(host), host).not.toBeNull()
    })
  }, 60_000)

  // HAND-DERIVED: a holder that keeps the record's lock for 3 s while it reads and rewrites the record, which is longer than withFileLock's default 2 s wait. A writer that gave up at 2 s and wrote without the lock had its entry overwritten by the holder's rewrite a second later.
  it('waits out a holder slower than the default lock wait instead of writing past it', async () => {
    const record = downloadFailureRecordPath()
    fs.mkdirSync(path.dirname(record), { recursive: true })
    const ready = path.join(tmp, 'holder.ready')
    const script = path.join(tmp, 'holder.ts')
    const util = pathToFileURL(path.join(HERE, '..', 'src', 'util.ts')).href
    fs.writeFileSync(script, [
      `import * as fs from 'node:fs'`,
      `import { sleepSync, withFileLock } from '${util}'`,
      'const [record, ready] = process.argv.slice(2)',
      "const taken = withFileLock(record + '.lock', () => {",
      "  const before = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '{}'",
      "  fs.writeFileSync(ready, '')",
      '  sleepSync(3000)',
      '  fs.writeFileSync(record, before)',
      '  return true',
      '})',
      'process.exit(taken ? 0 : 1)',
      '',
    ].join('\n'))
    const holder = spawn(process.execPath, tsxProcessArgs(script, record, ready), { cwd: path.join(HERE, '..'), env: process.env, stdio: 'pipe' })
    const closed = new Promise<number | null>((resolve) => holder.on('close', resolve))
    for (let i = 0; i < 300 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(ready), 'calibration: the holder took the lock').toBe(true)
    recordDownloadFailure('https://late.example/f', 'fetch failed')
    expect(await closed).toBe(0)
    expect(lastDownloadFailure('late.example')).not.toBeNull()
  }, 60_000)

  // HAND-DERIVED: three processes that start together against a host that is down all fail within the same second. That is one outage, and counting it three times held the next try for 40 minutes instead of 10.
  it('counts failures of attempts that overlapped as one', () => {
    const t0 = Date.UTC(2026, 8, 29, 12, 0, 0)
    const url = `https://${MODEL_DOWNLOAD_HOST}/f`
    for (let i = 0; i < 3; i++) recordDownloadFailure(url, 'fetch failed', t0 + 500 + i, t0)
    expect(lastDownloadFailure()!.failures).toBe(1)
    // An attempt that started after the last recorded failure is a later try at the same outage, and does count.
    recordDownloadFailure(url, 'fetch failed', t0 + 10 * MINUTE + 500, t0 + 10 * MINUTE)
    expect(lastDownloadFailure()!.failures).toBe(2)
  })

  it('drops entries old enough that nothing reads them any more', () => {
    const t0 = Date.UTC(2026, 8, 29, 12, 0, 0)
    recordDownloadFailure('https://old.example/f', 'fetch failed', t0)
    recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/f`, 'fetch failed', t0 + 25 * 60 * MINUTE)
    expect(Object.keys(JSON.parse(fs.readFileSync(downloadFailureRecordPath(), 'utf-8')))).toEqual([MODEL_DOWNLOAD_HOST])
  })
})

describe('a download the host redirects elsewhere', () => {
  // FORMAT-DERIVED from the Fetch standard's "HTTP-redirect fetch" (https://fetch.spec.whatwg.org/#http-redirect-fetch), which undici follows for `redirect: 'follow'`: a 302 is resolved inside fetch, so the caller sees one rejection, or one response whose `url` is the redirect target. huggingface.co answers a model file with a 302 to its CDN, and a CDN that fails must hold the next try against huggingface.co, the host the next caller checks, not against a CDN host no caller ever asks about.
  type Server = http.Server
  const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()))

  /** Download from a local origin that 302s to `target`, and return the two hosts involved. */
  async function viaRedirect(target: () => Promise<{ port: number; done: () => Promise<void> }>): Promise<{ err: unknown; asked: string; redirected: string }> {
    const dest = await target()
    const origin = http.createServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${dest.port}/f.bin` }).end())
    const port = await listen(origin)
    try {
      const { downloadPinned } = await import('../src/pinned_fetch.js')
      const err: unknown = await downloadPinned(`http://127.0.0.1:${port}/f.bin`, { name: 'f.bin', sha256: '0'.repeat(64), bytes: 1 }, path.join(tmp, 'f.bin')).catch((e: unknown) => e)
      return { err, asked: `127.0.0.1:${port}`, redirected: `127.0.0.1:${dest.port}` }
    } finally {
      await close(origin)
      await dest.done()
    }
  }

  it('records a refused redirect target against the host that was asked', async () => {
    const { err, asked, redirected } = await viaRedirect(async () => {
      const probe = http.createServer()
      const port = await listen(probe)
      await close(probe)
      return { port, done: async () => undefined }
    })
    expect(String(err)).toContain('ECONNREFUSED')
    expect(lastDownloadFailure(asked), 'held against the host the caller asked').toMatchObject({ failures: 1 })
    expect(lastDownloadFailure(redirected), 'nothing held against the redirect target').toBeNull()
    expect(activeDownloadCooldown(`http://${asked}/f.bin`), 'the next request to the same URL is held').not.toBeNull()
  })

  it('records a redirect target that answers 503 against the host that was asked', async () => {
    let hits = 0
    const { err, asked, redirected } = await viaRedirect(async () => {
      const cdn = http.createServer((_req, res) => {
        hits++
        res.writeHead(503, 'Service Unavailable').end('busy')
      })
      return { port: await listen(cdn), done: () => close(cdn) }
    })
    expect(String(err)).toContain('503')
    expect(hits, 'a 503 is retried, through the redirect each time').toBe(3)
    expect(lastDownloadFailure(asked)).toMatchObject({ failures: 1 })
    expect(lastDownloadFailure(redirected)).toBeNull()
  })
})
