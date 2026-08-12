/**
 * Local screenshot capture for `token-goat screenshot`, so a page render can
 * reach the model as a small shrunk image instead of round-tripping through
 * a separate browser-automation MCP tool. Uses `puppeteer-core` (drives an
 * existing browser via CDP, never bundles/downloads Chromium) and reuses
 * `shrinkImage()` -- the same function `preReadImageHandler` already applies
 * to local file reads -- so the output goes through one shrink pipeline.
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { shrinkImage } from './image_shrink.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { atomicWriteBytes, redactUrlQuery, withExtension } from './util.js'

export interface ScreenshotOptions {
  executablePath?: string
  width?: number
  height?: number
  fullPage?: boolean
  /** Extra Chromium command-line flags. Not exposed on the CLI: this exists so the redirect-SSRF
   * regression test can point a non-private hostname at a local server via `--host-resolver-rules`
   * (the security policy under test is unaffected -- only DNS resolution is). */
  extraLaunchArgs?: string[]
}

export interface ScreenshotResult {
  path: string
  originalBytes: number
  finalBytes: number
}

// Narrow structural type for the one puppeteer-core surface this module uses,
// so the module compiles/tests without puppeteer-core's own types installed.
interface PuppeteerRequest {
  url(): string
  isNavigationRequest(): boolean
  abort(): Promise<void>
  continue(): Promise<void>
}
interface PuppeteerPage {
  setViewport(opts: { width: number; height: number }): Promise<void>
  setRequestInterception(enabled: boolean): Promise<void>
  on(event: 'request', handler: (req: PuppeteerRequest) => void): void
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>
  screenshot(opts: { type: string; fullPage: boolean }): Promise<Buffer>
}
interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>
  close(): Promise<void>
}
interface PuppeteerModule {
  launch(opts: { headless: boolean; executablePath: string; args?: string[] }): Promise<PuppeteerBrowser>
}

const loadPuppeteer = createLazyModuleLoader(
  async () => (await import('puppeteer-core')) as unknown as PuppeteerModule,
  'screenshot disabled (puppeteer-core unavailable)',
)

/** Playwright's own Chrome-for-Testing cache directory name changed across versions
 * (`chrome-win` on older installs, `chrome-win64` on current ones) -- probe both. */
const PLAYWRIGHT_CHROME_SUBDIRS = ['chrome-win64', 'chrome-win']

function findPlaywrightChromium(msPlaywrightDir: string): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(msPlaywrightDir)
  } catch {
    return []
  }
  const versioned = entries
    .map((e) => /^chromium-(\d+)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => parseInt(b[1] as string, 10) - parseInt(a[1] as string, 10))

  const candidates: string[] = []
  for (const m of versioned) {
    for (const sub of PLAYWRIGHT_CHROME_SUBDIRS) {
      candidates.push(path.join(msPlaywrightDir, m[0], sub, 'chrome.exe'))
    }
  }
  return candidates
}

function platformCandidatePaths(): string[] {
  if (process.platform === 'win32') {
    const candidates: string[] = []
    const programFiles = process.env['PROGRAMFILES']
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    const localAppData = process.env['LOCALAPPDATA']
    if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(...findPlaywrightChromium(path.join(localAppData, 'ms-playwright')))
    }
    return candidates
  }
  if (process.platform === 'darwin') {
    const home = process.env['HOME']
    const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    if (home) candidates.push(...findPlaywrightChromium(path.join(home, 'Library', 'Caches', 'ms-playwright')))
    return candidates
  }
  const home = process.env['HOME']
  const candidates = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  if (home) candidates.push(...findPlaywrightChromium(path.join(home, '.cache', 'ms-playwright')))
  return candidates
}

/** Resolves a browser executable: explicit param > config `screenshot.chrome_path` >
 * `TOKEN_GOAT_CHROME_PATH` env > common per-platform install/Playwright-cache locations. */
