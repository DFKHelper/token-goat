/** Built-bundle check that every read command redacts secret-shaped values in the file text it prints, stored index body or live disk slice alike. Fixture provenance: HAND-DERIVED. The GitHub token is synthetic, 'ghp_' plus 36 alphanumerics, the shape the gh[oprsu]_ pattern in src/secret_redact.ts names, and the PEM block is a made-up body between real BEGIN/END markers. The TOML layout copies the reporter's shape: a key under a table in a user host config that sits outside the project the command runs from. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isAvailable } from '../src/embeddings.js'
import { modelFilesPresent } from '../src/embed_model.js'
import Database from '../src/sqlite_driver.js'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

const TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
const REDACTED = '[REDACTED:github_token]'
const HOST_TOML = ['[hooks]', 'plain_note = "hello world"', `trusted_token = "${TOKEN}"`, ''].join('\n')
const PEM_FILE = ['before_line', '-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', '-----END RSA PRIVATE KEY-----', 'after_line', ''].join('\n')

// Fixture provenance: HAND-DERIVED. Every key body line below is made-up filler, 'KEYBODYLINE' plus a two-digit index, never key material. The PEM layouts are built so a cut falls inside the block: the END marker lies past the preview, the line range, the section cap, the context window or the clip, which is the shape that left a fragment printing raw when redaction ran after the cut.
const pemBody = (tag: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${tag}${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'
const PEM_PLACEHOLDER = '[REDACTED:private_key_block]'
const LONG_PEM_FILE = ['lead_line', 'second_line', PEM_BEGIN, ...pemBody('KEYBODYLINE', 16), PEM_END, 'tail_line', ''].join('\n')
const HOLDER_TS = ['export function pemHolderFn(): string {', `  return \`${PEM_BEGIN}`, ...pemBody('HOLDERBODY', 10), `${PEM_END}\``, '}', ''].join('\n')
const GUIDE_MD = ['# Credentials Guide', 'intro_line_kept', PEM_BEGIN, ...pemBody('GUIDEBODY', 10), PEM_END, 'outro_line_kept', ''].join('\n')
const CALL_LIB_TS = 'export function targetFn(): number {\n  return 1\n}\n'
const CALL_USE_TS = ['import { targetFn } from "./call_lib"', 'export function useIt(): number {', `  const pem = \`${PEM_BEGIN}`, ...pemBody('CALLERBODY', 10), `${PEM_END}\``, '  return targetFn() + pem.length', '}', ''].join('\n')
// The token starts at column 90 of a line a 114-character preview window opens on, so the window ends 24 characters into it.
const SPLIT_LINE = `// splitmarker ${'x'.repeat(75)}${TOKEN} tail`
const DOC_TS = `/** Key ${PEM_BEGIN} ${pemBody('DOCBODY', 1)[0]}${'B'.repeat(100)} ${PEM_END} */\nexport function docHolderFn(): number {\n  return 1\n}\n`
// Fixture provenance: HAND-DERIVED. The Anthropic key is synthetic, 'sk-ant-api03-' plus forty 'a', the shape tests/secret_redact.test.ts pins for the anthropic_api_key pattern, placed where the structured-query and inspect commands print it: a JSON value under a key and an import specifier.
const ANT_KEY = 'sk-ant-api03-' + 'a'.repeat(40)
const ANT_PLACEHOLDER = '[REDACTED:anthropic_api_key]'
const ANT_JSON = `{"anthropic": "${ANT_KEY}", "plain_note": "hello world"}\n`
const ANT_IMPORT_TS = `import secretKey from "${ANT_KEY}"\nimport plain from "./plain"\nexport const useThem = [secretKey, plain]\n`
// Fixture provenance: HAND-DERIVED. The Anthropic key is the synthetic one above, placed where logfold, todo and trace print file text: a log line, a TODO that quotes it and a traceback that echoes it, plus the made-up key block laid out as above, which a logfold --tail window cuts in half.
const LOG_TEXT = ['lead_line', `auth failed key=${ANT_KEY}`, PEM_BEGIN, ...pemBody('LOGBODY', 5), PEM_END, 'tail_line', ''].join('\n')
const TODO_TS = [`// TODO: rotate ${ANT_KEY}`, 'const x = 1', '// FIXME: plain note', ''].join('\n')
const TRACE_TEXT = ['Traceback (most recent call last):', '  File "app.py", line 5, in <module>', `    client = Client(api_key="${ANT_KEY}")`, `RuntimeError: auth failed for ${ANT_KEY}`, ''].join('\n')
const CREDS_JSON ='{\n  "api_key": "FAKEapikeyvalue0123456789",\n  "plain_note": "hello world"\n}\n'
// Fixture provenance: HAND-DERIVED. A scratch git repo for refs, diff, log, conflicts and changed --symbol: the second commit adds a made-up key block (the private_key_block pattern in src/secret_redact.ts) and an api_key line holding the synthetic Anthropic key above (the anthropic_api_key pattern) to one function, a caller sits beside the same lines, a TOML table is named with the key, and one conflict file holds both between its markers.
const VAULT_SECRET_LINES = [`  const pem = \`${PEM_BEGIN}`, ...pemBody('VAULTBODY', 4), `${PEM_END}\``, `  const api_key = "${ANT_KEY}"`]
const VAULT_V1 = 'export function vaultFn(): number {\n  return 1\n}\n'
const VAULT_V2 = ['export function vaultFn(): number {', ...VAULT_SECRET_LINES, '  return pem.length + api_key.length', '}', ''].join('\n')
const VAULT_USE_TS = ['import { vaultFn } from "./vault"', 'export function useVault(): number {', ...VAULT_SECRET_LINES, '  return vaultFn() + pem.length + api_key.length', '}', ''].join('\n')
const VAULT_CONFLICT = ['before', '<<<<<<< ours', `api_key = "${ANT_KEY}"`, PEM_BEGIN, ...pemBody('VAULTBODY', 4), PEM_END, '=======', 'theirs_line', '>>>>>>> theirs', 'after', ''].join('\n')
// Fixture provenance: HAND-DERIVED. Four plain lines joined by a lone CR; lines 2 and 3 are counted by hand, the numbering the index gives a CR-only file.
const CR_LINES_TEXT = ['alpha_line', 'beta_line', 'gamma_line', 'delta_line'].join('\r') + '\r'
// Fixture provenance: HAND-DERIVED. A doc comment of 395 filler lines of 40 characters (about 16.2 KB), then a key block of made-up 'BIGDOCBODY' lines: the 16 KB docstring cut falls inside the block, with BEGIN before it and END after it, by arithmetic on those lengths.
const BIG_DOC_LINES = [...Array.from({ length: 395 }, (_, i) => `filler ${String(i).padStart(4, '0')} ${'x'.repeat(28)}`), PEM_BEGIN, ...pemBody('BIGDOCBODY', 30), PEM_END, 'tail_after_the_block']
const BIG_DOC_TS = `/**\n${BIG_DOC_LINES.map((l) => ` * ${l}`).join('\n')}\n */\nexport function bigDocFn(): number {\n  return 1\n}\n`
const PLAIN_V1 = 'export function plainFn(): number {\n  return 1\n}\n'
const PLAIN_V2 = 'export function plainFn(): number {\n  return 2\n}\n'
const PLAIN_USE_TS = 'import { plainFn } from "./plain"\nexport function usePlain(): number {\n  return plainFn() + 1\n}\n'
const PLAIN_CONFLICT = ['one', '<<<<<<< ours', 'mine', '=======', 'theirs', '>>>>>>> theirs', 'two', ''].join('\n')

