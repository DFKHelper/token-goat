/**
 * Local screenshot capture for `token-goat screenshot`, so a page render can
 * reach the model as a small shrunk image instead of round-tripping through
 * a separate browser-automation MCP tool. Uses `puppeteer-core` (drives an
 * existing browser via CDP, never bundles/downloads Chromium) and reuses
 * `shrinkImage()` -- the same function `preReadImageHandler` already applies
 * to local file reads -- so the output goes through one shrink pipeline.
 */

import dns from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { urlPolicyDenialReason } from './url_policy.js'
import { shrinkImage } from './image_shrink.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { atomicWriteBytes, redactUrlQuery, withExtension } from './util.js'

export interface ScreenshotOptions {
  executablePath?: string
  width?: number
  height?: number
  fullPage?: boolean
  /** Extra Chromium command-line flags. Not exposed on the CLI: this exists so the SSRF
   * regression tests can point a hostname at a local server via `--host-resolver-rules`. Any MAP
   * rule here is also read as the authoritative resolution for that host, because it IS what
   * Chromium will dial -- the policy must judge the address actually connected to. */
  extraLaunchArgs?: string[]
}

export interface ScreenshotResult {
  path: string
  originalBytes: number
  finalBytes: number
}

// Narrow structural type for the one puppeteer-core surface this module uses, so the module compiles/tests without puppeteer-core's own types installed.
interface PuppeteerRequest {
  url(): string
  isNavigationRequest(): boolean
  abort(): Promise<void>
  continue(): Promise<void>
  frame?(): unknown
}
interface PuppeteerPage {
  setViewport(opts: { width: number; height: number }): Promise<void>
  setRequestInterception(enabled: boolean): Promise<void>
  on(event: 'request', handler: (req: PuppeteerRequest) => void): void
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>
  screenshot(opts: { type: string; fullPage: boolean }): Promise<Buffer>
  mainFrame?(): unknown
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
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): classify by the embedded IPv4 value, so [::ffff:169.254.169.254] is blocked for the same reason 169.254.169.254 is.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = groups[6] as number
    return isBlockedIpv4Octets(embedded >> 8, embedded & 0xff)
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the low 32 bits are a real IPv4 address a NAT64 gateway will translate back out, so 64:ff9b::a9fe:a9fe reaches 169.254.169.254. Same "encoded IPv4 must be decoded before classifying" class as the mapped/compatible case above.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const embedded = groups[6] as number
    return isBlockedIpv4Octets(embedded >> 8, embedded & 0xff)
  }
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if (((groups[0] as number) & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  return false
}

/** Classifies one IP *address* (never a name). Split out of isBlockedLiteralIp so that addresses
 * coming back from a DNS answer -- which are always literals -- run through the exact same
 * ranges as a literal typed into the URL, instead of a second list that would drift. */
export function isBlockedIpAddress(addr: string): boolean {
  const bare = addr.replace(/^\[/, '').replace(/\]$/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (v4) return isBlockedIpv4Octets(Number(v4[1]), Number(v4[2]))
  const groups = parseIpv6Groups(bare)
  return groups !== null && isBlockedIpv6(groups)
}

/** Returns the first blocked address in a resolution answer, or null when every address is
 * allowed. ANY blocked address rejects the whole host: an attacker owns their own record set, so
 * a host answering both a public A record and a private one must not be reachable at all. */
export function blockedAddressAmong(addresses: readonly string[]): string | null {
  return addresses.find((addr) => isBlockedIpAddress(addr)) ?? null
}

// Loopback and link-local (incl. cloud metadata at 169.254.169.254) are always rejected when literal IPs; RFC1918 private ranges are the other block class. This is the synchronous literal-IP half of the policy; the DNS-rebinding half (a *name* that resolves into one of these ranges) lives in resolveTargetForPolicy below, which resolves the name and classifies the answers through the very same isBlockedIpAddress.
function isBlockedLiteralIp(host: string): boolean {
  if (host === 'localhost') return true
  return isBlockedIpAddress(host)
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
  // A screenshot URL can be signed (SAS token, share signature), so error text shows only origin + pathname, never the query string -- otherwise a URL rejected for its scheme prints its own access token into stderr and from there into the model's context.
  const safeUrl = parsed.origin !== 'null' ? parsed.origin + parsed.pathname : redactUrlQuery(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Rejected screenshot URL scheme "${parsed.protocol}" (only http:/https: are allowed): ${safeUrl}`
  }
  // The headless browser is the third way bytes leave this machine, after the WebFetch hook and
  // performHttpFetch, and it was the one channel webfetch.allow/webfetch.deny never reached: an
  // install configured to deny everything still rendered whatever URL it was handed. Checking here
  // rather than at the command entry point is deliberate -- this function is re-applied by the
  // request-interception hook to every redirect hop and every sub-resource the page loads, so an
  // allowed page cannot pull an image, script, or iframe from a denied host either.
  const policyDenial = urlPolicyDenialReason(url, loadConfig().webfetch)
  if (policyDenial !== null) {
    return `Rejected screenshot target: ${policyDenial}: ${safeUrl}`
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

const HOST_RESOLVER_FLAG = '--host-resolver-rules='
/** How many cross-host navigation hops (redirects) are re-launched with a fresh pin before the
 * capture is abandoned. Real redirect chains are short; this only bounds a hostile loop. */
const MAX_PIN_HOPS = 5

/** Reads the `MAP <pattern> <target>` clauses out of any caller-supplied --host-resolver-rules.
 * These rules ARE Chromium's resolver, so they are the truth about what it will dial; honouring
 * them here keeps the address this module validates identical to the address that gets
 * connected to, which is the whole point of the exercise. First rule for a pattern wins, matching
 * Chromium's own first-match-wins ordering. */
export function parseHostResolverMap(args: readonly string[]): Map<string, string> {
  const rules = new Map<string, string>()
  for (const arg of args) {
    if (!arg.startsWith(HOST_RESOLVER_FLAG)) continue
    for (const clause of arg.slice(HOST_RESOLVER_FLAG.length).split(',')) {
      const parts = clause.trim().split(/\s+/)
      if (parts.length < 3 || (parts[0] as string).toUpperCase() !== 'MAP') continue
      const pattern = (parts[1] as string).toLowerCase()
      if (!rules.has(pattern)) rules.set(pattern, parts[2] as string)
    }
  }
  return rules
}

/** Strips the optional `:port` off a resolver-rule target, handling `[v6]:port` bracket form. A
 * bare IPv6 literal keeps all its colons, so only a single trailing colon is treated as a port. */
function mapTargetHost(target: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(target)
  if (bracketed) return bracketed[1] as string
  const colon = target.indexOf(':')
  if (colon !== -1 && target.indexOf(':', colon + 1) === -1) return target.slice(0, colon)
  return target
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || parseIpv6Groups(host) !== null
}

/** Resolves a hostname to every address it answers with, so the policy can be applied to the
 * addresses rather than to the name. Literals resolve to themselves; resolver-rule targets take
 * precedence over real DNS because Chromium will obey them; everything else goes to dns.lookup
 * with all:true so both A and AAAA answers are classified, not just the first one. Rejects
 * rather than returning empty on failure -- callers fail closed. */
async function resolveHostAddresses(host: string, mapRules: Map<string, string>): Promise<string[]> {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (isIpLiteral(bare)) return [bare]
  const mapped = mapRules.get(bare) ?? mapRules.get('*')
  if (mapped !== undefined) {
    const target = mapTargetHost(mapped)
    // `~NOTFOUND` and friends are Chromium's "make this fail to resolve" directives.
    if (target.startsWith('~')) throw new Error(`resolver rule maps it to ${target}`)
    if (isIpLiteral(target)) return [target]
    if (target.toLowerCase() !== bare) return resolveHostAddresses(target, mapRules)
  }
  const answers = await dns.lookup(bare, { all: true })
  return answers.map((a) => a.address)
}

/** The async half of the screenshot target policy: resolve the host, then apply the identical
 * address ranges the synchronous literal check uses. Returns the resolved addresses alongside the
 * verdict so an allowed host can be *pinned* to exactly what was validated. */
export async function resolveTargetForPolicy(
  rawUrl: string,
  mapRules: Map<string, string>,
): Promise<{ reason: string | null; host: string; addresses: string[] }> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { reason: `Invalid screenshot URL: ${redactUrlQuery(rawUrl)}`, host: '', addresses: [] }
  }
  const host = parsed.hostname
  const optIn = 'Set screenshot.block_private_targets = false in token-goat config to opt in for legitimate internal-service screenshots.'
  let addresses: string[]
  try {
    addresses = await resolveHostAddresses(host, mapRules)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // Fail closed: an unresolvable name must not be handed to the browser to resolve unchecked.
    return { reason: `Rejected screenshot target "${host}": DNS resolution failed (${detail}). ${optIn}`, host, addresses: [] }
  }
  if (addresses.length === 0) {
    return { reason: `Rejected screenshot target "${host}": DNS returned no addresses. ${optIn}`, host, addresses: [] }
  }
  const blocked = blockedAddressAmong(addresses)
  if (blocked !== null) {
    return {
      reason: `Rejected screenshot target "${host}" (resolves to ${blocked}, a loopback/link-local/private IP). ${optIn}`,
      host,
      addresses,
    }
  }
  return { reason: null, host, addresses }
}

/** Rewrites the launch args so every validated host carries a `MAP host <validated address>`
 * pin. Without this, Chromium performs its OWN lookup after our check and the answer can differ
 * -- that gap between the two resolutions IS the DNS-rebinding attack. Caller-supplied rules are
 * kept first so their patterns keep winning, and are never duplicated. */
function withPins(callerArgs: readonly string[], pins: ReadonlyMap<string, string>): string[] {
  if (pins.size === 0) return [...callerArgs]
  const clauses: string[] = []
  for (const arg of callerArgs) {
    if (arg.startsWith(HOST_RESOLVER_FLAG)) clauses.push(arg.slice(HOST_RESOLVER_FLAG.length))
  }
  for (const [host, addr] of pins) {
    clauses.push(`MAP ${host} ${addr.includes(':') ? `[${addr}]` : addr}`)
  }
  const rest = callerArgs.filter((a) => !a.startsWith(HOST_RESOLVER_FLAG))
  return [...rest, `${HOST_RESOLVER_FLAG}${clauses.join(',')}`]
}

function hostKey(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  } catch {
    return ''
  }
}

/** True when Chromium's resolver is already fixed for this host, so no second lookup can differ
 * from the one that was validated: a literal address, one of our pins, or a caller rule. */
function isPinned(host: string, pins: ReadonlyMap<string, string>, mapRules: ReadonlyMap<string, string>): boolean {
  return isIpLiteral(host) || pins.has(host) || mapRules.has(host) || mapRules.has('*')
}

interface CaptureContext {
  puppeteer: PuppeteerModule
  executablePath: string
  launchArgs: string[]
  enforce: boolean
  mapRules: Map<string, string>
  pins: Map<string, string>
  opts: ScreenshotOptions | undefined
}

/** One browser launch + navigation. Resolves to the captured bytes, or -- when the main frame
 * tries to navigate to a host that is not yet pinned (a cross-host redirect) -- to that hop's
 * URL, so the caller can validate and pin it and try again. */
async function captureOnce(url: string, ctx: CaptureContext): Promise<{ buffer: Buffer } | { redirectTo: string }> {
  const browser = await ctx.puppeteer.launch({ headless: true, executablePath: ctx.executablePath, args: ctx.launchArgs })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: ctx.opts?.width ?? 1280, height: ctx.opts?.height ?? 800 })
    const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined

    // The pre-flight validation only sees the FIRST url; page.goto follows redirects, so `http://attacker.example/r` answering `302 Location: http://169.254.169.254/` would otherwise render cloud metadata. Request interception re-applies the identical policy -- now including the DNS-resolution half -- to every request the page makes: each redirect hop arrives as its own request event, and so does every sub-resource (image/script/iframe/XHR).
    //
    // data:/blob:/about: sub-resources are allowed through deliberately: they are page-local, cause no network egress, and aborting them would break rendering of legitimate inline images for no security gain.
    const navRefusal: { reason: string | null } = { reason: null }
    const hop: { url: string | null } = { url: null }
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      void (async () => {
        try {
          const target = req.url()
          const isNav = req.isNavigationRequest()
          if (!isNav && /^(data|blob|about):/i.test(target)) {
            await req.continue()
            return
          }
          const refusal = screenshotUrlRefusal(target)
          if (refusal !== null) {
            // A blocked navigation (i.e. a redirect hop) fails the whole render: that page is the thing being captured. A blocked sub-resource is just dropped -- the rest of the page is still a legitimate capture, and one hostile <img> shouldn't deny the user a screenshot. Only the first navigation refusal is kept; it diverted the render.
            if (isNav && navRefusal.reason === null) navRefusal.reason = refusal
            await req.abort()
            return
          }
          if (ctx.enforce) {
            const host = hostKey(target)
            const isMainFrame = isNav && (mainFrame === undefined || req.frame?.() === mainFrame)
            // A main-frame hop to an unpinned host is bounced back to the caller rather than continued: continuing would let Chromium resolve it independently of our check, which is exactly the rebinding gap. The retry re-launches with it pinned.
            if (isMainFrame && !isPinned(host, ctx.pins, ctx.mapRules)) {
              if (hop.url === null) hop.url = target
              await req.abort()
              return
            }
            const verdict = await resolveTargetForPolicy(target, ctx.mapRules)
            if (verdict.reason !== null) {
              if (isNav && navRefusal.reason === null) navRefusal.reason = verdict.reason
              await req.abort()
              return
            }
          }
          await req.continue()
        } catch {
          // The request was already handled or the page went away mid-decision; nothing to do.
        }
      })()
    })

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
    } catch (err) {
      if (hop.url !== null) return { redirectTo: hop.url }
      // An aborted main-frame navigation surfaces as a generic net::ERR_FAILED, which would hide why it failed -- report the policy refusal instead.
      if (navRefusal.reason !== null) throw new Error(navRefusal.reason, { cause: err })
      throw err
    }
    if (hop.url !== null) return { redirectTo: hop.url }
    // A blocked redirect can also resolve without rejecting (the browser lands on an error page), so refuse on any recorded navigation refusal rather than trusting goto's outcome alone.
    if (navRefusal.reason !== null) throw new Error(navRefusal.reason)
    return { buffer: await page.screenshot({ type: 'png', fullPage: ctx.opts?.fullPage ?? false }) }
  } finally {
    await browser.close()
  }
}