export function resolveBrowserExecutablePath(explicit?: string): string | null {
  if (explicit && fs.existsSync(explicit)) return explicit

  const cfgPath = loadConfig().screenshot.chrome_path
  if (cfgPath && fs.existsSync(cfgPath)) return cfgPath

  const envPath = process.env['TOKEN_GOAT_CHROME_PATH']
  if (envPath && fs.existsSync(envPath)) return envPath

  for (const candidate of platformCandidatePaths()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** The single source of truth for which IPv4 space is off-limits, keyed on the first two
 * octets. Both the dotted-quad path and the IPv4-mapped/compatible IPv6 path below call this,
 * so the ranges can't drift into two copies. Decimal/octal/hex integer spellings of an IPv4
 * address (e.g. http://2130706433/) don't need handling here: `new URL` normalizes those to
 * dotted-quad before `hostname` is read. */
function isBlockedIpv4Octets(a: number, b: number): boolean {
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata 169.254.169.254
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 0) return true // "this network"
  return false
}

/** Parses an IPv6 literal into its eight 16-bit groups, or null if it isn't one. Handles `::`
 * zero-compression, a `%zone` suffix, and a dotted-quad tail (`::ffff:127.0.0.1`), which it
 * folds into the equivalent two hex groups so the classifier only ever sees one representation.
 * Needed because a substring/prefix test can't see through those spellings: `::ffff:127.0.0.1`
 * is normalized by `new URL` to `::ffff:7f00:1`, which matches no textual loopback pattern. */
function parseIpv6Groups(text: string): number[] | null {
  let rest = text
  const zoneAt = rest.indexOf('%')
  if (zoneAt !== -1) rest = rest.slice(0, zoneAt)
  if (!/^[0-9a-f:.]+$/i.test(rest) || !rest.includes(':')) return null

  const lastColon = rest.lastIndexOf(':')
  const tail = rest.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
    if (!quad) return null
    const octets = [Number(quad[1]), Number(quad[2]), Number(quad[3]), Number(quad[4])]
    if (octets.some((n) => n > 255)) return null
    const hi = ((octets[0] as number) << 8) | (octets[1] as number)
    const lo = ((octets[2] as number) << 8) | (octets[3] as number)
    rest = `${rest.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }

  const parseGroup = (g: string): number | null => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : null)
  const halves = rest.split('::')
  if (halves.length > 2) return null

  let parts: string[]
  if (halves.length === 2) {
    const left = (halves[0] as string).length > 0 ? (halves[0] as string).split(':') : []
    const right = (halves[1] as string).length > 0 ? (halves[1] as string).split(':') : []
    if (left.length + right.length > 7) return null // `::` must stand for at least one group
    parts = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  } else {
    parts = rest.split(':')
    if (parts.length !== 8) return null
  }

  const groups: number[] = []
  for (const part of parts) {
    const value = parseGroup(part)
    if (value === null) return null
    groups.push(value)
  }
  return groups
}

function isBlockedIpv6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true // `::` unspecified -- connects to localhost
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1 loopback
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): classify by the embedded IPv4
  // value, so [::ffff:169.254.169.254] is blocked for the same reason 169.254.169.254 is.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = groups[6] as number
    return isBlockedIpv4Octets(embedded >> 8, embedded & 0xff)
  }
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if (((groups[0] as number) & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  return false
}

// Loopback and link-local (incl. cloud metadata at 169.254.169.254) are always rejected when
// literal IPs; RFC1918 private ranges are the other block class. This is a synchronous
// literal-IP check ONLY -- a hostname that resolves to one of these ranges (DNS rebinding) is
// NOT covered, since closing that requires an async DNS lookup this function deliberately
// doesn't perform. The NAT64 well-known prefix (64:ff9b::/96) is likewise not decoded. Do not
// read this as full SSRF protection.
function isBlockedLiteralIp(host: string): boolean {
  if (host === 'localhost') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) return isBlockedIpv4Octets(Number(v4[1]), Number(v4[2]))
  const bare = host.replace(/^\[/, '').replace(/\]$/, '')
  const groups = parseIpv6Groups(bare)
  return groups !== null && isBlockedIpv6(groups)
}

/**
 * Returns why a screenshot navigation target is refused, or null if it's allowed. Rejects any
 * scheme other than http:/https:, and (unless opted out via screenshot.block_private_targets=false)
 * literal loopback/link-local/RFC1918 hosts -- so injected content can't aim the headless browser
 * at cloud metadata (169.254.169.254) or a localhost-only service, whose rendered output would
 * otherwise be fed back into the model's context via OCR. Returning the reason rather than
 * throwing lets the per-request interception hook in takeScreenshot reuse the exact same policy
 * for every redirect hop and sub-resource, where an exception can't cross the callback boundary.
 */
export function screenshotUrlRefusal(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Invalid screenshot URL: ${redactUrlQuery(url)}`
  }
  // A screenshot URL can be signed (SAS token, share signature), so error text shows only
  // origin + pathname, never the query string -- otherwise a URL rejected for its scheme
  // prints its own access token into stderr and from there into the model's context.
  const safeUrl = parsed.origin !== 'null' ? parsed.origin + parsed.pathname : redactUrlQuery(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Rejected screenshot URL scheme "${parsed.protocol}" (only http:/https: are allowed): ${safeUrl}`
  }
  if (loadConfig().screenshot.block_private_targets && isBlockedLiteralIp(parsed.hostname)) {
    return (
      `Rejected screenshot target "${parsed.hostname}" (loopback/link-local/private IP). ` +
      'Set screenshot.block_private_targets = false in token-goat config to opt in for ' +
      'legitimate internal-service screenshots.'
    )
  }
  return null
}

export function validateScreenshotUrl(url: string): void {
  const refusal = screenshotUrlRefusal(url)
  if (refusal !== null) throw new Error(refusal)
}

export async function takeScreenshot(url: string, destPath: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
  validateScreenshotUrl(url)
  const puppeteer = await loadPuppeteer()
  if (!puppeteer) {
    throw new Error('puppeteer-core is not installed; run `npm install puppeteer-core` to enable screenshot')
  }

  const executablePath = resolveBrowserExecutablePath(opts?.executablePath)
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium executable found. Set screenshot.chrome_path in token-goat config, pass ' +
        '--executable-path, or set TOKEN_GOAT_CHROME_PATH. A Playwright Chrome-for-Testing cache ' +
        '(e.g. %LOCALAPPDATA%\\ms-playwright\\chromium-<version>\\chrome-win64\\chrome.exe on Windows) is also detected automatically.',
    )
  }

  const browser = await puppeteer.launch({ headless: true, executablePath, args: opts?.extraLaunchArgs ?? [] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: opts?.width ?? 1280, height: opts?.height ?? 800 })

    // The pre-flight validateScreenshotUrl above only sees the FIRST url; page.goto follows
    // redirects, so `http://attacker.example/r` answering `302 Location: http://169.254.169.254/`
    // would otherwise render cloud metadata. Request interception re-applies the identical policy
    // to every request the page makes -- each redirect hop arrives as its own request event, and
    // so does every sub-resource (image/script/iframe/XHR), closing the "page embeds
    // <img src=http://169.254.169.254/...>" variant at the same time.
    //
    // What this does NOT cover: DNS rebinding (a public hostname resolving to a private IP is
    // still allowed -- same async-lookup caveat as isBlockedLiteralIp), and anything the browser
    // fetches outside the request pipeline. data:/blob: sub-resources are allowed through
    // deliberately: they are page-local, cause no network egress, and aborting them would break
    // rendering of legitimate inline images for no security gain.
    const navRefusal: { reason: string | null } = { reason: null }
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const target = req.url()
      const isNav = req.isNavigationRequest()
      if (!isNav && /^(data|blob|about):/i.test(target)) {
        void req.continue()
        return
      }
      const refusal = screenshotUrlRefusal(target)
      if (refusal === null) {
        void req.continue()
        return
      }
      // A blocked navigation (i.e. a redirect hop) fails the whole render: that page is the
      // thing being captured. A blocked sub-resource is just dropped -- the rest of the page is
      // still a legitimate capture, and one hostile <img> shouldn't deny the user a screenshot.
      // Only the first navigation refusal is kept; it is the one that diverted the render.
      if (isNav && navRefusal.reason === null) navRefusal.reason = refusal
      void req.abort()
    })

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
    } catch (err) {
      // An aborted main-frame navigation surfaces as a generic net::ERR_FAILED, which would hide
      // why it failed -- report the policy refusal instead.
      if (navRefusal.reason !== null) throw new Error(navRefusal.reason, { cause: err })
      throw err
    }
    // A blocked redirect can also resolve without rejecting (the browser lands on an error page),
    // so refuse on any recorded navigation refusal rather than trusting goto's outcome alone.
    if (navRefusal.reason !== null) throw new Error(navRefusal.reason)
    const buffer = await page.screenshot({ type: 'png', fullPage: opts?.fullPage ?? false })
    const shrunk = await shrinkImage(buffer)
    const finalBuffer = shrunk?.data ?? buffer
    // shrinkImage may re-encode the PNG capture to JPEG/WebP when it exceeds the shrink
    // threshold; writing those bytes under the originally-requested (e.g. `.png`) extension
    // would silently mislabel the file's actual format. Rename the destination extension to
    // match the real output format and report the actual saved path.
    const finalPath = shrunk ? withExtension(destPath, shrunk.format) : destPath
    atomicWriteBytes(finalPath, finalBuffer)
    return { path: finalPath, originalBytes: buffer.length, finalBytes: finalBuffer.length }
  } finally {
    await browser.close()
  }
}
