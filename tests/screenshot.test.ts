import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveBrowserExecutablePath, takeScreenshot } from '../src/screenshot.js'
import { clearModuleCaches } from '../src/reset.js'
import { shrinkImage } from '../src/image_shrink.js'

// Stub out the real browser drive so takeScreenshot's own extension/path-correction logic can
// be exercised without an actual Chrome install or network access. The captured "PNG" bytes
// are arbitrary; what matters is that shrinkImage (mocked below) reports a format change and
// takeScreenshot reacts to it correctly.
vi.mock('puppeteer-core', () => ({
  launch: vi.fn(async () => ({
    newPage: vi.fn(async () => ({
      setViewport: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('fake-png-bytes')),
    })),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock('../src/image_shrink.js', () => ({
  shrinkImage: vi.fn(),
}))

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-screenshot-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveBrowserExecutablePath', () => {
  // Isolates the Windows-candidate env vars so tests are deterministic even on a machine
  // (like this project's own dev box) that has a real Chrome install under Program Files.
  // localAppData defaults to a dir with nothing in it; pass an override to test the
  // Playwright-cache-under-LOCALAPPDATA discovery path specifically.
  function withIsolatedWindowsCandidates<T>(dir: string, fn: () => T, localAppData?: string): T {
    const saved = {
      LOCALAPPDATA: process.env['LOCALAPPDATA'],
      PROGRAMFILES: process.env['PROGRAMFILES'],
      'PROGRAMFILES(X86)': process.env['PROGRAMFILES(X86)'],
    }
    const savedPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env['LOCALAPPDATA'] = localAppData ?? path.join(dir, 'no-local-app-data')
    process.env['PROGRAMFILES'] = path.join(dir, 'no-program-files')
    process.env['PROGRAMFILES(X86)'] = path.join(dir, 'no-program-files-x86')
    try {
      return fn()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform })
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('returns null when nothing resolves (no explicit path, no config, no env, no real install found)', () => {
    const dir = makeTmpDir()
    const nonexistent = path.join(dir, 'no-such-chrome.exe')
    withIsolatedWindowsCandidates(dir, () => {
      expect(resolveBrowserExecutablePath(nonexistent)).toBeNull()
    })
  })

  it('prefers an explicit path that actually exists over everything else', () => {
    const dir = makeTmpDir()
    const fakeChrome = path.join(dir, 'chrome.exe')
    fs.writeFileSync(fakeChrome, 'not a real binary, just needs to exist')

    expect(resolveBrowserExecutablePath(fakeChrome)).toBe(fakeChrome)
  })

  it('ignores an explicit path that does not exist and falls through to other sources', () => {
    const dir = makeTmpDir()
    const missing = path.join(dir, 'missing-chrome.exe')

    withIsolatedWindowsCandidates(dir, () => {
      expect(resolveBrowserExecutablePath(missing)).toBeNull()
    })
  })

  it('finds a Playwright Chrome-for-Testing cache install and prefers the highest version dir', () => {
    const dir = makeTmpDir()
    const msPlaywright = path.join(dir, 'ms-playwright')
    const older = path.join(msPlaywright, 'chromium-1000', 'chrome-win64')
    const newer = path.join(msPlaywright, 'chromium-1223', 'chrome-win64')
    fs.mkdirSync(older, { recursive: true })
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(path.join(older, 'chrome.exe'), 'old')
    fs.writeFileSync(path.join(newer, 'chrome.exe'), 'new')

    withIsolatedWindowsCandidates(
      dir,
      () => {
        const result = resolveBrowserExecutablePath()
        expect(result).toBe(path.join(newer, 'chrome.exe'))
      },
      dir,
    )
  })
})

describe('takeScreenshot', () => {
  // Regression: shrinkImage may re-encode the PNG capture to JPEG/WebP when it exceeds the
  // shrink threshold, but the shrunk bytes were written verbatim under the originally
  // requested (e.g. `.png`) destPath -- silently mislabeling the file's real format -- and the
  // success result still reported that same requested path.
  it('renames the destination extension to match a format-changing shrink and reports the actual saved path', async () => {
    const dir = makeTmpDir()
    const fakeChrome = path.join(dir, 'chrome.exe')
    fs.writeFileSync(fakeChrome, 'not a real binary, just needs to exist')

    vi.mocked(shrinkImage).mockResolvedValueOnce({
      data: Buffer.from('fake-jpeg-bytes'),
      format: 'jpeg',
      shrunkBytes: 15,
      width: 10,
      height: 10,
    } as Awaited<ReturnType<typeof shrinkImage>>)

    const destPath = path.join(dir, 'out.png')
    const result = await takeScreenshot('https://example.com', destPath, { executablePath: fakeChrome })

    const expectedPath = path.join(dir, 'out.jpg')
    expect(result.path).toBe(expectedPath)
    expect(fs.existsSync(expectedPath)).toBe(true)
    expect(fs.existsSync(destPath)).toBe(false)
    expect(fs.readFileSync(expectedPath).toString()).toBe('fake-jpeg-bytes')
  })

  it('keeps the requested destPath extension when shrinkImage does not change the format (null result)', async () => {
    const dir = makeTmpDir()
    const fakeChrome = path.join(dir, 'chrome.exe')
    fs.writeFileSync(fakeChrome, 'not a real binary, just needs to exist')

    vi.mocked(shrinkImage).mockResolvedValueOnce(null)

    const destPath = path.join(dir, 'out.png')
    const result = await takeScreenshot('https://example.com', destPath, { executablePath: fakeChrome })

    expect(result.path).toBe(destPath)
    expect(fs.existsSync(destPath)).toBe(true)
  })
})
