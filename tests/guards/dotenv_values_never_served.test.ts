/**
 * A tracked `.env` handed its secrets to the model.
 *
 * `src/walk_index.ts` drops `.env` and `.env.*` from a directory walk and explains why in its own
 * words: they hold secrets, and it is re-adding the safety a bare walk lacks because it has "none
 * of git's exclusions". The premise is wrong. git ignores only what `.gitignore` tells it to, and
 * a tracked `.env` is routine -- `.env.example`, `.env.sample` and `.env.test` are committed on
 * purpose, and a real `.env` gets committed by accident constantly. On the git path, which is the
 * default for essentially every real project, nothing excluded it: the file was chunked and
 * embedded whole, and `token-goat semantic "database connection string"` returned the password as
 * its top hit. `read`, `section` and `symbol` printed it too, from a live disk read.
 *
 * Why no test caught it: the exclusion and its reasoning live entirely in `walk_index.ts`, and the
 * only test that goes near this ground, `tests/guards/index_contents_disclosure.test.ts`, checks
 * that the schema's tables and columns are documented in the README -- it never asserts that no
 * secret-bearing content reaches them. Nothing anywhere asserted the git path protects the same
 * file set the walk path does. That asymmetry is what these tests now pin, on both sides: the
 * values must not reach the chunk table (persistence), and must not reach a command's output
 * (display).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../../src/db.js'
import {
  DOTENV_VALUE_PLACEHOLDER,
  isDotenvPath,
  redactDotenvValues,
} from '../../src/dotenv_redact.js'
import { setPipelineFnForTesting, DEFAULT_DIM } from '../../src/embeddings.js'
import { recordEvidence } from '../../src/evidence_cache.js'
import { collectFiles } from '../../src/pack.js'
import { indexFileEmbeddings } from '../../src/parser.js'
import { runRead, runSymbol } from '../../src/read_commands.js'
import { clearModuleCaches } from '../../src/reset.js'
import { readSection } from '../../src/section_reader.js'
import Database from '../../src/sqlite_driver.js'

/** Fake secrets, built by concatenation so a secrets scanner does not read them as real. */
const DB_SECRET = 'postgres://admin:' + 'hunter2pw' + '@db.internal:5432/app'
const KEY_SECRET = 'sk-' + 'live' + '-9f3a7c1e55b2'

const ENV_FILE = ['# App config', `DATABASE_URL=${DB_SECRET}`, `API_KEY=${KEY_SECRET}`, 'DEBUG=true', ''].join('\n')

