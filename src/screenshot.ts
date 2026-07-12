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
import { atomicWriteBytes, withExtension } from './util.js'

export interface ScreenshotOptions {
  executablePath?: string
  width?: number
  height?: number
  fullPage?: boolean
}

export interface ScreenshotResult {
  path: string
  originalBytes: number
  finalBytes: number
}

// Narrow structural type for the one puppeteer-core surface this module uses,
// so the module compiles/tests without puppeteer-core's own types installed.
interface PuppeteerPage {
  setViewport(opts: { width: number; height: number }): Promise<void>
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>
  screenshot(opts: { type: string; fullPage: boolean }): Promise<Buffer>
}
interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>
  close(): Promise<void>
}
interface PuppeteerModule {
  launch(opts: { headless: boolean; executablePath: string }): Promise<PuppeteerBrowser>
}

let _puppeteerCache: PuppeteerModule | null | undefined

async function loadPuppeteer(): Promise<PuppeteerModule | null> {
  if (_puppeteerCache !== undefined) return _puppeteerCache
  try {
    const mod = (await import('puppeteer-core')) as unknown as PuppeteerModule
    _puppeteerCache = mod
  } catch (err) {
    process.stderr.write(`token-goat: screenshot disabled (puppeteer-core unavailable): ${String(err)}\n`)
    _puppeteerCache = null
  }
  return _puppeteerCache
}

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

export async function takeScreenshot(url: string, destPath: string, opts?: ScreenshotOptions): Promise<ScreenshotResult> {
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

  const browser = await puppeteer.launch({ headless: true, executablePath })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: opts?.width ?? 1280, height: opts?.height ?? 800 })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
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
