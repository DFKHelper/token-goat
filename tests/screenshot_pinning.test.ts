/**
 * The half of the DNS-rebinding fix that a real-Chrome test cannot observe: that the address the
 * policy validated is *pinned* into Chromium's resolver, so Chromium cannot perform a second,
 * independent lookup whose answer differs. That gap between two resolutions IS the rebinding
 * attack, and closing it is invisible from the outside -- both a pinned and an unpinned capture
 * simply succeed. So this drives the real takeScreenshot with puppeteer and node:dns stubbed, and
 * asserts on the launch flags and the request decisions the production code actually makes.
 *
 * Chrome's own resolver rules are also the reason the e2e tests can be hermetic; here they are
 * the artefact under test rather than the harness.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { takeScreenshot } from '../src/screenshot.js'
import { clearModuleCaches } from '../src/reset.js'

interface ScriptedRequest {
  url: string
  isNav: boolean
  mainFrame?: boolean
}

const state = vi.hoisted(() => ({
  launchArgs: [] as string[][],
  /** Requests the fake page replays through the real interception handler, per launch. */
  scripts: [] as ScriptedRequest[][],
  decisions: [] as Array<{ url: string; action: string }>,
  /** hostname -> addresses the stubbed resolver answers with. */
  dns: new Map<string, string[]>(),
}))

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: async (host: string) => {
      const addresses = state.dns.get(host.toLowerCase())
      if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    },
  },
}))

vi.mock('puppeteer-core', () => ({
  launch: vi.fn(async (opts: { args?: string[] }) => {
    const launchIndex = state.launchArgs.length
    state.launchArgs.push(opts.args ?? [])
    const handlers: Array<(req: unknown) => void> = []
    return {
      newPage: vi.fn(async () => ({
        setViewport: vi.fn(async () => {}),
        setRequestInterception: vi.fn(async () => {}),
        on: vi.fn((_event: string, handler: (req: unknown) => void) => handlers.push(handler)),
        mainFrame: () => 'main-frame',
        goto: vi.fn(async () => {
          for (const spec of state.scripts[launchIndex] ?? []) {
            const outcome = { action: '' }
            const req = {
              url: () => spec.url,
              isNavigationRequest: () => spec.isNav,
              frame: () => (spec.mainFrame === false ? 'sub-frame' : 'main-frame'),
              abort: async () => {
                outcome.action = 'abort'
              },
              continue: async () => {
                outcome.action = 'continue'
              },
            }
            for (const handler of handlers) handler(req)
            // The handler is async (it may resolve DNS); give it bounded time to decide.
            for (let tick = 0; tick < 200 && outcome.action === ''; tick++) {
              await new Promise((resolve) => setTimeout(resolve, 1))
            }
            state.decisions.push({ url: spec.url, action: outcome.action })
          }
        }),
        screenshot: vi.fn(async () => Buffer.from('fake-png-bytes')),
      })),
      close: vi.fn(async () => {}),
    }
  }),
}))

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pin-'))
  tmpDirs.push(dir)
  return dir
}

/** A file that exists, so resolveBrowserExecutablePath accepts it without a real Chrome. */
function fakeChrome(dir: string): string {
  const p = path.join(dir, 'chrome.exe')
  fs.writeFileSync(p, '')
  return p
}

function resolverRules(args: string[]): string {
  return args.find((a) => a.startsWith('--host-resolver-rules=')) ?? ''
}

beforeEach(() => {
  clearModuleCaches()
  state.launchArgs.length = 0
  state.scripts.length = 0
  state.decisions.length = 0
  state.dns.clear()
})