function withEnvFile(name: string, body: string, fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-'))
  try {
    const file = join(root, name)
    writeFileSync(file, body)
    fn(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('isDotenvPath', () => {
  // Routed through detectLanguage rather than a second filename pattern, so this list is the
  // indexer's own env_file set and cannot drift away from it.
  it.each([['.env'], ['.env.local'], ['.env.example'], ['.env.production'], ['.envrc']])(
    'treats %s as a dotenv file',
    (name) => {
      expect(isDotenvPath(join('/proj', name))).toBe(true)
    },
  )

  it.each([['env.ts'], ['README.md'], ['environment.yml'], ['config.json']])('leaves %s alone', (name) => {
    expect(isDotenvPath(join('/proj', name))).toBe(false)
  })
})

describe('redactDotenvValues', () => {
  it('keeps the key and removes the value', () => {
    const out = redactDotenvValues(`API_KEY=${KEY_SECRET}`)

    expect(out).toContain('API_KEY')
    expect(out).not.toContain(KEY_SECRET)
    expect(out).toBe(`API_KEY=${DOTENV_VALUE_PLACEHOLDER}`)
  })

  // Every value, not just the ones whose key name looks secret. secret_redact.ts's keyword
  // patterns match neither of these, which is exactly why it is not the tool for this file type.
  it.each([
    ['DEBUG=true'],
    ['PORT=8080'],
    ['DATABASE_URL=postgres://user:pw@host/db'],
  ])('redacts %s, whose key name does not look like a secret', (line) => {
    const out = redactDotenvValues(line)

    expect(out.endsWith(DOTENV_VALUE_PLACEHOLDER)).toBe(true)
  })

  it('handles a shell-style `export ` prefix', () => {
    expect(redactDotenvValues(`export API_KEY=${KEY_SECRET}`)).toBe(`export API_KEY=${DOTENV_VALUE_PLACEHOLDER}`)
  })

  it('handles the colon separator', () => {
    expect(redactDotenvValues(`API_KEY: ${KEY_SECRET}`)).toBe(`API_KEY:${DOTENV_VALUE_PLACEHOLDER}`)
  })

  it('leaves comments and blank lines untouched', () => {
    const out = redactDotenvValues('# App config\n\n# key below\nA=1')

    expect(out).toBe(`# App config\n\n# key below\nA=${DOTENV_VALUE_PLACEHOLDER}`)
  })

  // A bare URL on its own line must not read as a key named `https` -- the `//` after the colon is
  // a scheme separator, not a key/value split. Same `:(?!//)` guard the indexer and section reader
  // use. It is not printed either: it is not blank, not a comment and not an assignment, so the
  // deny-by-default rule redacts it. In a file whose entire content is secret, an unrecognised
  // line is the last thing that should be shown just because nothing matched it.
  it('does not mistake a bare URL line for an assignment, and does not print it', () => {
    const out = redactDotenvValues('# see\nhttps://example.com/docs')

    expect(out).not.toContain('https=')
    expect(out).not.toContain('example.com')
    expect(out).toBe(`# see\n${DOTENV_VALUE_PLACEHOLDER}`)
  })

  // `.env` and `.envrc` are sourced by a shell, where `KEY+=more` appends. Matching only `=` left
  // the appended half in the clear on the line right below a redacted one.
  it('redacts a shell append assignment', () => {
    const out = redactDotenvValues('API_KEY=first\nAPI_KEY+=' + 'appended-secret')

    expect(out).not.toContain('appended-secret')
    expect(out).toContain('API_KEY+=')
  })

  // An unquoted trailing backslash continues the value onto the next line in shell. The redactor
  // does not model that syntax, and does not need to: the continuation is not blank, not a comment
  // and not an assignment, so deny-by-default catches it.
  it('redacts an unquoted shell line continuation', () => {
    const out = redactDotenvValues('API_KEY=head\\\n  ' + 'tail-secret')

    expect(out).not.toContain('tail-secret')
  })

  // U+FEFF is inside JS's `\s` class, so the leading-whitespace part of the pattern absorbs a BOM
  // and the first assignment in a BOM-prefixed file is redacted like any other. Pinned because it
  // is non-obvious enough to be "fixed" into a real bypass by someone tightening the pattern.
  it('redacts the first assignment in a BOM-prefixed file', () => {
    const out = redactDotenvValues('﻿API_KEY=' + 'bom-secret')

    expect(out).not.toContain('bom-secret')
  })

  it('keeps CRLF line endings instead of leaving the text mixed', () => {
    const out = redactDotenvValues('# c\r\nA=1\r\nB="two\r\nstill"\r\n')

    expect(out.split('\r\n').length).toBe(5)
    expect(out).not.toContain('\n\n')
    expect(out.includes('1')).toBe(false)
  })

  // The continuation lines of a wrapped value ARE the secret -- a PEM body is nothing but
  // continuation lines. Passing them through would defeat the whole redaction for the single case
  // where the secret is largest.
  it('redacts every line of a quoted value that spans lines', () => {
    const pem = ['CERT="-----BEGIN KEY-----', 'MIIBOgIBAAJBAK' + 'secretbodyhere', '-----END KEY-----"', 'NEXT=1'].join(
      '\n',
    )

    const out = redactDotenvValues(pem)

    expect(out).not.toContain('secretbodyhere')
    expect(out).not.toContain('BEGIN KEY')
    expect(out).toContain('CERT=')
    // The key after the multi-line value is still recognised, so quote tracking closed correctly.
    expect(out).toContain(`NEXT=${DOTENV_VALUE_PLACEHOLDER}`)
  })

  // Callers slice this text by line number against ranges built from the unredacted file, so a
  // dropped or merged line would silently shift every range after it.
  it('preserves the line count exactly', () => {
    const input = ['A=1', 'B="two', 'still two"', '# c', '', 'D=4'].join('\n')

    expect(redactDotenvValues(input).split('\n').length).toBe(input.split('\n').length)
  })

  it('is idempotent, so a second pass over already-redacted text changes nothing', () => {
    const once = redactDotenvValues(ENV_FILE)

    expect(redactDotenvValues(once)).toBe(once)
  })
})

describe('display: no command prints a dotenv value', () => {
  it('read "<.env>::KEY" gives the key without its value', () => {
    withEnvFile('.env', ENV_FILE, (file) => {
      const { text, code } = runRead({ spec: `${file}::DATABASE_URL` })

      expect(code).toBe(0)
      expect(text).toContain('DATABASE_URL')
      expect(text).not.toContain(DB_SECRET)
      expect(text).not.toContain('hunter2pw')
    })
  })

  it('symbol --file gives the key without its value', () => {
    withEnvFile('.env', ENV_FILE, (file) => {
      const { text } = runSymbol({ name: 'API_KEY', file })

      expect(text).toContain('API_KEY')
      expect(text).not.toContain(KEY_SECRET)
    })
  })

  // readSection is the plain CLI path for `token-goat section` and passes no readFn, so it reads
  // through its own fs call rather than read_commands.ts's. Both seams need the redaction; this
  // pins the one that is easy to forget.
  it('section reads the key without its value', () => {
    withEnvFile('.env', ENV_FILE, (file) => {
      const section = readSection(file, 'API_KEY')

      expect(section).not.toBeNull()
      expect(section?.content).toContain('API_KEY')
      expect(section?.content).not.toContain(KEY_SECRET)
    })
  })

  // .env.example is committed on purpose and is a routine place to find a real key someone pasted
  // while filling it in, so it gets the same treatment as .env.
  it('covers .env.example too, not only a bare .env', () => {
    withEnvFile('.env.example', ENV_FILE, (file) => {
      const { text } = runRead({ spec: `${file}::API_KEY` })

      expect(text).not.toContain(KEY_SECRET)
    })
  })

  it('does not redact a file that merely mentions env vars', () => {
    withEnvFile('notes.md', `# Setup\n\nSet API_KEY=${KEY_SECRET} in your shell.\n`, (file) => {
      const section = readSection(file, 'Setup')

      expect(section?.content).toContain(KEY_SECRET)
    })
  })
})

describe('the other paths that hand file text to a model', () => {
  // A pack glob sweeps whole directories, so a tracked .env is bundled without anyone naming it.
  it('pack bundles the keys without the values', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-pack-'))
    try {
      writeFileSync(join(root, '.env'), ENV_FILE)
      const result = collectFiles(root, ['.env'])
      const bundled = result.files.map((f) => f.content).join('\n')

      expect(result.files.length).toBe(1)
      expect(bundled).not.toContain(DB_SECRET)
      expect(bundled).not.toContain(KEY_SECRET)
      expect(bundled).toContain('API_KEY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // recordEvidence ran the text through redactSecrets only. That is keyword-driven, so it caught
  // API_KEY and left DEBUG alone -- a partial redaction, which is the failure mode that reads as
  // handled and is not. `semantic` emits cached evidence, so the miss reached the model.
  it('cached evidence holds no dotenv value, including one whose key looks harmless', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-evidence-'))
    try {
      const source = join(root, '.env')
      const text = `${ENV_FILE}HARMLESS_LOOKING=${'plainsecret444'}\n`
      writeFileSync(source, text)

      const entry = recordEvidence({ projectRoot: root, source, representation: 'file', text })

      expect(entry).not.toBeNull()
      const stored = JSON.stringify(entry)
      expect(stored).not.toContain(DB_SECRET)
      expect(stored).not.toContain(KEY_SECRET)
      expect(stored).not.toContain('plainsecret444')
    } finally {
      closeAllDbs()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // `bash-output --file` is a general "print this file" recall path and is not exported, so this
  // goes through the built bundle -- the artifact that actually ships.
  it('bash-output --file prints the keys without the values', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-bashout-'))
    try {
      const file = join(root, '.env')
      writeFileSync(file, ENV_FILE)
      const bundle = resolve(process.cwd(), 'dist', 'token-goat.mjs')

      const run = spawnSync(process.execPath, [bundle, 'bash-output', '--file', file], { encoding: 'utf8' })

      expect(run.status).toBe(0)
      const out = `${run.stdout}${run.stderr}`
      expect(out).not.toContain(DB_SECRET)
      expect(out).not.toContain(KEY_SECRET)
      expect(out).toContain('API_KEY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Redacting from now on does not undo what is already stored. The embed-freshness gate skips a
// file whose bytes have not changed, so an index built before the fix would have gone on serving
// its .env chunks forever -- a fix that leaves the leak live for every existing install.
describe('schema v11 migration purges chunks indexed before the fix', () => {
  afterEach(() => {
    closeAllDbs()
    clearModuleCaches()
  })

  it('deletes dotenv chunks, clears their embed_sha, and leaves other files alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-migrate-'))
    try {
      const dbPath = join(root, 'global.db')
      const envPath = join(root, '.env')
      const codePath = join(root, 'app.ts')

      const seed = getDb(dbPath)
      seed.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?,1,4,?,?)').run(
        envPath,
        ENV_FILE,
        'window',
      )
      seed.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?,1,2,?,?)').run(
        codePath,
        'export const x = 1',
        'window',
      )
      seed
        .prepare("INSERT INTO files (path, sha, embed_sha) VALUES (?, 'abc', 'abc')")
        .run(envPath)
      // Roll the stamp back so reopening runs the v10 -> v11 step against rows that already exist,
      // which is the real upgrade shape: an index written by the previous release.
      seed.pragma('user_version = 10')
      closeAllDbs()

      const db = getDb(dbPath)

      const remaining = db.prepare('SELECT file_path, text FROM chunks').all() as {
        file_path: string
        text: string
      }[]
      expect(remaining.map((r) => r.file_path)).toEqual([codePath])
      expect(JSON.stringify(remaining)).not.toContain(DB_SECRET)
      expect(JSON.stringify(remaining)).not.toContain(KEY_SECRET)
      // Cleared, so the next drain re-embeds the file through the redacting path instead of
      // treating it as already done.
      const row = db.prepare('SELECT embed_sha FROM files WHERE path = ?').get(envPath) as
        | { embed_sha: string | null }
        | undefined
      expect(row?.embed_sha ?? null).toBeNull()
    } finally {
      closeAllDbs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

// Skips cleanly rather than silently when the optional native extension is absent, mirroring the
// gate tests/semantic_project_scope.test.ts already uses. The display tests above are
// dependency-free and cover the same defect from the other side, so a machine without sqlite-vec
// is not left with no coverage of this at all.
const canExerciseVec0 = vec0Working()

describe.skipIf(!canExerciseVec0)('persistence: no dotenv value reaches the chunk table', () => {
  let savedEmbedFlag: string | undefined

  beforeEach(() => {
    // The shared test setup turns embeddings off to keep the suite fast, which would make
    // indexFileEmbeddings return before it chunks anything -- and an empty chunk table would let
    // this test pass without ever exercising the path it exists to cover.
    savedEmbedFlag = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = '1'
    clearModuleCaches()
  })

  afterEach(() => {
    if (savedEmbedFlag === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = savedEmbedFlag
    closeAllDbs()
    clearModuleCaches()
  })

  it('indexes the keys but stores no value, so semantic has nothing to return', async () => {
    // A cheap fake transformer keeps this on the real production path (indexFileEmbeddings ->
    // chunkFile -> upsertChunks -> the chunks table) without a model download or inference. Only
    // the model is faked; every line that decides what text gets stored is the shipping code.
    setPipelineFnForTesting(async () => vi.fn(async () => ({ data: new Float32Array(DEFAULT_DIM).fill(0.01) })))

    const root = mkdtempSync(join(tmpdir(), 'tg-dotenv-chunks-'))
    try {
      const file = join(root, '.env')
      writeFileSync(file, ENV_FILE)
      const dbPath = join(root, 'global.db')

      await indexFileEmbeddings(file, dbPath)

      const rows = getDb(dbPath)
        .prepare('SELECT text FROM chunks')
        .all() as { text: string }[]
      const stored = rows.map((r) => r.text).join('\n')

      expect(stored).not.toContain(DB_SECRET)
      expect(stored).not.toContain(KEY_SECRET)
      expect(stored).not.toContain('hunter2pw')
      // The keys are the useful, non-secret part and are deliberately still searchable. Asserting
      // this stops a future "fix" from passing by simply refusing to index the file at all.
      expect(stored).toContain('API_KEY')
      expect(stored).toContain('DATABASE_URL')
    } finally {
      // Windows keeps an open sqlite handle locked, so the directory cannot be removed until the
      // connection is closed -- close here rather than only in afterEach.
      closeAllDbs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
