/** Module-level check that json-query, yaml-query, config-get, imports and exports redact secret-shaped values in what they print, text and --json alike, and leave a non-secret value as it was. Fixture provenance: HAND-DERIVED. The Anthropic key is synthetic, 'sk-ant-api03-' plus forty 'a', the shape tests/secret_redact.test.ts pins for the anthropic_api_key pattern; the keyed value is made-up filler under an api_key name, the shape tests/read_output_redacts_secrets_bundle_e2e.test.ts writes into creds.json. The reporter's shape is a secret-shaped value under the queried key (json-query f '.api_key') or in the import specifier. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runConfigGet, runExports, runImports } from '../src/read_inspect.js'
import { runJsonQuery, runYamlQuery } from '../src/read_structured_data.js'

import { captureStdout } from './helpers/capture-stdout.js'

const ANT = 'sk-ant-api03-' + 'a'.repeat(40)
const ANT_PLACEHOLDER = '[REDACTED:anthropic_api_key]'
const KEYED = 'FAKEapikeyvalue0123456789'

let dir: string

function write(name: string, text: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, text, 'utf-8')
  return file
}

function printed(fn: () => number): { code: number; out: string } {
  let code = -1
  const out = captureStdout(() => {
    code = fn()
  })
  return { code, out }
}

function expectNoSecret(out: string): void {
  expect(out).not.toContain(ANT)
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain(KEYED)
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-structured-redact-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('json-query prints no secret value', () => {
  const doc = JSON.stringify({ anthropic: ANT, api_key: KEYED, plain_note: 'hello world', servers: [{ api_key: KEYED, name: 'a' }, { api_key: KEYED, name: 'b' }] })

  it('redacts a secret-shaped value under the queried key (the reporter shape)', () => {
    const { code, out } = printed(() => runJsonQuery({ file: write('creds.json', doc), path: '.anthropic' }))
    expect(code).toBe(0)
    expectNoSecret(out)
    expect(out).toBe(`"${ANT_PLACEHOLDER}"\n`)
  })

  it('redacts a value only its key marks as secret', () => {
    const { out } = printed(() => runJsonQuery({ file: write('creds.json', doc), path: '.api_key' }))
    expectNoSecret(out)
    expect(out).toContain('[REDACTED:')
  })

  it('--json stays valid JSON with the value replaced', () => {
    const { out } = printed(() => runJsonQuery({ file: write('creds.json', doc), path: '.anthropic', json: true }))
    expectNoSecret(out)
    expect(JSON.parse(out)).toBe(ANT_PLACEHOLDER)
  })

  it('redacts every item of a fanned query, text and --json', () => {
    const file = write('creds.json', doc)
    const text = printed(() => runJsonQuery({ file, path: 'servers[*].api_key' }))
    expectNoSecret(text.out)
    expect(text.out.trimEnd().split('\n')).toHaveLength(2)
    const json = printed(() => runJsonQuery({ file, path: 'servers[*].api_key', json: true }))
    expectNoSecret(json.out)
    const parsed = JSON.parse(json.out) as { items: string[]; totalCount: number }
    expect(parsed.totalCount).toBe(2)
    expect(parsed.items.every((item) => item.startsWith('[REDACTED:'))).toBe(true)
  })

  it('redacts the secret inside an object the query returns', () => {
    const { out } = printed(() => runJsonQuery({ file: write('creds.json', doc), path: 'servers[0]', json: true }))
    expectNoSecret(out)
    expect(JSON.parse(out)).toMatchObject({ name: 'a' })
  })

  it('prints a non-secret value as it was', () => {
    const file = write('creds.json', doc)
    expect(printed(() => runJsonQuery({ file, path: '.plain_note' })).out).toBe('"hello world"\n')
    expect(printed(() => runJsonQuery({ file, path: 'servers[*].name', json: true })).out).toBe('{"items":["a","b"],"truncated":false,"totalCount":2}\n')
  })
})

describe('yaml-query prints no secret value', () => {
  const doc = ['anthropic: ' + ANT, 'api_key: ' + KEYED, 'plain_note: hello world', ''].join('\n')

  it('redacts a secret-shaped value under the queried key (the reporter shape), text and --json', () => {
    const file = write('creds.yaml', doc)
    const text = printed(() => runYamlQuery({ file, path: '.anthropic' }))
    expectNoSecret(text.out)
    expect(text.out).toBe(`"${ANT_PLACEHOLDER}"\n`)
    const json = printed(() => runYamlQuery({ file, path: '.api_key', json: true }))
    expectNoSecret(json.out)
    expect(JSON.parse(json.out)).toMatch(/^\[REDACTED:/)
  })

  it('prints a non-secret value as it was', () => {
    expect(printed(() => runYamlQuery({ file: write('creds.yaml', doc), path: '.plain_note' })).out).toBe('"hello world"\n')
  })
})

describe('config-get prints no secret value', () => {
  function get(name: string, text: string, key: string): string {
    const { code, out } = printed(() => runConfigGet({ file: write(name, text), key }))
    expect(code, out).toBe(0)
    return out
  }

  it('redacts a secret-shaped value in JSON (the reporter shape)', () => {
    const out = get('c.json', JSON.stringify({ anthropic: ANT, api_key: KEYED, plain_note: 'hello world', nested: { api_key: KEYED } }), 'anthropic')
    expectNoSecret(out)
    expect(out).toBe(`"${ANT_PLACEHOLDER}"\n`)
  })

  it('redacts a value only its key marks as secret, in JSON and in a nested object', () => {
    const text = JSON.stringify({ api_key: KEYED, nested: { api_key: KEYED } })
    expectNoSecret(get('c.json', text, 'api_key'))
    expectNoSecret(get('c.json', text, 'nested.api_key'))
    expectNoSecret(get('c.json', text, 'nested'))
  })

  it('redacts a value in YAML, TOML, a YAML frontmatter and a flat key file', () => {
    expectNoSecret(get('c.yaml', `anthropic: ${ANT}\n`, 'anthropic'))
    expectNoSecret(get('c.yaml', `api_key: ${KEYED}\n`, 'api_key'))
    expectNoSecret(get('c.toml', `[tool]\nanthropic = "${ANT}"\napi_key = "${KEYED}"\n`, 'tool.anthropic'))
    expectNoSecret(get('c.toml', `[tool]\napi_key = "${KEYED}"\n`, 'tool.api_key'))
    expectNoSecret(get('note.md', `---\nanthropic: ${ANT}\n---\nbody\n`, 'anthropic'))
    expectNoSecret(get('c.properties', `anthropic=${ANT}\n`, 'anthropic'))
    expectNoSecret(get('c.properties', `api_key=${KEYED}\n`, 'api_key'))
  })

  it('redacts the password of a URL a YAML key holds', () => {
    const out = get('url.yaml', 'database:\n  url: postgres://u:hunter2pass@h/db\n', 'database.url')
    expect(out).not.toContain('hunter2pass')
    expect(out).toContain('[REDACTED:url_credentials]')
  })

  it('prints a non-secret value as it was', () => {
    expect(get('c.json', '{"plain_note":"hello world","n":{"a":[1,2]}}', 'plain_note')).toBe('"hello world"\n')
    expect(get('c.json', '{"plain_note":"hello world","n":{"a":[1,2]}}', 'n')).toBe('{"a":[1,2]}\n')
    expect(get('c.yaml', 'plain_note: hello world\n', 'plain_note')).toBe('hello world\n')
    expect(get('c.toml', '[tool]\nplain_note = "hello world"\n', 'tool.plain_note')).toBe('hello world\n')
    expect(get('c.properties', 'plain_note=hello world\n', 'plain_note')).toBe('hello world\n')
  })
})

describe('imports and exports print no secret value', () => {
  const source = [`import secretKey from "${ANT}"`, 'import plain from "./plain"', `export { plain as "${ANT}" }`, 'export const plainExport = 1', ''].join('\n')

  it('imports redacts a secret-shaped specifier (the reporter shape), text and --json', () => {
    const file = write('imp.ts', source)
    const text = printed(() => runImports({ file, projectRoot: dir }))
    expect(text.code).toBe(0)
    expectNoSecret(text.out)
    expect(text.out).toContain(`import  ${ANT_PLACEHOLDER}`)
    expect(text.out).toContain('import  ./plain')
    const json = printed(() => runImports({ file, projectRoot: dir, json: true }))
    expectNoSecret(json.out)
    expect((JSON.parse(json.out) as { items: string[] }).items).toEqual([ANT_PLACEHOLDER, './plain'])
  })

  it('imports does not let --grep match against the secret itself', () => {
    const file = write('imp.ts', source)
    const out = printed(() => runImports({ file, projectRoot: dir, grep: 'sk-ant-api03' })).out
    // the notice quotes the pattern the caller typed, so only the file's own text is checked
    expect(out).not.toContain(ANT)
    expect(out).toContain('filtered out')
    expect(out).not.toContain(ANT_PLACEHOLDER)
  })

  it('exports redacts a secret-shaped exported name (the reporter shape), text and --json', () => {
    const file = write('imp.ts', source)
    const text = printed(() => runExports({ file, projectRoot: dir }))
    expect(text.code).toBe(0)
    expectNoSecret(text.out)
    expect(text.out).toContain(ANT_PLACEHOLDER)
    expect(text.out).toContain('plainExport')
    const json = printed(() => runExports({ file, projectRoot: dir, json: true }))
    expectNoSecret(json.out)
    const names = (JSON.parse(json.out) as Array<{ name: string }>).map((e) => e.name)
    expect(names).toContain('plainExport')
    expect(names.some((n) => n.includes(ANT_PLACEHOLDER))).toBe(true)
  })

  it('exports does not let --grep match against the secret itself', () => {
    const file = write('imp.ts', source)
    const out = printed(() => runExports({ file, projectRoot: dir, grep: 'sk-ant-api03' })).out
    // the notice quotes the pattern the caller typed, so only the file's own text is checked
    expect(out).not.toContain(ANT)
    expect(out).toContain('filtered out')
    expect(out).not.toContain(ANT_PLACEHOLDER)
  })
})