let root: string
let project: string
let env: NodeJS.ProcessEnv
let hostFile: string
let pemFile: string
let gitProject: string

function tg(args: string[]): string {
  const res = bundleTg(project, env, args)
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

function tgGit(args: string[]): string {
  const res = bundleTg(gitProject, env, args)
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

function git(...args: string[]): void {
  const res = spawnSync('git', args, { cwd: gitProject, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
}

function expectNoVaultSecret(out: string): void {
  expect(out).not.toContain(ANT_KEY)
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain('VAULTBODY')
  expect(out).not.toContain(PEM_BEGIN)
}

function expectRedacted(out: string): void {
  expect(out).not.toContain(TOKEN)
  expect(out).not.toContain('ghp_0123')
  expect(out).toContain(REDACTED)
}

// must-not-drop: the non-secret line printed beside the secret one stays as written
function expectPlainLineKept(out: string): void {
  expect(out).toContain('plain_note = "hello world"')
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-read-redact-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
  const host = path.join(root, 'outside', 'host')
  fs.mkdirSync(host, { recursive: true })
  hostFile = path.join(host, 'settings.toml').replace(/\\/g, '/')
  fs.writeFileSync(hostFile, HOST_TOML)
  pemFile = path.join(project, 'keys.txt').replace(/\\/g, '/')
  fs.writeFileSync(pemFile, PEM_FILE)
  fs.writeFileSync(path.join(project, 'local.ts'), 'export const localValue = 1\n')
  fs.writeFileSync(path.join(project, 'cfg.toml'), HOST_TOML)
  for (const [name, text] of Object.entries({
    'longkey.txt': LONG_PEM_FILE,
    'holder.ts': HOLDER_TS,
    'guide.md': GUIDE_MD,
    'call_lib.ts': CALL_LIB_TS,
    'call_use.ts': CALL_USE_TS,
    'splitnotes.ts': `${SPLIT_LINE}\n`,
    'doc_holder.ts': DOC_TS,
    'creds.json': CREDS_JSON,
    'ant.json': ANT_JSON,
    'ant_import.ts': ANT_IMPORT_TS,
    'app.log': LOG_TEXT,
    'quoted.ts': TODO_TS,
    'trace.txt': TRACE_TEXT,
    'crlines.txt': CR_LINES_TEXT,
    'big_doc.ts': BIG_DOC_TS,
  })) fs.writeFileSync(path.join(project, name), text)
  // The host config is indexed on its own, as the machine-wide index holds files from outside the root a later command runs from.
  const idxHost = bundleTg(host, env, ['index', '.', '--walk'])
  expect(idxHost.status, idxHost.stderr).toBe(0)
  const idxProject = bundleTg(project, env, ['index', '.', '--walk'])
  expect(idxProject.status, idxProject.stderr).toBe(0)
  gitProject = path.join(root, 'gitproject')
  fs.mkdirSync(gitProject, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  for (const [name, text] of Object.entries({ 'vault.ts': VAULT_V1, 'plain.ts': PLAIN_V1, 'plain_use.ts': PLAIN_USE_TS, 'use.ts': VAULT_USE_TS })) fs.writeFileSync(path.join(gitProject, name), text)
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  for (const [name, text] of Object.entries({ 'vault.ts': VAULT_V2, 'plain.ts': PLAIN_V2, 'vault.toml': `[${ANT_KEY}]\nnote = "x"\n`, 'vault.json': `{"${ANT_KEY}": {"note": 1}}\n`, 'conflict.txt': VAULT_CONFLICT, 'plain_conflict.txt': PLAIN_CONFLICT })) fs.writeFileSync(path.join(gitProject, name), text)
  git('add', '.')
  git('commit', '-q', '-m', 'second')
  const idxGit = bundleTg(gitProject, env, ['index', '.', '--walk'])
  expect(idxGit.status, idxGit.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle redacts secret-shaped values in the file text a read command prints', () => {
  it('symbol prints an indexed key from outside the project root redacted (the reporter shape)', () => {
    const out = tg(['symbol', 'trusted_token'])
    expect(out).toContain('outside/host/settings.toml')
    expectRedacted(out)
  })

  it('symbol keeps a table body whole except for the secret value', () => {
    const out = tg(['symbol', 'hooks'])
    expect(out).toContain(`trusted_token = "${REDACTED}"`)
    expect(out).toContain('plain_note = "hello world"')
    expect(out).not.toContain(TOKEN)
  })

  it('symbol --json stays valid, indented JSON with the value redacted', () => {
    const out = tg(['symbol', 'trusted_token', '--json'])
    const parsed = JSON.parse(out) as { items: Array<{ body: string }> }
    expect(parsed.items.length).toBeGreaterThan(0)
    for (const item of parsed.items) expect(item.body).toBe(`trusted_token = "${REDACTED}"`)
    expect(out).not.toContain(TOKEN)
    expect(out.split('\n').length).toBeGreaterThan(5)
  })

  it('read prints the symbol form redacted', () => {
    expectRedacted(tg(['read', `${hostFile}::trusted_token`]))
  })

  it('read prints the line-range form redacted and keeps the unrelated lines', () => {
    const out = tg(['read', `${hostFile}:1-3`])
    expectRedacted(out)
    expectPlainLineKept(out)
  })

  it('read of a range holding a multi-line private key keeps every line where it was', () => {
    const out = tg(['read', `${pemFile}@1-5`])
    expect(out).not.toContain('MIIBOgIBAAJB')
    const lines = out.trimEnd().split('\n')
    // header, then the five requested lines: the key block's three lines become three placeholder lines
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe('before_line')
    expect(lines[5]).toBe('after_line')
    expect(lines.slice(2, 5).every((l) => l.includes('[REDACTED:private_key_block]'))).toBe(true)
  })

  it('section prints the heading body redacted', () => {
    const out = tg(['section', `${hostFile}::hooks`])
    expectRedacted(out)
    expectPlainLineKept(out)
  })

  it('brief prints the symbol body redacted', () => {
    expectRedacted(tg(['brief', `${hostFile}::trusted_token`]))
  })

  it('skeleton prints the key signature redacted', () => {
    const out = tg(['skeleton', hostFile])
    expectRedacted(out)
    expectPlainLineKept(out)
  })

  it('semantic keyword hits print the body redacted', () => {
    expectRedacted(tg(['semantic', 'trusted_token']))
  })

  it('search prints the matching line redacted, as text and as JSON', () => {
    expectRedacted(tg(['search', 'trusted_token']))
    const json = tg(['search', 'trusted_token', '--json'])
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).not.toContain(TOKEN)
    expect(json).toContain(REDACTED)
  })

  it('semantic previews a key block whose END marker lies past the preview without any of it', () => {
    const out = tg(['semantic', 'pemHolderFn'])
    expect(out).toContain('pemHolderFn')
    expect(out).not.toContain('HOLDERBODY')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).toContain(PEM_PLACEHOLDER)
  })

  it('symbol cuts its body preview inside a key block without printing any of it', () => {
    const out = tg(['symbol', 'pemHolderFn'])
    expect(out).toContain('export function pemHolderFn(): string {')
    expect(out).not.toContain('HOLDERBODY')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).toContain(PEM_PLACEHOLDER)
  })

  it('section --max-lines cuts inside a key block without printing any of it and keeps the plain lines', () => {
    const out = tg(['section', 'guide.md::Credentials Guide', '--max-lines', '4'])
    expect(out).toContain('intro_line_kept')
    expect(out).not.toContain('GUIDEBODY')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).toContain(PEM_PLACEHOLDER)
    const whole = tg(['section', 'guide.md::Credentials Guide'])
    expect(whole).toContain('intro_line_kept')
    expect(whole).toContain('outro_line_kept')
    expect(whole).not.toContain('GUIDEBODY')
  })

  it('read of a range that ends inside a key block spanning lines 3 to 19 prints none of it and keeps lines 1 and 2', () => {
    const out = tg(['read', 'longkey.txt@1-5'])
    expect(out).not.toContain('KEYBODYLINE')
    expect(out).not.toContain(PEM_BEGIN)
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe('lead_line')
    expect(lines[2]).toBe('second_line')
    expect(lines.slice(3).every((l) => l.includes(PEM_PLACEHOLDER))).toBe(true)
  })

  it('read --json keeps the lines array one entry per line across a key block', () => {
    const out = tg(['read', 'longkey.txt@1-5', '--json'])
    const parsed = JSON.parse(out) as { lines: string[] }
    expect(parsed.lines).toHaveLength(5)
    expect(parsed.lines[0]).toBe('lead_line')
    expect(parsed.lines[1]).toBe('second_line')
    expect(parsed.lines.slice(2).every((l) => l.includes(PEM_PLACEHOLDER))).toBe(true)
    expect(out).not.toContain('KEYBODYLINE')
  })

  it('search prints a text snippet whose window ends inside a token with no part of the token', () => {
    const out = tg(['search', 'splitmarker', '--channels', 'text'])
    expect(out).toContain('splitmarker')
    expect(out).not.toContain('ghp_0123')
    expect(out).toContain('[REDACTED')
  })

  it('outline clips a doc summary that holds a key block without printing the cut fragment', () => {
    const out = tg(['outline', 'doc_holder.ts'])
    expect(out).toContain('docHolderFn')
    expect(out).not.toContain('DOCBODY')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).toContain(PEM_PLACEHOLDER)
  })

  it('symbol --json redacts a secret that sits in a JSON file, where the body is escaped inside the output', () => {
    const out = tg(['symbol', 'api_key', '--json'])
    expect(out).toContain('api_key')
    expect(out).not.toContain('FAKEapikeyvalue')
    expect(out).toContain('[REDACTED:generic_secret_assignment]')
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('callers -C prints a context window that starts inside a key block with none of it, as text and as JSON', () => {
    const text = tg(['callers', 'targetFn', '-C', '2'])
    expect(text).toContain('targetFn() + pem.length')
    expect(text).not.toContain('CALLERBODY')
    expect(text).toContain(PEM_PLACEHOLDER)
    const json = tg(['callers', 'targetFn', '-C', '2', '--json'])
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).not.toContain('CALLERBODY')
    expect(json).toContain('targetFn() + pem.length')
  })

  it('grep prints the lines around a match without the key block, and a match inside the block as a placeholder', () => {
    const out = tg(['grep', 'second_line', 'longkey.txt', '-C', '3'])
    expect(out).toContain('second_line')
    expect(out).not.toContain('KEYBODYLINE')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).toContain(PEM_PLACEHOLDER)
    const inside = tg(['grep', 'KEYBODYLINE05', 'longkey.txt'])
    expect(inside).toContain('longkey.txt')
    expect(inside).not.toContain('KEYBODYLINE')
    expect(inside).toContain(PEM_PLACEHOLDER)
    const json = tg(['grep', 'second_line', 'longkey.txt', '-C', '3', '--json'])
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).not.toContain('KEYBODYLINE')
  })

  it('a project file with no secret prints unchanged', () => {
    expect(tg(['symbol', 'localValue'])).toContain('export const localValue = 1')
  })

  it('json-query prints the queried secret redacted, text and --json, and a non-secret value as written', () => {
    const text = tg(['json-query', 'ant.json', '.anthropic'])
    expect(text).not.toContain(ANT_KEY)
    expect(text).toBe(`"${ANT_PLACEHOLDER}"\n`)
    const json = tg(['json-query', 'ant.json', '.anthropic', '--json'])
    expect(json).not.toContain(ANT_KEY)
    expect(JSON.parse(json)).toBe(ANT_PLACEHOLDER)
    expect(tg(['json-query', 'ant.json', '.plain_note'])).toBe('"hello world"\n')
  })

  it('config-get prints the requested secret redacted and a non-secret value as written', () => {
    const out = tg(['config-get', 'ant.json', 'anthropic'])
    expect(out).not.toContain(ANT_KEY)
    expect(out).toBe(`"${ANT_PLACEHOLDER}"\n`)
    expect(tg(['config-get', 'ant.json', 'plain_note'])).toBe('"hello world"\n')
  })

  it('imports prints a secret-shaped specifier redacted, text and --json', () => {
    const text = tg(['imports', 'ant_import.ts'])
    expect(text).not.toContain(ANT_KEY)
    expect(text).toContain(`import  ${ANT_PLACEHOLDER}`)
    expect(text).toContain('import  ./plain')
    const json = tg(['imports', 'ant_import.ts', '--json'])
    expect(json).not.toContain(ANT_KEY)
    expect((JSON.parse(json) as { items: string[] }).items).toEqual([ANT_PLACEHOLDER, './plain'])
  })

  it('logfold prints a logged key and a key block its --tail window cuts in half redacted, text and --json', () => {
    const text = tg(['logfold', 'app.log'])
    expect(text).not.toContain(ANT_KEY)
    expect(text).not.toContain('LOGBODY')
    expect(text).toContain(`auth failed key=${ANT_PLACEHOLDER}`)
    expect(text).toContain(PEM_PLACEHOLDER)
    expect(text).toContain('lead_line\n')
    const cut = tg(['logfold', 'app.log', '--tail', '4'])
    expect(cut).not.toContain('LOGBODY')
    expect(cut).toContain(PEM_PLACEHOLDER)
    const json = tg(['logfold', 'app.log', '--json'])
    expect(json).not.toContain(ANT_KEY)
    expect(json).not.toContain('LOGBODY')
    expect(JSON.parse(json)).toMatchObject({ lines: expect.any(Array) })
  })

  it('todo prints a TODO that quotes a key redacted, text and --json, and a plain marker as written', () => {
    const text = tg(['todo', 'quoted.ts'])
    expect(text).not.toContain(ANT_KEY)
    expect(text).toContain(`TODO  rotate ${ANT_PLACEHOLDER}`)
    expect(text).toContain(':3  FIXME  plain note\n')
    const json = tg(['todo', 'quoted.ts', '--json'])
    expect(json).not.toContain(ANT_KEY)
    expect((JSON.parse(json) as { items: Array<{ text: string }> }).items.map((i) => i.text)).toEqual([`rotate ${ANT_PLACEHOLDER}`, 'plain note'])
  })

  it('trace prints a key echoed by the frame context and the exception redacted, text and --json', () => {
    const text = tg(['trace', 'trace.txt'])
    expect(text).not.toContain(ANT_KEY)
    expect(text).toContain(`    client = Client(api_key="${ANT_PLACEHOLDER}")`)
    expect(text).toContain(`RuntimeError: auth failed for ${ANT_PLACEHOLDER}`)
    const json = tg(['trace', 'trace.txt', '--json'])
    expect(json).not.toContain(ANT_KEY)
    expect((JSON.parse(json) as { tracebacks: Array<{ exception: string }> }).tracebacks[0]?.exception).toBe(`RuntimeError: auth failed for ${ANT_PLACEHOLDER}`)
  })

  it('read of lines 2-3 of a CR-only file prints the second and third line, not the whole file', () => {
    const out = tg(['read', 'crlines.txt@2-3'])
    expect(out.split('\n').slice(1, 3)).toEqual(['beta_line', 'gamma_line'])
    expect(out).toContain('# lines 2-3 of 4')
    expect(out).not.toContain('alpha_line')
    expect(out).not.toContain('delta_line')
  })

  it('outline prints a doc comment whose key block straddles the 16 KB docstring cut with none of it, text and --json', () => {
    for (const args of [['outline', 'big_doc.ts'], ['outline', 'big_doc.ts', '--json']]) {
      const out = tg(args)
      expect(out).toContain('bigDocFn')
      expect(out).not.toContain('BIGDOCBODY')
      expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
    }
    expect(tg(['outline', 'big_doc.ts', '--json'])).toContain('filler 0000')
  })

  it('refs prints the lines around a reference without the key block or the api_key value, text and --json, and a plain caller as written', () => {
    for (const args of [['refs', 'vaultFn', '-C', '8'], ['refs', 'vaultFn', '--callers', '-C', '8'], ['refs', 'vaultFn', '-C', '8', '--json']]) {
      const out = tgGit(args)
      expectNoVaultSecret(out)
      expect(out).toContain(ANT_PLACEHOLDER)
      expect(out).toContain(PEM_PLACEHOLDER)
      expect(out).toContain('return vaultFn() + pem.length + api_key.length')
    }
    const plain = tgGit(['refs', 'plainFn', '-C', '2'])
    expect(plain).toContain('return plainFn() + 1')
    expect(plain).not.toContain('[REDACTED')
  })

  it('diff prints the added key block and api_key line redacted, text and --json, and a plain change as written', () => {
    const text = tgGit(['diff', 'vault.ts::vaultFn', 'HEAD~1..HEAD'])
    expectNoVaultSecret(text)
    expect(text).toContain(ANT_PLACEHOLDER)
    expect(text).toContain(PEM_PLACEHOLDER)
    expect(text).toContain('+  return pem.length + api_key.length')
    const json = tgGit(['diff', 'vault.ts::vaultFn', 'HEAD~1..HEAD', '--json'])
    expectNoVaultSecret(json)
    expect(() => JSON.parse(json)).not.toThrow()
    const plain = tgGit(['diff', 'plain.ts::plainFn', 'HEAD~1..HEAD'])
    expect(plain).toContain('-  return 1\n+  return 2')
    expect(plain).not.toContain('[REDACTED')
  })

  it('log prints the patches it shows redacted, text and --json, and a plain history as written', () => {
    const text = tgGit(['log', 'vault.ts::vaultFn'])
    expectNoVaultSecret(text)
    expect(text).toContain(ANT_PLACEHOLDER)
    expect(text).toContain(PEM_PLACEHOLDER)
    expect(text).toContain('    second')
    const json = tgGit(['log', 'vault.ts::vaultFn', '--json'])
    expectNoVaultSecret(json)
    expect(() => JSON.parse(json)).not.toThrow()
    const plain = tgGit(['log', 'plain.ts::plainFn'])
    expect(plain).toContain('-  return 1\n+  return 2')
    expect(plain).not.toContain('[REDACTED')
  })

  it('conflicts prints a conflict region redacted, text and --json, and a plain conflict as written', () => {
    const text = tgGit(['conflicts', 'conflict.txt'])
    expectNoVaultSecret(text)
    expect(text).toContain(ANT_PLACEHOLDER)
    expect(text).toContain(PEM_PLACEHOLDER)
    expect(text).toContain('theirs_line')
    const json = tgGit(['conflicts', 'conflict.txt', '--json'])
    expectNoVaultSecret(json)
    expect(() => JSON.parse(json)).not.toThrow()
    const plain = tgGit(['conflicts', 'plain_conflict.txt'])
    expect(plain).toContain('<<<<<<< ours\n      mine\n    =======\n      theirs\n    >>>>>>> theirs')
    expect(plain).not.toContain('[REDACTED')
  })

  it('changed --symbol prints a symbol named with the key redacted, text and --json, and plain names as written', () => {
    const text = tgGit(['changed', '--symbol', 'HEAD~1'])
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain(`${ANT_PLACEHOLDER} (section) — vault.toml:1`)
    const json = tgGit(['changed', '--symbol', 'HEAD~1', '--json'])
    expect(json).not.toContain('sk-ant-api03')
    expect(() => JSON.parse(json)).not.toThrow()
    expect(tgGit(['changed', '--symbol', 'HEAD~1', '--grep', 'plain'])).toBe('plainFn (function) — plain.ts:1\n')
  })
})