afterEach(() => {
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('takeScreenshot address pinning', () => {
  it('pins the validated address into Chromium so it cannot resolve the host a second time', async () => {
    const dir = makeTmpDir()
    state.dns.set('public.example', ['93.184.216.34'])
    state.scripts[0] = []
    await takeScreenshot('https://public.example/page', path.join(dir, 'a.png'), {
      executablePath: fakeChrome(dir),
    })
    expect(state.launchArgs).toHaveLength(1)
    expect(resolverRules(state.launchArgs[0] as string[])).toBe(
      '--host-resolver-rules=MAP public.example 93.184.216.34',
    )
  })

  it('brackets an IPv6 pin and keeps caller-supplied rules ahead of it', async () => {
    const dir = makeTmpDir()
    state.dns.set('v6.example', ['2606:2800:220:1:248:1893:25c8:1946'])
    state.scripts[0] = []
    await takeScreenshot('https://v6.example/page', path.join(dir, 'a.png'), {
      executablePath: fakeChrome(dir),
      extraLaunchArgs: ['--host-resolver-rules=MAP other.example 93.184.216.34', '--headless=new'],
    })
    const args = state.launchArgs[0] as string[]
    expect(resolverRules(args)).toBe(
      '--host-resolver-rules=MAP other.example 93.184.216.34,MAP v6.example [2606:2800:220:1:248:1893:25c8:1946]',
    )
    expect(args).toContain('--headless=new')
    // Exactly one --host-resolver-rules flag: Chromium honours one, so appending a second would silently drop either the caller's mapping or our pin.
    expect(args.filter((a) => a.startsWith('--host-resolver-rules=')).length).toBe(1)
  })

  it('refuses a host whose record set mixes a public and a private address', async () => {
    const dir = makeTmpDir()
    state.dns.set('mixed.example', ['93.184.216.34', '169.254.169.254'])
    await expect(
      takeScreenshot('https://mixed.example/page', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) }),
    ).rejects.toThrow(/resolves to 169\.254\.169\.254/)
    expect(state.launchArgs).toHaveLength(0)
  })

  it('re-launches with a fresh pin when the main frame is redirected to another host', async () => {
    const dir = makeTmpDir()
    state.dns.set('first.example', ['93.184.216.34'])
    state.dns.set('second.example', ['198.51.100.7'])
    // Launch 0 sees the redirect hop to an unpinned host; launch 1 is the pinned retry.
    state.scripts[0] = [{ url: 'https://second.example/landing', isNav: true, mainFrame: true }]
    state.scripts[1] = []
    await takeScreenshot('https://first.example/r', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) })
    expect(state.decisions).toEqual([{ url: 'https://second.example/landing', action: 'abort' }])
    expect(state.launchArgs).toHaveLength(2)
    // The hop is not merely re-validated -- it is pinned, so the retry's connection goes to the address that was checked rather than to whatever a second lookup would have returned.
    expect(resolverRules(state.launchArgs[1] as string[])).toBe(
      '--host-resolver-rules=MAP first.example 93.184.216.34,MAP second.example 198.51.100.7',
    )
  })

  it('aborts a redirect hop whose host resolves private, and reports why', async () => {
    const dir = makeTmpDir()
    state.dns.set('first.example', ['93.184.216.34'])
    state.dns.set('rebound.example', ['127.0.0.1'])
    state.scripts[0] = [{ url: 'https://rebound.example/x', isNav: true, mainFrame: true }]
    state.scripts[1] = []
    await expect(
      takeScreenshot('https://first.example/r', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) }),
    ).rejects.toThrow(/rebound\.example.*resolves to 127\.0\.0\.1/)
    expect(state.decisions).toEqual([{ url: 'https://rebound.example/x', action: 'abort' }])
  })

  it('drops a rebinding sub-resource but lets an allowed one through', async () => {
    const dir = makeTmpDir()
    state.dns.set('first.example', ['93.184.216.34'])
    state.dns.set('cdn.example', ['198.51.100.9'])
    state.dns.set('sneaky.example', ['169.254.169.254'])
    state.scripts[0] = [
      { url: 'https://cdn.example/style.css', isNav: false },
      { url: 'https://sneaky.example/pixel.png', isNav: false },
      { url: 'data:image/png;base64,AAAA', isNav: false },
    ]
    await takeScreenshot('https://first.example/p', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) })
    expect(state.decisions).toEqual([
      { url: 'https://cdn.example/style.css', action: 'continue' },
      { url: 'https://sneaky.example/pixel.png', action: 'abort' },
      { url: 'data:image/png;base64,AAAA', action: 'continue' },
    ])
  })

  it('aborts a sub-resource whose host does not resolve at all', async () => {
    const dir = makeTmpDir()
    state.dns.set('first.example', ['93.184.216.34'])
    state.scripts[0] = [{ url: 'https://nowhere.example/x.js', isNav: false }]
    await takeScreenshot('https://first.example/p', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) })
    expect(state.decisions).toEqual([{ url: 'https://nowhere.example/x.js', action: 'abort' }])
  })

  it('gives up after a bounded number of cross-host hops instead of looping forever', async () => {
    const dir = makeTmpDir()
    state.dns.set('first.example', ['93.184.216.34'])
    for (let i = 0; i < 8; i++) {
      state.dns.set(`hop${i}.example`, ['198.51.100.20'])
      state.scripts[i] = [{ url: `https://hop${i}.example/`, isNav: true, mainFrame: true }]
    }
    await expect(
      takeScreenshot('https://first.example/r', path.join(dir, 'a.png'), { executablePath: fakeChrome(dir) }),
    ).rejects.toThrow(/cross-host redirect hops/)
  })

  it('does not resolve or pin anything when the private-target policy is opted out', async () => {
    const dir = makeTmpDir()
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    clearModuleCaches()
    state.scripts[0] = [{ url: 'http://169.254.169.254/latest/meta-data/', isNav: false }]
    try {
      await takeScreenshot('https://unresolvable.example/p', path.join(dir, 'a.png'), {
        executablePath: fakeChrome(dir),
      })
    } finally {
      delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
      clearModuleCaches()
    }
    expect(resolverRules(state.launchArgs[0] as string[])).toBe('')
    expect(state.decisions).toEqual([{ url: 'http://169.254.169.254/latest/meta-data/', action: 'continue' }])
  })
})
