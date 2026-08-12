/**
 * Security regression: the screenshot policy classified the *hostname string*, never the address
 * actually dialled. `http://rebind.test/` resolving to 127.0.0.1 (or 169.254.169.254) passed
 * every check -- scheme, literal-IP, and the per-request interception added by the redirect fix,
 * because interception re-ran the same name-based policy. That is DNS rebinding, and it made the
 * whole literal-IP block list bypassable with one DNS record.
 *
 * The fix resolves every host before the request is allowed, refuses when ANY resolved address is
 * private/loopback/link-local/metadata/unspecified, fails closed when a name does not resolve at
 * all, and then PINS the validated address into Chromium's resolver via --host-resolver-rules so
 * the address that was validated is the address that gets connected to. Validating one lookup and
 * letting Chromium run a second, independent one leaves exactly the gap the attack needs.
 *
 * These drive a REAL browser: checking the validator in isolation cannot prove the browser was
 * actually prevented from connecting. A local server plays the private victim; Chrome's
 * --host-resolver-rules maps the hostname onto it, so no genuinely-private address is ever
 * contacted and no network access is needed. Skipped when no Chrome/Chromium is found.
 *
 * Chrome cannot start under the sandboxed HOME/LOCALAPPDATA that tests/setup/isolate-home.ts
 * installs, so the real values it stashed in TG_REAL_* are restored for this file and put back
 * afterwards -- same afterAll discipline as screenshot_redirect_ssrf.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  blockedAddressAmong,
  parseHostResolverMap,
  resolveBrowserExecutablePath,
  takeScreenshot,
  validateScreenshotUrl,
} from '../src/screenshot.js'
import { invalidateConfigCache } from '../src/config.js'

const PRIVATE_MARKER = 'SECRET_REBOUND_INTERNAL_MARKER_8871'
const SANDBOXED_ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE'] as const

const sandboxedEnv: Partial<Record<string, string | undefined>> = {}

function useRealEnv(): void {
  for (const key of SANDBOXED_ENV_KEYS) {
    sandboxedEnv[key] = process.env[key]
    const real = process.env[`TG_REAL_${key}`]
    if (real !== undefined) process.env[key] = real
  }
}

function restoreSandboxedEnv(): void {
  for (const key of SANDBOXED_ENV_KEYS) {
    const saved = sandboxedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

describe('address-level screenshot policy (no browser needed)', () => {
  afterEach(() => {
    delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
    invalidateConfigCache()
  })

  it('rejects a private IPv4 embedded in the NAT64 well-known prefix', () => {
    // 64:ff9b::a9fe:a9fe is 169.254.169.254 behind a NAT64 gateway; ::7f00:1 is 127.0.0.1.
    expect(() => validateScreenshotUrl('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/')).toThrow(
      /loopback\/link-local\/private IP/,
    )
    expect(() => validateScreenshotUrl('http://[64:ff9b::7f00:1]/')).toThrow(/loopback\/link-local\/private IP/)
    expect(() => validateScreenshotUrl('http://[64:ff9b::a00:1]/')).toThrow(/loopback\/link-local\/private IP/)
  })

  it('still allows a public IPv4 carried in the NAT64 prefix', () => {
    // 64:ff9b::5db8:d822 is 93.184.216.34 -- public, so the prefix alone must not blanket-block.
    expect(() => validateScreenshotUrl('http://[64:ff9b::5db8:d822]/')).not.toThrow()
  })

  it('rejects the whole host when only ONE of several resolved addresses is private', () => {
    // An attacker owns their own record set, so a mixed answer must not be reachable at all.
    expect(blockedAddressAmong(['93.184.216.34', '127.0.0.1'])).toBe('127.0.0.1')
    expect(blockedAddressAmong(['93.184.216.34', '169.254.169.254'])).toBe('169.254.169.254')
    expect(blockedAddressAmong(['2606:2800:220:1:248:1893:25c8:1946', '::1'])).toBe('::1')
    expect(blockedAddressAmong(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])).toBeNull()
  })

  it('reads MAP rules out of --host-resolver-rules so the pinned address is what gets judged', () => {
    const rules = parseHostResolverMap([
      '--host-resolver-rules=MAP a.test 127.0.0.1:8080,MAP b.test 93.184.216.34',
      '--headless',
    ])
    expect(rules.get('a.test')).toBe('127.0.0.1:8080')
    expect(rules.get('b.test')).toBe('93.184.216.34')
    expect(parseHostResolverMap(['--no-sandbox']).size).toBe(0)
  })
})

const browserPath = (() => {
  useRealEnv()
  const found = resolveBrowserExecutablePath()
  restoreSandboxedEnv()
  return found
})()

const describeWithBrowser = browserPath ? describe : describe.skip

describeWithBrowser('takeScreenshot DNS rebinding', () => {
  let server: http.Server
  let tmpDir: string
  let extraLaunchArgs: string[]
  let requestPaths: string[]

  beforeAll(async () => {
    useRealEnv()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rebind-'))
    requestPaths = []
    server = http.createServer((req, res) => {
      requestPaths.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body><h1>${PRIVATE_MARKER}</h1></body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    // rebind.test is a perfectly ordinary-looking public hostname whose DNS answer is loopback -- the attack. Chromium and the policy read this same rule, which is the point: there is one resolution, not two that can disagree.
    extraLaunchArgs = [`--host-resolver-rules=MAP rebind.test 127.0.0.1:${port}`]
    invalidateConfigCache()
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
    restoreSandboxedEnv()
    invalidateConfigCache()
  })

  afterEach(() => {
    delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
    invalidateConfigCache()
  })

  it('refuses a public hostname that resolves to loopback, and never fetches it', async () => {
    requestPaths.length = 0
    const dest = path.join(tmpDir, 'rebind.png')
    let message = ''
    try {
      await takeScreenshot('http://rebind.test/internal-secret', dest, { extraLaunchArgs })
      expect.fail('expected takeScreenshot to refuse a host resolving to a private address')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('rebind.test')
    expect(message).toContain('127.0.0.1')
    expect(message).toMatch(/loopback\/link-local\/private IP/)
    // The refusal must not merely be reported: the private body must never have been requested, must not appear in the error text, and no capture may exist on disk.
    expect(requestPaths).toEqual([])
    expect(message).not.toContain(PRIVATE_MARKER)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('rebind'))).toEqual([])
  }, 60_000)

  it('fails closed when the hostname does not resolve at all', async () => {
    const dest = path.join(tmpDir, 'unresolvable.png')
    let message = ''
    try {
      // .invalid is reserved by RFC 2606 and can never resolve, so this needs no network.
      await takeScreenshot('http://tg-rebind-check.invalid/', dest, {})
      expect.fail('expected takeScreenshot to refuse an unresolvable host')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/DNS resolution failed|DNS returned no addresses/)
    expect(message).toContain('tg-rebind-check.invalid')
    expect(fs.existsSync(dest)).toBe(false)
  }, 60_000)

  it('renders a page end to end under the opt-out (control: not refusing everything)', async () => {
    // Blocking must be opt-out here because every address a test server can bind (127.0.0.1, ::1) is itself in the block list -- with the policy on, no locally-served page is reachable by construction. This still drives the full pipeline through real Chrome, so a fix that refused every target, or crashed in the new resolve/pin code, cannot pass it.
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    invalidateConfigCache()
    requestPaths.length = 0
    const dest = path.join(tmpDir, 'control.png')
    const result = await takeScreenshot('http://rebind.test/ordinary', dest, { extraLaunchArgs })
    expect(fs.existsSync(result.path)).toBe(true)
    expect(result.originalBytes).toBeGreaterThan(0)
    expect(requestPaths).toContain('/ordinary')
  }, 60_000)
})
