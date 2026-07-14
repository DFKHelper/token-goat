/**
 * Guard against orphaned NUMERIC_FIELD_BOUNDS entries in src/config.ts.
 *
 * NUMERIC_FIELD_BOUNDS's own doc comment says every entry is "Extracted from _buildConfig" --
 * i.e. each key should name a real, live config field. An entry left over from a feature that
 * was never ported (or was later removed) is 100% dead code: config set on that key throws
 * "key not found" via walkParent before validateNumericField is ever reached, so the bound is
 * unreachable and misleads future maintainers into thinking the field is settable. This guard
 * fails loudly and locally if a bound key doesn't resolve to a real defaultConfig() field.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { defaultConfig } from '../../src/config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const CONFIG_SRC = path.join(ROOT, 'src', 'config.ts')

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatten(v as Record<string, unknown>, full))
    } else {
      keys.push(full)
    }
  }
  return keys
}

describe('NUMERIC_FIELD_BOUNDS entries all resolve to live config fields', () => {
  it('every bound key in src/config.ts::NUMERIC_FIELD_BOUNDS exists in defaultConfig()', () => {
    const src = fs.readFileSync(CONFIG_SRC, 'utf8')
    const tableMatch = /const NUMERIC_FIELD_BOUNDS[\s\S]*?=\s*\{([\s\S]*?)\n\}/.exec(src)
    expect(tableMatch).not.toBeNull()
    const tableBody = tableMatch?.[1] ?? ''
    const boundKeys = [...tableBody.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] ?? '')
    expect(boundKeys.length).toBeGreaterThan(0)

    const liveKeys = new Set(flatten(defaultConfig() as unknown as Record<string, unknown>))
    const orphaned = boundKeys.filter((k) => !liveKeys.has(k))
    expect(orphaned).toEqual([])
  })
})
