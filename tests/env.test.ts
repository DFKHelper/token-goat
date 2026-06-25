import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { envBool, envFloat, envInt, envStr } from '../src/env.js'

const KEY = 'TOKEN_GOAT_TEST_ENV_VAR'

describe('env parsers', () => {
  beforeEach(() => {
    delete process.env[KEY]
  })

  afterEach(() => {
    delete process.env[KEY]
  })

  describe('envFloat', () => {
    it('returns the default for an overflowing literal (1e400 -> Infinity)', () => {
      process.env[KEY] = '1e400'
      expect(envFloat(KEY, 3.5)).toBe(3.5)
    })

    it('returns the default when unset', () => {
      expect(envFloat(KEY, 2.25)).toBe(2.25)
    })

    it('returns the default for an empty string', () => {
      process.env[KEY] = ''
      expect(envFloat(KEY, 9.9)).toBe(9.9)
    })

    it('returns the default for non-numeric input', () => {
      process.env[KEY] = 'abc'
      expect(envFloat(KEY, 1.1)).toBe(1.1)
    })

    it('parses a valid float', () => {
      process.env[KEY] = '0.5'
      expect(envFloat(KEY, 1.0)).toBe(0.5)
    })

    it('parses a valid negative float', () => {
      process.env[KEY] = '-12.75'
      expect(envFloat(KEY, 0)).toBe(-12.75)
    })
  })

  describe('envInt', () => {
    it('returns the default for a float string (1.5)', () => {
      process.env[KEY] = '1.5'
      expect(envInt(KEY, 7)).toBe(7)
    })

    it('returns the default for scientific notation (1e3)', () => {
      process.env[KEY] = '1e3'
      expect(envInt(KEY, 7)).toBe(7)
    })

    it('returns the default when unset', () => {
      expect(envInt(KEY, 42)).toBe(42)
    })

    it('returns the default for an empty string', () => {
      process.env[KEY] = ''
      expect(envInt(KEY, 42)).toBe(42)
    })

    it('parses a valid integer', () => {
      process.env[KEY] = '256'
      expect(envInt(KEY, 0)).toBe(256)
    })

    it('parses a signed integer', () => {
      process.env[KEY] = '-8'
      expect(envInt(KEY, 0)).toBe(-8)
      process.env[KEY] = '+8'
      expect(envInt(KEY, 0)).toBe(8)
    })
  })

  describe('envStr', () => {
    it('returns the default when unset', () => {
      expect(envStr(KEY, 'fallback')).toBe('fallback')
    })

    it('returns the trimmed value when set', () => {
      process.env[KEY] = '  value  '
      expect(envStr(KEY, 'fallback')).toBe('value')
    })

    it('returns the default for a whitespace-only value', () => {
      process.env[KEY] = '   '
      expect(envStr(KEY, 'fallback')).toBe('fallback')
    })
  })

  describe('envBool', () => {
    it('parses canonical truthy values case-insensitively', () => {
      for (const v of ['1', 'true', 'YES', 'On']) {
        process.env[KEY] = v
        expect(envBool(KEY, false)).toBe(true)
      }
    })

    it('parses canonical falsy values case-insensitively', () => {
      for (const v of ['0', 'FALSE', 'no', 'Off']) {
        process.env[KEY] = v
        expect(envBool(KEY, true)).toBe(false)
      }
    })

    it('returns the default when unset or unrecognized', () => {
      expect(envBool(KEY, true)).toBe(true)
      process.env[KEY] = 'maybe'
      expect(envBool(KEY, true)).toBe(true)
      expect(envBool(KEY, false)).toBe(false)
    })
  })
})
