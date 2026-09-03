/**
 * Security regression: validateScreenshotUrl ran ONCE, before page.goto() -- and page.goto
 * follows redirects. So `http://attacker.example/r` answering `302 Location:
 * http://169.254.169.254/latest/meta-data/` rendered cloud instance metadata, and with
 * image_shrink.ocr_enabled that content is transcribed straight into model context.
 *
 * This drives a REAL browser, because checking validateScreenshotUrl in isolation cannot prove
 * page.goto was actually prevented from following the redirect -- which is the entire defect. A
 * local server plays both the attacker and the metadata endpoint; Chrome's --host-resolver-rules
 * maps the two hostnames onto it, so no network access is needed and no genuinely-private address
 * is ever contacted. Skipped when no Chrome/Chromium is found.
 *
 * Since the DNS-rebinding fix the policy judges resolved ADDRESSES, not hostnames, so this file's
 * own setup -- a public-looking `attacker.example` whose resolver rule points at loopback -- is
 * itself a rebinding case and is now refused one hop earlier, before the 302 is ever requested.
 * That is a strictly stronger outcome, and the assertions below check it that way. The
 * interception path that catches a redirect hop *after* an allowed first hop is exercised
 * deterministically against the real handler in screenshot.test.ts.
 *
 * Chrome cannot start under the sandboxed HOME/LOCALAPPDATA that tests/setup/isolate-home.ts
 * installs (it can't create its user-data/crashpad dirs), so the real values it stashed in
 * TG_REAL_* are restored for the duration of this file and put back afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveBrowserExecutablePath, takeScreenshot } from '../src/screenshot.js'
import { invalidateConfigCache } from '../src/config.js'

const METADATA_MARKER = 'SECRET_INSTANCE_METADATA_MARKER_4213'
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

useRealEnv()
const browserPath = resolveBrowserExecutablePath()
restoreSandboxedEnv()

const describeWithBrowser = browserPath ? describe : describe.skip

describeWithBrowser('takeScreenshot redirect SSRF', () => {
  let server: http.Server
  let tmpDir: string
  let extraLaunchArgs: string[]

  beforeAll(async () => {
    useRealEnv()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shot-'))
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-to-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' })
        res.end()
        return
      }
      if (req.url === '/latest/meta-data/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h1>${METADATA_MARKER}</h1></body></html>`)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>ordinary page</h1></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    // Both hostnames resolve to the local test server. The screenshot policy never sees this mapping -- it classifies the literal hostname in the URL, exactly as in production.
    extraLaunchArgs = [
      `--host-resolver-rules=MAP attacker.example 127.0.0.1:${port},MAP 169.254.169.254 127.0.0.1:${port}`,
    ]
    invalidateConfigCache()
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
    restoreSandboxedEnv()
    invalidateConfigCache()
  })

  it('renders an ordinary allowed page (control: the harness is not refusing everything)', async () => {
    // Every address a local test server can bind is itself in the block list, so a rendering control has to run under the documented opt-out; the refusal cases below keep it on.
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    invalidateConfigCache()
    const dest = path.join(tmpDir, 'control.png')
    const result = await takeScreenshot('http://attacker.example/ordinary', dest, { extraLaunchArgs })
    expect(fs.existsSync(result.path)).toBe(true)
    expect(result.originalBytes).toBeGreaterThan(0)
    delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
    invalidateConfigCache()
  }, 120_000)

  it('refuses the metadata redirect chain instead of rendering it', async () => {
    const dest = path.join(tmpDir, 'redirect.png')
    let message = ''
    try {
      await takeScreenshot('http://attacker.example/redirect-to-metadata', dest, { extraLaunchArgs })
      expect.fail('expected takeScreenshot to refuse the redirected navigation')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/loopback\/link-local\/private IP/)
    expect(message).toMatch(/169\.254\.169\.254|attacker\.example/)
    // The refusal must not merely be reported: no capture of the metadata page may exist, and the metadata body must not have reached the error text either.
    expect(message).not.toContain(METADATA_MARKER)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('redirect'))).toEqual([])
  }, 120_000)
})
