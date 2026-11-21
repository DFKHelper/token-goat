/** Enterprise evaluation asks one question about egress: can this thing open a connection I did not ask for? The honest answer had five parts -- its own HTTP fetches, the embedding-model download, the OCR language-data download, screenshot, and Google Drive -- and no single lever to say no. `network.offline` is that lever. It is a locked section, so a cloned repository cannot switch it back off from its own .token-goat.toml. */
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PROJECT_LOCKED_SECTIONS, invalidateConfigCache, loadConfig, stripLockedProjectKeys } from '../src/config.js'
import { ocrBlockedOffline } from '../src/image_ocr.js'
import { spawnOwned, type OwnedChild } from '../src/process_tree.js'
import { performHttpFetch } from '../src/webfetch.js'
import { BUNDLE } from './helpers/bundle.js'

let root: string
let savedOffline: string | undefined
let savedHome: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-offline-'))
  savedOffline = process.env['TOKEN_GOAT_OFFLINE']
  savedHome = process.env['TOKEN_GOAT_HOME']
  invalidateConfigCache()
})

afterEach(() => {
  if (savedOffline === undefined) delete process.env['TOKEN_GOAT_OFFLINE']
  else process.env['TOKEN_GOAT_OFFLINE'] = savedOffline
  if (savedHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = savedHome
  invalidateConfigCache()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('network.offline config', () => {
  it('is off by default, so nothing changes for an install that never sets it', () => {
    delete process.env['TOKEN_GOAT_OFFLINE']
    invalidateConfigCache()

    expect(loadConfig(root).network.offline).toBe(false)
  })

  it('turns on from the environment', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    invalidateConfigCache()

    expect(loadConfig(root).network.offline).toBe(true)
  })

  it('is locked against a per-project config file, which arrives with the repository', () => {
    expect(PROJECT_LOCKED_SECTIONS).toContain('network')
    const { cleaned, dropped } = stripLockedProjectKeys({ network: { offline: false } })

    expect(cleaned).toEqual({})
    expect(dropped).toEqual(['network'])
  })

  it('a project file cannot switch offline mode back off on disk either', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[network]\noffline = false\n')
    invalidateConfigCache()

    expect(loadConfig(root).network.offline).toBe(true)
  })
})

describe('performHttpFetch under offline mode', () => {
  it('refuses rather than connecting, and names the setting that caused it', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    invalidateConfigCache()

    await expect(
      performHttpFetch('https://example.com/thing', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1024,
        requestHeaders: {},
        redirectsLeft: 0,
      }),
    ).rejects.toThrow(/Offline mode is on \(network\.offline\)/)
  })

  it('still rejects a non-HTTP scheme with the SSRF message, not the offline one', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    invalidateConfigCache()

    await expect(
      performHttpFetch('file:///etc/passwd', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1024,
        requestHeaders: {},
        redirectsLeft: 0,
      }),
    ).rejects.toThrow(/SSRF safety check/)
  })
})

describe('the suite runs offline unless a test opts out', () => {
  // HAND-DERIVED: the message is the one src/webfetch.ts throws at line 245; the default is isolate-home.ts's.
  it('refuses a loopback fetch when the test sets no opt-out', async () => {
    await expect(
      performHttpFetch('http://127.0.0.1:9/thing', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1024,
        requestHeaders: {},
        redirectsLeft: 0,
      }),
    ).rejects.toThrow(/Offline mode is on \(network\.offline\)/)
  })
})

describe('ocrBlockedOffline', () => {
  // Both directions matter. Blocking whenever offline is set would break an air-gapped machine that already has the language file, which is the install most likely to have set the flag.
  it('does not block when offline mode is off, whatever the cache holds', () => {
    delete process.env['TOKEN_GOAT_OFFLINE']
    process.env['TOKEN_GOAT_HOME'] = root
    invalidateConfigCache()

    expect(ocrBlockedOffline()).toBe(false)
  })

  it('blocks when offline mode is on and the language file has never been downloaded', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    process.env['TOKEN_GOAT_HOME'] = root
    invalidateConfigCache()

    expect(ocrBlockedOffline()).toBe(true)
  })

  it('does not block when offline mode is on but the language file is already cached', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    process.env['TOKEN_GOAT_HOME'] = root
    invalidateConfigCache()
    fs.mkdirSync(path.join(root, 'ocr-cache'), { recursive: true })
    fs.writeFileSync(path.join(root, 'ocr-cache', 'eng.traineddata'), 'cached')

    expect(ocrBlockedOffline()).toBe(false)
  })
})

describe('takeScreenshot under offline mode', () => {
  it('refuses before it looks for a browser, so the message is about the policy not the install', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    invalidateConfigCache()
    const { takeScreenshot } = await import('../src/screenshot.js')

    await expect(takeScreenshot('https://example.com', path.join(root, 'shot.png'))).rejects.toThrow(
      /Offline mode is on \(network\.offline\)/,
    )
  })
})

describe('the built bundle under the suite default', () => {
  // HAND-DERIVED: the refusal text is src/webfetch.ts::performHttpFetch's, wrapped by src/config_commands.ts::cmdFetchImage. No-socket mechanism: a loopback net.Server owned by this test counts every accepted connection, and the bundle is pointed at it; the offline check runs before any DNS or socket in performHttpFetch, so the count must stay 0. The env is process.env as tests/setup/isolate-home.ts left it, with no override here.
  it('fetch-image exits with the offline refusal and opens no socket when the test sets no opt-out', async () => {
    let connections = 0
    const server = net.createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('loopback server has no port')
    const url = `http://127.0.0.1:${address.port}/pixel.png`
    const out = path.join(root, 'fetched.png')
    let owned: OwnedChild | undefined
    try {
      const started = spawnOwned(process.execPath, [BUNDLE, 'fetch-image', url, '--out', out], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      owned = started
      let stdout = ''
      let stderr = ''
      started.child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      started.child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      const status = await new Promise<number | null>((resolve) => started.child.once('close', (code) => resolve(code)))
      // Let the loop accept anything the child connected before it exited, then count.
      for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve))

      expect(stderr, 'the refusal names the setting').toMatch(/Offline mode is on \(network\.offline\): refusing to fetch http:\/\/127\.0\.0\.1:\d+\/pixel\.png/)
      expect(status, `stdout=${stdout} stderr=${stderr}`).toBe(1)
      expect(connections, 'the bundle opened a socket to the loopback server').toBe(0)
      expect(fs.existsSync(out)).toBe(false)
    } finally {
      owned?.kill()
      owned?.release()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
