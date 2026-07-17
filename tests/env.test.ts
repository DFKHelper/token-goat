import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { envBool, envInt, envStr } from '../src/env.js'

const KEY = 'TOKEN_GOAT_TEST_ENV_VAR'

describe('env parsers', () => {
  beforeEach(() => {
    delete process.env[KEY]
  })

  afterEach(() => {
    delete process.env[KEY]
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

    it('trims surrounding whitespace before parsing, like envStr/envBool', () => {
      process.env[KEY] = ' 42 '
      expect(envInt(KEY, 0)).toBe(42)
    })

    it('does not clamp when min/max are omitted (unchanged behavior)', () => {
      process.env[KEY] = '99999999'
      expect(envInt(KEY, 10)).toBe(99999999)
    })

    it('clamps a value above max into range when min/max are supplied', () => {
      process.env[KEY] = '99999999'
      expect(envInt(KEY, 10, 1, 3600)).toBe(3600)
    })

    it('clamps a value below min into range when min/max are supplied', () => {
      process.env[KEY] = '-5'
      expect(envInt(KEY, 10, 1, 3600)).toBe(1)
    })

    it('leaves an in-range value untouched when min/max are supplied', () => {
      process.env[KEY] = '42'
      expect(envInt(KEY, 10, 1, 3600)).toBe(42)
    })

    it('clamps a value below min when only min is supplied', () => {
      process.env[KEY] = '-5'
      expect(envInt(KEY, 10, 1)).toBe(1)
    })

    it('does not clamp a value above min when only min is supplied', () => {
      process.env[KEY] = '99999999'
      expect(envInt(KEY, 10, 1)).toBe(99999999)
    })

    it('clamps a value above max when only max is supplied', () => {
      process.env[KEY] = '99999999'
      expect(envInt(KEY, 10, undefined, 3600)).toBe(3600)
    })

    it('does not clamp a value below max when only max is supplied', () => {
      process.env[KEY] = '-5'
      expect(envInt(KEY, 10, undefined, 3600)).toBe(-5)
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