// Fixture provenance: HAND-DERIVED. The Anthropic key is the synthetic one above, stored as a TOML table name and a JSON key, which the indexer keeps as symbol names; the reporter ran scope vault.toml:1 and saw the key printed.
describe('the built bundle redacts a stored symbol name that is a credential', () => {
  it('scope vault.toml:1 prints the table name redacted, text and --json (the reporter shape)', () => {
    const text = tgGit(['scope', 'vault.toml:1'])
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain(`${ANT_PLACEHOLDER}\t`)
    const json = tgGit(['scope', 'vault.toml:1', '--json'])
    expect(json).not.toContain('sk-ant-api03')
    expect((JSON.parse(json) as Array<{ name: string }>)[0]?.name).toBe(ANT_PLACEHOLDER)
  })

  it('scope vault.json:1 prints the key redacted, text and --json', () => {
    const text = tgGit(['scope', 'vault.json:1'])
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain(ANT_PLACEHOLDER)
    const json = tgGit(['scope', 'vault.json:1', '--json'])
    expect(json).not.toContain('sk-ant-api03')
    expect(json).toContain(ANT_PLACEHOLDER)
  })

  it('context-for prints the read command of a key-named symbol redacted, text and --json', () => {
    const text = tgGit(['context-for', 'note'])
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain(ANT_PLACEHOLDER)
    const json = tgGit(['context-for', 'note', '--json'])
    expect(json).not.toContain('sk-ant-api03')
    expect(json).toContain(ANT_PLACEHOLDER)
  })

  it('symbol lists a key-named near match redacted in its did-you-mean list', () => {
    const res = bundleTg(gitProject, env, ['symbol', 'sk-ant-api03'])
    const printed = `${res.stdout}${res.stderr}`
    expect(printed).not.toContain(ANT_KEY)
    expect(printed).toContain(`  - ${ANT_PLACEHOLDER}`)
  })

  it('scope keeps a symbol name with no secret as written', () => {
    expect(tgGit(['scope', 'plain.ts:2'])).toContain('plainFn\tfunction\tplain.ts:1-')
  })
})