export async function takeScreenshot(url: string, destPath: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
  validateScreenshotUrl(url)
  if (loadConfig().network.offline) {
    throw new Error(`Offline mode is on (network.offline): refusing to navigate to ${url}`)
  }
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

  const callerArgs = opts?.extraLaunchArgs ?? []
  const mapRules = parseHostResolverMap(callerArgs)
  const enforce = loadConfig().screenshot.block_private_targets
  const pins = new Map<string, string>()
  let targetUrl = url
  let buffer: Buffer | null = null
  for (let attempt = 0; attempt < MAX_PIN_HOPS; attempt++) {
    if (enforce) {
      // Resolve the name, refuse on any private answer, then PIN the surviving address into Chromium's resolver. Validating a lookup and letting Chromium run its own is the rebinding hole; the pin makes the validated address the connected address.
      const verdict = await resolveTargetForPolicy(targetUrl, mapRules)
      if (verdict.reason !== null) throw new Error(verdict.reason)
      const host = hostKey(targetUrl)
      if (!isPinned(host, pins, mapRules)) pins.set(host, verdict.addresses[0] as string)
    }
    const ctx: CaptureContext = {
      puppeteer,
      executablePath,
      launchArgs: withPins(callerArgs, pins),
      enforce,
      mapRules,
      pins,
      opts,
    }
    const outcome = await captureOnce(targetUrl, ctx)
    if ('buffer' in outcome) {
      buffer = outcome.buffer
      break
    }
    targetUrl = outcome.redirectTo
  }
  if (buffer === null) {
    throw new Error(
      `Screenshot abandoned after ${MAX_PIN_HOPS} cross-host redirect hops (last: ${redactUrlQuery(targetUrl)})`,
    )
  }
  const shrunk = await shrinkImage(buffer)
  const finalBuffer = shrunk?.data ?? buffer
  // shrinkImage may re-encode the PNG capture to JPEG/WebP when it exceeds the shrink threshold; writing those bytes under the originally-requested (e.g. `.png`) extension would silently mislabel the file's actual format. Rename the destination extension to match the real output format and report the actual saved path.
  const finalPath = shrunk ? withExtension(destPath, shrunk.format) : destPath
  atomicWriteBytes(finalPath, finalBuffer)
  return { path: finalPath, originalBytes: buffer.length, finalBytes: finalBuffer.length }
}
