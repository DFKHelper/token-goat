import { describe, expect, it, vi } from 'vitest'
import { compareSemver, checkUpdateStatus, cmdUpgrade } from '../src/cli_upgrade.js'
import { VERSION } from '../src/version.js'

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
})