// Fixture provenance: HAND-DERIVED. One markdown file of two private-key blocks laid end to end, each 120 body lines, so the chunker has to cut the text and a cut lands inside a block: a chunk holds at most MAX_CHUNK_TOKENS wordpieces (src/embeddings.ts) and 240 lines overrun that more than once, which beforeAll checks on the stored chunks. The file is kept this small because every stored chunk is embedded by the one `index --embed` run in the beforeAll below, which must fit the default hook timeout. The body lines are made-up filler. beforeAll reads the stored chunks back and fails unless one holds only a block's first half, one only its second half and one only body lines, so a chunker change cannot leave these rows passing without a straddle to test.
const CHUNK_BLOCK = [PEM_BEGIN, ...pemBody('CHUNKBODY', 120), PEM_END]
const CHUNK_FILE_NAME = 'straddle.md'
const CHUNK_FILE = ['# Keys', ...Array.from({ length: 2 }, () => CHUNK_BLOCK).flat(), ''].join('\n')
const CHUNK_QUERIES = ['RSA private key block', 'base64 key material', 'keys']
const CHUNK_RANGE_IN_TEXT = /straddle\.md:(\d+)-(\d+)/g

interface StoredChunk {
  readonly start_line: number
  readonly end_line: number
  readonly text: string
}

