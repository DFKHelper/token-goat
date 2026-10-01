import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  compareSemver,
  checkUpdateStatus,
  cmdUpgrade,
  getRegistryUrl,
  getCachedUpdateStatus,
  saveCachedUpdateStatus,
} from '../src/cli_upgrade.js'
import { VERSION } from '../src/version.js'
import { renderStats } from '../src/render/stats_renderer.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import type { StatsData } from '../src/render/types.js'

describe('cli_upgrade', () => {
  describe('compareSemver', () => {
    it('correctly compares equal versions', () => {
      expect(compareSemver('2.9.12', '2.9.12')).toBe(0)
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    })

    it('identifies newer versions correctly', () => {
      expect(compareSemver('2.10.0', '2.9.12')).toBe(1)
      expect(compareSemver('3.0.0', '2.9.12')).toBe(1)
      expect(compareSemver('2.9.13', '2.9.12')).toBe(1)
    })

    it('identifies older versions correctly', () => {
      expect(compareSemver('2.9.11', '2.9.12')).toBe(-1)
      expect(compareSemver('1.9.99', '2.0.0')).toBe(-1)
      expect(compareSemver('2.8.0', '2.9.0')).toBe(-1)
    })

    it('tolerates prerelease tags', () => {
      expect(compareSemver('2.10.0-beta.1', '2.9.12')).toBe(1)
      expect(compareSemver('2.9.12-rc.1', '2.9.12')).toBe(0)
    })
  })

  describe('checkUpdateStatus', () => {
    it('returns a valid structure with current version', async () => {
      const res = await checkUpdateStatus(1000)
      expect(res.current).toBe(VERSION)
      expect(typeof res.updateAvailable).toBe('boolean')
      if (res.latest) {
        expect(typeof res.latest).toBe('string')
      } else {
        expect(res.error).toBeDefined()
      }
    })
  })

  describe('cmdUpgrade', () => {
    it('handles --check with --json output', async () => {
      const logs: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logs.push(String(msg))
      })
      try {
        await cmdUpgrade({ check: true, json: true })
        expect(logs.length).toBeGreaterThan(0)
        const parsed = JSON.parse(logs[0]!) as { current: string; updateAvailable: boolean }
        expect(parsed.current).toBe(VERSION)
        expect(typeof parsed.updateAvailable).toBe('boolean')
      } finally {
        spy.mockRestore()
      }
    })

    it('handles --check in prose mode', async () => {
      const logs: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logs.push(String(msg))
      })
      try {
        await cmdUpgrade({ check: true, json: false })
        expect(logs.length).toBeGreaterThan(0)
        const output = logs.join('\n')
        expect(output).toMatch(/token-goat|Current version|Update available/)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('enterprise Artifactory and registry resolution', () => {
    const origEnv = { ...process.env }

    afterEach(() => {
      process.env = { ...origEnv }
    })

    it('defaults to npmjs.org when no registry env vars are set', () => {
      delete process.env.npm_config_registry
      delete process.env.NPM_CONFIG_REGISTRY
      expect(getRegistryUrl()).toBe('https://registry.npmjs.org/')
    })

    it('honors npm_config_registry from Artifactory / corporate config', () => {
      process.env.npm_config_registry = 'https://artifactory.corp.internal/artifactory/api/npm/npm-virtual'
      expect(getRegistryUrl()).toBe('https://artifactory.corp.internal/artifactory/api/npm/npm-virtual/')
    })

    it('honors NPM_CONFIG_REGISTRY from uppercase env var', () => {
      process.env.NPM_CONFIG_REGISTRY = 'https://nexus.corp.internal/repository/npm-group/'
      expect(getRegistryUrl()).toBe('https://nexus.corp.internal/repository/npm-group/')
    })
  })

  describe('update check caching and stats rendering', () => {
    it('round-trips cached update status and uses cache within TTL', async () => {
      saveCachedUpdateStatus({
        checkedAt: Date.now(),
        current: VERSION,
        latest: '99.0.0',
        updateAvailable: true,
      })

      const cached = getCachedUpdateStatus()
      expect(cached).not.toBeNull()
      expect(cached?.latest).toBe('99.0.0')
      expect(cached?.updateAvailable).toBe(true)

      // checkUpdateStatus without forceFresh should return the cached status immediately
      const status = await checkUpdateStatus(100, false)
      expect(status.latest).toBe('99.0.0')
      expect(status.updateAvailable).toBe(true)
    })

    it('renders update insight in token-goat stats when update is available', () => {
      saveCachedUpdateStatus({
        checkedAt: Date.now(),
        current: VERSION,
        latest: '99.0.0',
        updateAvailable: true,
      })

      const mockStats: StatsData = {
        period_start: new Date(0),
        period_end: new Date(86_400_000),
        totals: { events: 10, bytes: 500, tokens: 100, sparklines: null },
        by_kind: [{ kind: 'read', bytes: 500, tokens: 100, events: 10, bytes_mode_only: false }],
        by_day: [],
        by_project: [],
        by_command: [{ command: 'read', events: 10, bytes: 500, tokens: 100 }],
      }

      const output = stripAnsiEscapes(renderStats(mockStats))
      expect(output).toContain('Update available:')
      expect(output).toContain(`v${VERSION} → v99.0.0`)
      expect(output).toContain("Run 'token-goat upgrade'")
    })
  })
})