// Whether the vector store and the embedding model are both usable here: without them `semantic` and `search` print no stored chunk at all, so there is nothing to test.
function canExerciseRealEmbeddings(): boolean {
  try {
    const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
  } catch {
    return false
  }
  return isAvailable() && modelFilesPresent()
}

// The one global.db the bundle wrote under a data dir, found by a walk bounded to four levels.
function findGlobalDb(dir: string, depth = 0): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === 'global.db') return full
    if (entry.isDirectory() && depth < 4) {
      const found = findGlobalDb(full, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

describe.skipIf(!canExerciseRealEmbeddings())('the built bundle prints no part of a key block cut in half by the semantic index', () => {
  let chunkRoot: string
  let chunkProject: string
  let chunkEnv: NodeJS.ProcessEnv
  let chunks: StoredChunk[]

  const run = (args: string[]): string => {
    const res = bundleTg(chunkProject, chunkEnv, args)
    expect(res.status, res.stderr).toBe(0)
    return res.stdout
  }

  function expectNoKeyBytes(out: string): void {
    expect(out).not.toContain('CHUNKBODY')
    expect(out).not.toContain(PEM_BEGIN)
    expect(out).not.toContain(PEM_END)
  }

  // Every range a command prints must be one a stored chunk starts and ends on (a merge of neighbours keeps the outer two), inside the file.
  function expectRangesFromChunks(ranges: ReadonlyArray<readonly [number, number]>): void {
    const fileLines = CHUNK_FILE.split('\n').length - 1
    expect(ranges.length).toBeGreaterThan(0)
    for (const [start, end] of ranges) {
      expect(chunks.some((c) => c.start_line === start), `start ${start}`).toBe(true)
      expect(chunks.some((c) => c.end_line === end), `end ${end}`).toBe(true)
      expect(end).toBeLessThanOrEqual(fileLines)
    }
  }

  beforeAll(() => {
    ;({ root: chunkRoot, project: chunkProject, env: chunkEnv } = makeBundleProject('tg-read-redact-chunk-'))
    chunkEnv = { ...chunkEnv, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_EMBEDDINGS_ENABLED: 'true' }
    fs.writeFileSync(path.join(chunkProject, CHUNK_FILE_NAME), CHUNK_FILE)
    const idx = bundleTg(chunkProject, chunkEnv, ['index', '.', '--walk', '--embed'])
    expect(idx.status, idx.stderr).toBe(0)
    const dbPath = findGlobalDb(String(chunkEnv.LOCALAPPDATA))
    expect(dbPath, 'the bundle wrote no global.db').not.toBeNull()
    const db = new Database(String(dbPath))
    try {
      chunks = db.prepare('SELECT start_line, end_line, text FROM chunks WHERE file_path LIKE ? ORDER BY start_line').all(`%${CHUNK_FILE_NAME}`) as StoredChunk[]
    } finally {
      db.close()
    }
    const firstHalf = chunks.some((c) => c.text.lastIndexOf(PEM_BEGIN) > c.text.lastIndexOf(PEM_END))
    const secondHalf = chunks.some((c) => c.text.includes(PEM_END) && c.text.indexOf(PEM_END) < (c.text.includes(PEM_BEGIN) ? c.text.indexOf(PEM_BEGIN) : Infinity))
    const bodyOnly = chunks.some((c) => c.text.includes('CHUNKBODY') && !c.text.includes(PEM_BEGIN) && !c.text.includes(PEM_END))
    expect({ firstHalf, secondHalf, bodyOnly }, `${chunks.length} stored chunks`).toEqual({ firstHalf: true, secondHalf: true, bodyOnly: true })
  })

  afterAll(() => {
    fs.rmSync(chunkRoot, { recursive: true, force: true })
  })

  it('semantic prints each stored chunk without any half of a key block, line ranges intact', () => {
    let printed = ''
    for (const query of CHUNK_QUERIES) {
      const out = run(['semantic', query, '-l', '30'])
      expectNoKeyBytes(out)
      printed += out
      expectRangesFromChunks([...out.matchAll(CHUNK_RANGE_IN_TEXT)].map((m) => [Number(m[1]), Number(m[2])] as const))
    }
    expect(printed).toContain(PEM_PLACEHOLDER)
  })

  it('semantic --json previews each stored chunk without any half of a key block, line ranges intact', () => {
    let printed = ''
    for (const query of CHUNK_QUERIES) {
      const out = run(['semantic', query, '-l', '30', '--json'])
      const parsed = JSON.parse(out) as { items: Array<{ startLine: number; endLine: number; preview: string }> }
      expectNoKeyBytes(out)
      printed += out
      expectRangesFromChunks(parsed.items.map((item) => [item.startLine, item.endLine] as const))
    }
    expect(printed).toContain(PEM_PLACEHOLDER)
  })

  it('search prints the semantic channel previews without any half of a key block', () => {
    let printed = ''
    for (const query of CHUNK_QUERIES) {
      const out = run(['search', query])
      expectNoKeyBytes(out)
      printed += out
    }
    expect(printed).toContain(PEM_PLACEHOLDER)
  })

  it('search --json carries no half of a key block, in the fused rows or the channel hits, line ranges intact', () => {
    let printed = ''
    for (const query of CHUNK_QUERIES) {
      const out = run(['search', query, '--json'])
      const parsed = JSON.parse(out) as { results: Array<{ channelHits: Array<{ channel: string; lineStart: number; lineEnd: number }> }> }
      expectNoKeyBytes(out)
      printed += out
      const semantic = parsed.results.flatMap((r) => r.channelHits).filter((h) => h.channel === 'semantic')
      if (semantic.length > 0) expectRangesFromChunks(semantic.map((h) => [h.lineStart, h.lineEnd] as const))
    }
    expect(printed).toContain(PEM_PLACEHOLDER)
  })
})
