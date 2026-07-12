/**
 * Tests for the miscellaneous filter family (Batch K2).
 *
 * Covers: PsqlFilter, MySQLFilter, Sqlite3Filter, RedisCLIFilter,
 * SysPackageFilter, ProtocFilter, SassFilter, ToxFilter, NoxFilter,
 * WasmPackFilter, NgFilter, PlaywrightFilter, CypressFilter,
 * DotenvFilter, EnvFilter, JsonArrayFilter, SeverityLogFilter, TailTruncFilter.
 *
 * Ported from the Python golden tests in tests/test_bash_compress_*.py.
 */
import { describe, expect, it } from 'vitest'

import {
  PlaywrightFilter, playwrightFilter,
  CypressFilter, cypressFilter,
  PsqlFilter, psqlFilter,
  MySQLFilter, mySQLFilter,
  Sqlite3Filter, sqlite3Filter,
  RedisCLIFilter, redisCLIFilter,
  SysPackageFilter, sysPackageFilter,
  ProtocFilter, protocFilter,
  SassFilter, sassFilter,
  ToxFilter, toxFilter,
  NoxFilter, noxFilter,
  WasmPackFilter, wasmPackFilter,
  NgFilter, ngFilter,
  DotenvFilter, dotenvFilter,
  EnvFilter, envFilter,
  JsonArrayFilter, jsonArrayFilter,
  SeverityLogFilter, severityLogFilter,
  TailTruncFilter, tailTruncFilter,
  MISC_FILTERS,
  BunFilter,
} from '../src/tool_filters/index.js'
import { selectFilter, TOOL_FILTERS } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function apply(
  filter: { compress: (a: string, b: string, c: number, d: string[]) => string },
  stdout: string,
  argv: string[],
  { stderr = '', exitCode = 0 } = {},
): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// ---------------------------------------------------------------------------
// MISC_FILTERS ordering invariants
// ---------------------------------------------------------------------------

describe('MISC_FILTERS ordering', () => {
  it('TailTruncFilter is the last entry in MISC_FILTERS', () => {
    expect(MISC_FILTERS[MISC_FILTERS.length - 1]).toBeInstanceOf(TailTruncFilter)
  })

  it('SeverityLogFilter is second-to-last in MISC_FILTERS', () => {
    expect(MISC_FILTERS[MISC_FILTERS.length - 2]).toBeInstanceOf(SeverityLogFilter)
  })

  it('has 16 filters (PlaywrightFilter and CypressFilter are in dispatch.ts, not here)', () => {
    expect(MISC_FILTERS).toHaveLength(16)
  })
})

describe('PlaywrightFilter dispatch ordering', () => {
  it('playwrightFilter is registered before bunFilter in TOOL_FILTERS', () => {
    const pwIdx = TOOL_FILTERS.findIndex((f) => f instanceof PlaywrightFilter)
    const bunIdx = TOOL_FILTERS.findIndex((f) => f instanceof BunFilter)
    expect(pwIdx).toBeGreaterThanOrEqual(0)
    expect(bunIdx).toBeGreaterThanOrEqual(0)
    expect(pwIdx).toBeLessThan(bunIdx)
  })

  it('cypressFilter is registered before bunFilter in TOOL_FILTERS', () => {
    const cyIdx = TOOL_FILTERS.findIndex((f) => f instanceof CypressFilter)
    const bunIdx = TOOL_FILTERS.findIndex((f) => f instanceof BunFilter)
    expect(cyIdx).toBeLessThan(bunIdx)
  })

  it('bunx playwright test routes to PlaywrightFilter, not BunFilter', () => {
    const f = selectFilter(['bunx', 'playwright', 'test'])
    expect(f).toBeInstanceOf(PlaywrightFilter)
  })

  it('bunx cypress run routes to CypressFilter, not BunFilter', () => {
    const f = selectFilter(['bunx', 'cypress', 'run'])
    expect(f).toBeInstanceOf(CypressFilter)
  })
})

// ---------------------------------------------------------------------------
// PlaywrightFilter
// ---------------------------------------------------------------------------

describe('PlaywrightFilter matches', () => {
  const f = new PlaywrightFilter()

  it('matches playwright test', () => expect(f.matches(['playwright', 'test'])).toBe(true))
  it('matches npx playwright test', () => expect(f.matches(['npx', 'playwright', 'test'])).toBe(true))
  it('matches pnpx playwright codegen', () => expect(f.matches(['pnpx', 'playwright', 'codegen'])).toBe(true))
  it('matches bunx playwright install', () => expect(f.matches(['bunx', 'playwright', 'install'])).toBe(true))
  it('does not match playwright unknown-subcmd', () => expect(f.matches(['playwright', 'unknown-subcmd'])).toBe(false))
  it('selectFilter routes playwright test', () => expect(selectFilter(['playwright', 'test'])).toBeInstanceOf(PlaywrightFilter))
})

describe('PlaywrightFilter compression', () => {
  it('suppresses pass-test tick lines', () => {
    const out = apply(playwrightFilter,
      '  ✓ should load page\n  ✔ button click works\nFailed: 0\n',
      ['playwright', 'test'])
    expect(out).not.toMatch(/✓|✔/)
    expect(out).toContain('Failed: 0')
  })

  it('suppresses download progress lines', () => {
    const out = apply(playwrightFilter,
      'Downloading Chromium 1234\n25 Mb [===]\nInstalling Playwright\nDone\n',
      ['playwright', 'install'])
    expect(out).toContain('Done')
    expect(out).not.toContain('Downloading')
  })

  it('keeps error output unchanged', () => {
    const out = apply(playwrightFilter,
      '  ✓ pass test\nError: timeout exceeded\n',
      ['playwright', 'test'])
    expect(out).toContain('Error: timeout exceeded')
  })

  it('includes suppressed count note', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `  ✓ test ${i}`).join('\n')
    const out = apply(playwrightFilter, lines + '\nAll done\n', ['playwright', 'test'])
    expect(out).toMatch(/suppressed 10/)
  })
})

// ---------------------------------------------------------------------------
// CypressFilter
// ---------------------------------------------------------------------------

describe('CypressFilter matches', () => {
  const f = new CypressFilter()

  it('matches cypress run', () => expect(f.matches(['cypress', 'run'])).toBe(true))
  it('matches npx cypress open', () => expect(f.matches(['npx', 'cypress', 'open'])).toBe(true))
  it('matches pnpx cypress run', () => expect(f.matches(['pnpx', 'cypress', 'run'])).toBe(true))
  it('does not match cypress unknown', () => expect(f.matches(['cypress', 'unknown'])).toBe(false))
  it('selectFilter routes cypress run', () => expect(selectFilter(['cypress', 'run'])).toBeInstanceOf(CypressFilter))
})

describe('CypressFilter compression', () => {
  it('suppresses Run Starting box', () => {
    const stdout = [
      '',
      '  (Run Starting)',
      '',
      '  ┌────────────────────┐',
      '  │ Cypress version 12 │',
      '  └────────────────────┘',
      '',
      'Some test output',
      '',
      '  (Run Finished)',
      '',
      'Done',
    ].join('\n')
    const out = apply(cypressFilter, stdout, ['cypress', 'run'])
    expect(out).not.toContain('Run Starting')
    expect(out).toContain('Run Finished')
    expect(out).toContain('Done')
  })

  it('suppresses separator lines', () => {
    const out = apply(cypressFilter,
      '──────────────────────\nTest output\n──────────────────────\n',
      ['cypress', 'run'])
    expect(out).not.toMatch(/─{30,}/)
    expect(out).toContain('Test output')
  })

  it('suppresses passing test lines even when the run has failures (nonzero exit code)', () => {
    const stdout = [
      '  Login Flow',
      '    ✓ logs in with valid credentials (120ms)',
      '    ✓ logs out (80ms)',
      '    ✓ remembers session (95ms)',
      '    1) rejects invalid credentials',
      '',
      '  0 passing',
      '  1 failing',
    ].join('\n')
    const out = apply(cypressFilter, stdout, ['cypress', 'run'], { exitCode: 1 })
    // Passing lines must be suppressed regardless of overall exit code
    expect(out).not.toContain('✓ logs in with valid credentials')
    expect(out).not.toContain('✓ logs out')
    expect(out).not.toContain('✓ remembers session')
    expect(out).toContain('suppressed 3 passing test lines')
    // The failing test itself must survive
    expect(out).toContain('rejects invalid credentials')
  })
})

// ---------------------------------------------------------------------------
// PsqlFilter
// ---------------------------------------------------------------------------

describe('PsqlFilter dispatch', () => {
  it('selectFilter routes psql', () => expect(selectFilter(['psql', '-U', 'pg'])).toBeInstanceOf(PsqlFilter))
})

describe('PsqlFilter migration summary', () => {
  it('summarises bulk CREATE TABLE output', () => {
    const lines = [
      'CREATE TABLE users',
      'CREATE TABLE posts',
      'CREATE TABLE comments',
      'CREATE INDEX idx_users_email',
      'CREATE UNIQUE INDEX idx_posts_slug',
    ].join('\n')
    const out = apply(psqlFilter, lines, ['psql'])
    expect(out).toMatch(/Created.*3 tables/)
    expect(out).toMatch(/2 indexes/)
    expect(out).not.toMatch(/CREATE TABLE users/)
  })

  it('does not summarise fewer than 3 CREATE TABLE lines', () => {
    const out = apply(psqlFilter, 'CREATE TABLE foo\nCREATE TABLE bar\n', ['psql'])
    expect(out).toContain('CREATE TABLE foo')
  })

  it('counts non-table/index DDL categories instead of silently dropping them (regression)', () => {
    const lines = [
      'CREATE TABLE users',
      'CREATE TABLE posts',
      'CREATE TABLE comments',
      'CREATE FUNCTION update_ts()',
      'CREATE VIEW active_users',
      'CREATE TYPE status_enum',
      'CREATE SEQUENCE seq_1',
      'CREATE TRIGGER trg_1',
      'ALTER TABLE users',
      'ADD CONSTRAINT fk_1',
    ].join('\n')
    const out = apply(psqlFilter, lines, ['psql'])
    expect(out).toMatch(/Created.*3 tables/)
    expect(out).toMatch(/1 function\b/)
    expect(out).toMatch(/1 view\b/)
    expect(out).toMatch(/1 type\b/)
    expect(out).toMatch(/1 sequence\b/)
    expect(out).toMatch(/1 trigger\b/)
    expect(out).toMatch(/2 alterations/)
    expect(out).not.toMatch(/CREATE FUNCTION/)
    expect(out).not.toMatch(/CREATE VIEW/)
    expect(out).not.toMatch(/CREATE TYPE/)
    expect(out).not.toMatch(/CREATE SEQUENCE/)
    expect(out).not.toMatch(/CREATE TRIGGER/)
    expect(out).not.toMatch(/ALTER TABLE/)
    expect(out).not.toMatch(/ADD CONSTRAINT/)
  })
})

describe('PsqlFilter table collapse', () => {
  it('collapses large SELECT output to first 5 rows', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `| row ${i} |`)
    const out = apply(psqlFilter,
      `+-------+\n| col   |\n+-------+\n${rows.join('\n')}\n+-------+\n(25 rows)\n`,
      ['psql'])
    expect(out).toContain('25 rows')
    expect(out).not.toContain('| row 20 |')
    expect(out).toContain('| row 0 |')
  })

  it('keeps small SELECT output intact', () => {
    const out = apply(psqlFilter,
      '+---+\n| a |\n+---+\n| 1 |\n| 2 |\n+---+\n(2 rows)\n',
      ['psql'])
    expect(out).toContain('| 1 |')
    expect(out).toContain('| 2 |')
  })
})

describe('PsqlFilter border-style-2 output (\\pset border 2)', () => {
  it('treats the header row under a leading top border as the header, not a data row', () => {
    // border-2 style: top border BEFORE the header text, unlike the default style where the
    // header text has no border above it. The old state machine only popped the header line
    // on the FIRST border line seen, so the header fell through into the dataRows bucket here.
    const dataRows = Array.from({ length: 30 }, (_, i) => `|  ${i} | person${i} |`)
    const text =
      '+----+---------+\n' +
      '| id | name    |\n' +
      '+----+---------+\n' +
      dataRows.join('\n') +
      '\n+----+---------+\n' +
      '(30 rows)\n'
    const out = apply(psqlFilter, text, ['psql'])

    // Header text is preserved verbatim, not swallowed into the truncated data-row bucket.
    expect(out).toContain('| id | name    |')
    // The internal row-count summary must reflect the true 30 data rows, not 31 (header
    // counted as a row). psql's own "(30 rows)" footer line is untouched either way, so this
    // asserts on token-goat's own generated summary text specifically.
    expect(out).toContain('[token-goat: 30 rows')
    expect(out).not.toContain('[token-goat: 31 rows')
  })
})

describe('PsqlFilter keeps errors', () => {
  it('passes through ERROR lines', () => {
    const out = apply(psqlFilter, 'ERROR: column "x" does not exist\n', ['psql'], { exitCode: 1 })
    expect(out).toContain('ERROR: column "x" does not exist')
  })
})

// ---------------------------------------------------------------------------
// MySQLFilter
// ---------------------------------------------------------------------------

describe('MySQLFilter dispatch', () => {
  it('selectFilter routes mysql', () => expect(selectFilter(['mysql', '-u', 'root'])).toBeInstanceOf(MySQLFilter))
  it('selectFilter routes mysqldump', () => expect(selectFilter(['mysqldump', 'mydb'])).toBeInstanceOf(MySQLFilter))
})

describe('MySQLFilter query compression', () => {
  it('collapses large result set to first 5 rows', () => {
    const rows = Array.from({ length: 22 }, (_, i) => `| row ${i} |`)
    const out = apply(mySQLFilter,
      `+-------+\n| col   |\n+-------+\n${rows.join('\n')}\n+-------+\n22 rows in set (0.01 sec)\n`,
      ['mysql', '-u', 'root'])
    expect(out).toContain('22 rows in set')
    expect(out).not.toContain('| row 20 |')
  })

  it('keeps small result set', () => {
    const out = apply(mySQLFilter,
      '+---+\n| a |\n+---+\n| 1 |\n+---+\n1 row in set (0.00 sec)\n',
      ['mysql'])
    expect(out).toContain('| 1 |')
  })
})

describe('MySQLFilter dump compression', () => {
  // Realistic mysqldump per-table structure: leading `--` comment lines, a
  // blank line, THEN the DROP TABLE/CREATE TABLE body, ending in another
  // blank line. (A fixture without the `--` comments before the blank line
  // masks the backwards blank-line-skip bug entirely — see regression below.)
  const table = (i: number): string => [
    '--',
    `-- Table structure for table \`tbl${i}\``,
    '--',
    '',
    `DROP TABLE IF EXISTS \`tbl${i}\`;`,
    `CREATE TABLE \`tbl${i}\` (`,
    '  `id` int NOT NULL AUTO_INCREMENT,',
    '  PRIMARY KEY (`id`)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
    '',
  ].join('\n')

  it('keeps first 3 CREATE TABLE blocks, collapses rest', () => {
    const dump = Array.from({ length: 5 }, (_, i) => table(i)).join('')
    const out = apply(mySQLFilter, dump, ['mysqldump', 'mydb'])
    expect(out).toContain("Table structure for table `tbl0`")
    expect(out).toContain("Table structure for table `tbl2`")
    expect(out).not.toContain("Table structure for table `tbl4`")
  })

  it('actually compresses the CREATE TABLE DDL body for collapsed tables (regression: blank line precedes DROP/CREATE in real mysqldump output, not just follows it)', () => {
    const dump = Array.from({ length: 5 }, (_, i) => table(i)).join('')
    const out = apply(mySQLFilter, dump, ['mysqldump', 'mydb'])

    // First 3 tables' full DDL survives
    expect(out).toContain('CREATE TABLE `tbl0`')
    expect(out).toContain('CREATE TABLE `tbl1`')
    expect(out).toContain('CREATE TABLE `tbl2`')

    // Tables beyond DUMP_KEEP_TABLES (3) must have their DDL collapsed, not survive unfiltered
    expect(out).not.toContain('CREATE TABLE `tbl3`')
    expect(out).not.toContain('CREATE TABLE `tbl4`')
    expect(out).not.toContain('DROP TABLE IF EXISTS `tbl3`')
    expect(out).not.toContain('DROP TABLE IF EXISTS `tbl4`')
    expect(out).toContain('Dumping 5 tables')
  })
})

// ---------------------------------------------------------------------------
// Sqlite3Filter
// ---------------------------------------------------------------------------

describe('Sqlite3Filter dispatch', () => {
  it('selectFilter routes sqlite3', () => expect(selectFilter(['sqlite3', 'mydb.db'])).toBeInstanceOf(Sqlite3Filter))
})

describe('Sqlite3Filter schema passthrough', () => {
  it('passes through schema-heavy output', () => {
    const schema = [
      'CREATE TABLE users (id INT, name TEXT);',
      'CREATE INDEX idx_users ON users(name);',
      'CREATE TABLE posts (id INT, body TEXT);',
    ].join('\n')
    const out = apply(sqlite3Filter, schema, ['sqlite3'])
    expect(out).toContain('CREATE TABLE users')
  })
})

describe('Sqlite3Filter row collapse', () => {
  it('collapses many data rows', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `row${i}|data`).join('\n')
    const out = apply(sqlite3Filter, rows, ['sqlite3'])
    expect(out).toContain('25 rows')
    expect(out).not.toContain('row24|data')
  })
})

// ---------------------------------------------------------------------------
// RedisCLIFilter
// ---------------------------------------------------------------------------

describe('RedisCLIFilter dispatch', () => {
  it('selectFilter routes redis-cli', () => expect(selectFilter(['redis-cli', 'GET', 'key'])).toBeInstanceOf(RedisCLIFilter))
})

describe('RedisCLIFilter SCAN compression', () => {
  it('collapses SCAN key list to first 10', () => {
    // Real redis-cli SCAN output: first line is cursor, then nested list of keys
    const scanOutput = [
      '1) (integer) 0',
      ...Array.from({ length: 20 }, (_, i) => `   ${i + 1}) "key:${i}"`),
    ].join('\n')
    const out = apply(redisCLIFilter, scanOutput, ['redis-cli'])
    expect(out).toContain('20 keys total')
    expect(out).not.toContain('"key:19"')
    expect(out).toContain('"key:0"')
  })
})

describe('RedisCLIFilter bulk OK', () => {
  it('collapses 5+ OK responses', () => {
    const out = apply(redisCLIFilter, Array(6).fill('OK').join('\n'), ['redis-cli'])
    expect(out).toContain('6 OK responses')
    expect(out).not.toContain('OK\nOK')
  })
})

// ---------------------------------------------------------------------------
// SysPackageFilter
// ---------------------------------------------------------------------------

describe('SysPackageFilter dispatch', () => {
  it('selectFilter routes apt-get', () => expect(selectFilter(['apt-get', 'install', 'curl'])).toBeInstanceOf(SysPackageFilter))
  it('selectFilter routes apk', () => expect(selectFilter(['apk', 'add', 'curl'])).toBeInstanceOf(SysPackageFilter))
  it('selectFilter routes brew', () => expect(selectFilter(['brew', 'install', 'git'])).toBeInstanceOf(SysPackageFilter))
})

describe('SysPackageFilter apt compression', () => {
  it('collapses Get:N download lines', () => {
    const out = apply(sysPackageFilter,
      Array.from({ length: 5 }, (_, i) => `Get:${i + 1} http://archive.ubuntu.com/ubuntu bionic/main pkg${i}`).join('\n'),
      ['apt-get', 'install', 'curl'])
    expect(out).toContain("collapsed 5 'Get:N' download lines")
    expect(out).not.toContain('Get:1')
  })

  it('collapses Unpacking/Setting up lines', () => {
    const out = apply(sysPackageFilter,
      'Unpacking curl (7.x)\nSetting up curl (7.x)\nUnpacking libcurl (7.x)\n',
      ['apt-get', 'install', 'curl'])
    expect(out).toContain("collapsed 3 'Unpacking/Setting up' lines")
  })

  it('keeps error lines', () => {
    const out = apply(sysPackageFilter,
      'E: Could not open lock file\n',
      ['apt-get', 'install', 'curl'])
    expect(out).toContain('E: Could not open lock file')
  })
})

describe('SysPackageFilter apk compression', () => {
  it('collapses fetch lines', () => {
    const out = apply(sysPackageFilter,
      'fetch https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64/APKINDEX.tar.gz\nfetch https://cdn.example.com/APKINDEX.tar.gz\nOK: 123 MiB in 43 packages\n',
      ['apk', 'add', 'curl'])
    expect(out).toContain("collapsed 2 'fetch' download lines")
    expect(out).toContain('OK:')
  })
})

describe('SysPackageFilter brew compression', () => {
  it('samples first 3 progress lines + collapses rest', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `==> Downloading https://example.com/pkg${i}.bottle.tar.gz`)
    const out = apply(sysPackageFilter, lines.join('\n'), ['brew', 'install', 'gcc'])
    expect(out).toContain('+7 more brew progress lines collapsed')
    expect(out).toContain('Downloading https://example.com/pkg0')
  })
})

// ---------------------------------------------------------------------------
// ProtocFilter
// ---------------------------------------------------------------------------

describe('ProtocFilter dispatch', () => {
  it('selectFilter routes protoc', () => expect(selectFilter(['protoc', '--go_out=.', 'foo.proto'])).toBeInstanceOf(ProtocFilter))
  it('selectFilter routes buf', () => expect(selectFilter(['buf', 'generate'])).toBeInstanceOf(ProtocFilter))
})

describe('ProtocFilter compression', () => {
  it('drops [libprotobuf INFO] lines', () => {
    const out = apply(protocFilter,
      '[libprotobuf INFO google/protobuf/any.cc:99] processing file\n',
      ['protoc'])
    // The original line content must be absent; the note references the pattern text
    expect(out).not.toContain('[libprotobuf INFO google/protobuf/any.cc:99] processing file')
    expect(out).toContain('dropped 1')
  })

  it('keeps [libprotobuf WARNING] lines', () => {
    const out = apply(protocFilter,
      '[libprotobuf WARNING foo.cc:10] no syntax\n',
      ['protoc'])
    expect(out).toContain('[libprotobuf WARNING')
  })

  it('keeps proto diagnostics', () => {
    const out = apply(protocFilter,
      'path/to/file.proto:12:5: error: "Bar" is already defined\n',
      ['protoc'])
    expect(out).toContain('path/to/file.proto:12:5: error')
  })

  it('deduplicates repeated identical warning lines', () => {
    const warn = '[libprotobuf WARNING google/protobuf/compiler/parser.cc:553] No syntax specified for the proto file'
    const out = apply(protocFilter, Array(15).fill(warn).join('\n'), ['protoc'])
    const cnt = out.split('\n').filter((l) => l.includes('No syntax specified')).length
    expect(cnt).toBe(1)
    expect(out).toMatch(/collapsed 14 repeated warning/)
  })

  it('keeps summary lines', () => {
    const out = apply(protocFilter, '3 errors generated.\n', ['protoc'])
    expect(out).toContain('3 errors generated.')
  })
})

// ---------------------------------------------------------------------------
// SassFilter
// ---------------------------------------------------------------------------

describe('SassFilter dispatch', () => {
  it('selectFilter routes sass', () => expect(selectFilter(['sass', 'src/main.scss', 'dist/main.css'])).toBeInstanceOf(SassFilter))
  it('selectFilter routes lessc', () => expect(selectFilter(['lessc', 'main.less', 'main.css'])).toBeInstanceOf(SassFilter))
})

describe('SassFilter compression', () => {
  it('samples first 5 write lines', () => {
    const writes = Array.from({ length: 8 }, (_, i) => `  write dist/chunk${i}.css`).join('\n')
    const out = apply(sassFilter, writes + '\nCompilation complete\n', ['sass'])
    expect(out).toContain('+3 more compiled CSS files')
    expect(out).toContain('write dist/chunk0.css')
    expect(out).not.toContain('write dist/chunk7.css')
  })

  it('drops source map write lines', () => {
    const out = apply(sassFilter, '  write dist/main.css\n  write dist/main.css.map\n', ['sass'])
    expect(out).not.toContain('.css.map')
    expect(out).toContain('dropped 1 source-map write lines')
  })

  it('deduplicates deprecation warnings (keeps first 2 per prefix)', () => {
    const warn = 'Deprecation Warning: $function is deprecated and will be removed in Dart Sass 2.0.0'
    const out = apply(sassFilter, Array(5).fill(warn).join('\n'), ['sass'])
    const cnt = out.split('\n').filter((l) => l.includes('$function is deprecated')).length
    expect(cnt).toBe(2)
    expect(out).toMatch(/collapsed 3 duplicate deprecation/)
  })

  it('keeps error lines', () => {
    const out = apply(sassFilter, 'Error: Expected expression.\n  on line 5 of src/main.scss\n', ['sass'])
    expect(out).toContain('Error: Expected expression.')
  })
})

// ---------------------------------------------------------------------------
// ToxFilter
// ---------------------------------------------------------------------------

describe('ToxFilter dispatch', () => {
  // `tox` is deliberately absent from TWO_TOKEN_PREFIXES, so `-e <env>` is never
  // mistaken for a launcher token and stripped down to a bare env name like
  // `py312` (which would match no registered filter and run unfiltered).
  it('selectFilter routes tox', () => expect(selectFilter(['tox'])).toBeInstanceOf(ToxFilter))
  it('selectFilter routes tox --parallel', () => expect(selectFilter(['tox', '--parallel'])).toBeInstanceOf(ToxFilter))
  it('selectFilter routes tox -e py312 (regression: was mis-stripped to a bare env name)', () => {
    expect(selectFilter(['tox', '-e', 'py312'])).toBeInstanceOf(ToxFilter)
  })
  it('selectFilter routes tox -e py312,py313 (multi-env selector)', () => {
    expect(selectFilter(['tox', '-e', 'py312,py313'])).toBeInstanceOf(ToxFilter)
  })
})

describe('ToxFilter compression', () => {
  it('collapses pip install progress', () => {
    const pip = 'Collecting requests\nDownloading requests-2.31.0\nInstalling collected packages: requests\n'
    const out = apply(toxFilter, pip + '1 passed in 0.1s\n', ['tox'])
    expect(out).not.toContain('Collecting requests')
    expect(out).toContain('1 passed in 0.1s')
  })

  it('collapses Requirement already satisfied lines', () => {
    const out = apply(toxFilter,
      Array(5).fill('Requirement already satisfied: pip in .tox/py312/lib').join('\n') + '\ncommands succeeded',
      ['tox'])
    expect(out).toContain("collapsed 5 'Requirement already satisfied' lines")
  })

  it('passes through raw stderr on non-zero exit (errorPassthrough=true)', () => {
    const out = apply(toxFilter, '', ['tox'], { stderr: 'CRITICAL: tox config error\n', exitCode: 1 })
    expect(out).toContain('CRITICAL: tox config error')
  })

  it('keeps tox env result summary lines', () => {
    const out = apply(toxFilter,
      'py312 OK (15.2s)\npy311 FAILED (12.1s)\n',
      ['tox'])
    expect(out).toContain('py312 OK')
    expect(out).toContain('py311 FAILED')
  })
})

// ---------------------------------------------------------------------------
// NoxFilter
// ---------------------------------------------------------------------------

describe('NoxFilter dispatch', () => {
  it('selectFilter routes nox', () => expect(selectFilter(['nox', '-s', 'lint'])).toBeInstanceOf(NoxFilter))
})

describe('NoxFilter compression', () => {
  it('collapses Creating virtual environment lines', () => {
    const out = apply(noxFilter,
      'nox > Creating virtual environment (virtualenv)\nSome test\n',
      ['nox'])
    expect(out).not.toContain('Creating virtual environment')
    expect(out).toContain('Some test')
  })

  it('collapses Re-using venv lines', () => {
    const out = apply(noxFilter,
      'nox > Re-using existing virtual environment\npytest\n',
      ['nox'])
    expect(out).not.toContain('Re-using existing')
    expect(out).toContain('pytest')
  })

  it('passes through stderr on non-zero exit', () => {
    const out = apply(noxFilter, '', ['nox'], { stderr: 'nox ERROR: Session lint failed\n', exitCode: 1 })
    expect(out).toContain('nox ERROR: Session lint failed')
  })
})

// ---------------------------------------------------------------------------
// WasmPackFilter
// ---------------------------------------------------------------------------

describe('WasmPackFilter dispatch', () => {
  it('selectFilter routes wasm-pack', () => expect(selectFilter(['wasm-pack', 'build'])).toBeInstanceOf(WasmPackFilter))
})

describe('WasmPackFilter compression', () => {
  it('drops [INFO] lines', () => {
    const out = apply(wasmPackFilter,
      '[INFO]: Checking for the Wasm target...\n[INFO]: Compiling to Wasm...\n',
      ['wasm-pack', 'build'])
    expect(out).not.toContain('[INFO]: Checking')
    expect(out).toContain('dropped 2 [INFO] step announcement lines')
  })

  it('keeps [WARN] lines', () => {
    const out = apply(wasmPackFilter,
      '[WARN]: License not found\n[INFO]: This is noise\n',
      ['wasm-pack', 'build'])
    expect(out).toContain('[WARN]: License not found')
  })

  it('keeps done / success message', () => {
    const out = apply(wasmPackFilter,
      '[INFO]: :-) Your wasm pkg is ready to publish at ./pkg.\n',
      ['wasm-pack', 'build'])
    // WASMPACK_DONE_RE uses search; the done message appears inside [INFO]:
    expect(out).toContain('Your wasm pkg is ready')
  })

  it('drops Cargo compiling lines', () => {
    const out = apply(wasmPackFilter,
      '   Compiling serde v1.0.0\n   Compiling wasm-bindgen v0.2.0\n   Finished release\n',
      ['wasm-pack', 'build'])
    expect(out).not.toContain('Compiling serde')
    expect(out).toContain('Finished release')
  })

  it('passes through stderr on non-zero exit', () => {
    const out = apply(wasmPackFilter, '', ['wasm-pack', 'build'], { stderr: 'error[E0425]: not found\n', exitCode: 1 })
    expect(out).toContain('error[E0425]: not found')
  })
})

// ---------------------------------------------------------------------------
// NgFilter
// ---------------------------------------------------------------------------

describe('NgFilter dispatch', () => {
  it('selectFilter routes ng', () => expect(selectFilter(['ng', 'build'])).toBeInstanceOf(NgFilter))
})

describe('NgFilter build compression', () => {
  it('drops build progress lines', () => {
    const out = apply(ngFilter,
      'Building...\n- Generating module index\nBuild at: 2024-01-01\n',
      ['ng', 'build'])
    expect(out).toContain('Build at: 2024-01-01')
    expect(out).not.toContain('Building...')
  })

  it('passes through stderr on non-zero exit', () => {
    const out = apply(ngFilter, '', ['ng', 'build'], { stderr: 'ERROR: Error building application\n', exitCode: 1 })
    expect(out).toContain('ERROR: Error building application')
  })
})

describe('NgFilter test compression', () => {
  it('drops Karma log noise, keeps test results', () => {
    const out = apply(ngFilter,
      '12 01 2024 10:00:00.000:INFO [karma] Karma v6 server started\n' +
      'Chrome 120.0.0.0 (Linux x86_64): Executed 5 of 10\n' +
      'TOTAL: 10 SUCCESS\n',
      ['ng', 'test'])
    expect(out).not.toContain('karma] Karma v6')
    expect(out).toContain('Executed 5 of 10')
    expect(out).toContain('TOTAL: 10 SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// DotenvFilter
// ---------------------------------------------------------------------------

describe('DotenvFilter dispatch', () => {
  it('selectFilter routes dotenv', () => expect(selectFilter(['dotenv', '-e', '.env', 'node', 'app.js'])).toBeInstanceOf(DotenvFilter))
})

describe('DotenvFilter compression', () => {
  it('collapses multiple banner lines to single summary', () => {
    const out = apply(dotenvFilter,
      'Loaded .env environment variables\nLoaded 5 vars from .env\nLoaded .env environment variables\nRunning app\n',
      ['dotenv'])
    expect(out).not.toMatch(/Loaded .* vars from .env\nLoaded .* vars from .env/)
    expect(out).toContain('Running app')
  })

  it('passthrough when fewer than 2 banner lines', () => {
    const text = 'Loaded 3 vars from .env\nSome output\n'
    const out = apply(dotenvFilter, text, ['dotenv'])
    expect(out).toContain('Loaded 3 vars from .env')
    expect(out).toContain('Some output')
  })

  it('collapses to a [dotenv] loaded N vars line when count is available', () => {
    const out = apply(dotenvFilter,
      'Exported 10 variables\nExported 5 variables\nDone\n',
      ['dotenv'])
    expect(out).toContain('[dotenv] loaded 15 vars')
    expect(out).toContain('Done')
  })
})

// ---------------------------------------------------------------------------
// EnvFilter
// ---------------------------------------------------------------------------

describe('EnvFilter dispatch', () => {
  it('selectFilter routes bare env (after prefix-strip fallback)', () => {
    // env alone is consumed by stripPrefixes; selectFilter falls back to argv[0]
    expect(selectFilter(['env'])).toBeInstanceOf(EnvFilter)
  })

  it('selectFilter routes printenv', () => {
    expect(selectFilter(['printenv'])).toBeInstanceOf(EnvFilter)
  })
})

describe('EnvFilter compression', () => {
  it('passes through when ≤20 env vars', () => {
    const vars = Array.from({ length: 10 }, (_, i) => `VAR_${i}=value${i}`).join('\n')
    const out = apply(envFilter, vars, ['env'])
    expect(out).toContain('VAR_0=value0')
  })

  it('suppresses low-priority vars when >20 total', () => {
    const important = 'PATH=/usr/bin\nHOME=/root\nSHELL=/bin/bash'
    const noise = Array.from({ length: 20 }, (_, i) => `OBSCURE_VAR_${i}=x`).join('\n')
    const out = apply(envFilter, `${important}\n${noise}`, ['env'])
    expect(out).toContain('PATH=/usr/bin')
    expect(out).toContain('HOME=/root')
    expect(out).not.toContain('OBSCURE_VAR_19=x')
    expect(out).toMatch(/\d+ env vars suppressed/)
  })

  it('keeps AWS_ prefixed vars', () => {
    const vars = Array.from({ length: 25 }, (_, i) => `RANDOM_${i}=x`).join('\n')
    const out = apply(envFilter, `AWS_ACCESS_KEY_ID=AKIA...\n${vars}`, ['env'])
    expect(out).toContain('AWS_ACCESS_KEY_ID')
  })
})

// ---------------------------------------------------------------------------
// JsonArrayFilter
// ---------------------------------------------------------------------------

describe('JsonArrayFilter dispatch', () => {
  it('matches json binary stem', () => {
    const f = new JsonArrayFilter()
    expect(f.matches(['json', '--filter', 'name'])).toBe(true)
  })

  it('detectFromCommand returns false (content-based only)', () => {
    const f = new JsonArrayFilter()
    expect(f.detectFromCommand('json')).toBe(false)
  })
})

describe('JsonArrayFilter compression', () => {
  it('passes through non-JSON-array output', () => {
    const out = apply(jsonArrayFilter, '{"key": "value"}', ['json'])
    expect(out).toContain('{"key": "value"}')
  })

  it('passes through output that is already short', () => {
    const arr = JSON.stringify([{ a: 1 }, { a: 2 }])
    const out = apply(jsonArrayFilter, arr, ['json'])
    expect(out).toContain('"a"')
  })

  it('truncates large arrays to 50 items when items are structurally distinct', () => {
    // Use structurally distinct objects (different key names per item) so dedup does not fire and truncation is the active reduction path.
    const arr = Array.from({ length: 60 }, (_, i) => ({ id: i, [`unique_${i}`]: true }))
    const out = apply(jsonArrayFilter, JSON.stringify(arr), ['json'])
    expect(out).toContain('10 more items not shown')
    // The kept JSON starts at the beginning; suffix lines follow
    const jsonPart = out.slice(0, out.lastIndexOf('\n[... '))
    const parsed = JSON.parse(jsonPart)
    expect(parsed).toHaveLength(50)
  })

  it('does NOT dedup distinct records that merely share the same fields (regression)', () => {
    // Same shape ({id, name}) but every value differs — a typical homogeneous API/DB list
    // response. None of these are duplicates; all must be preserved.
    const arr = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `item${i}` }))
    const out = apply(jsonArrayFilter, JSON.stringify(arr), ['json'])
    expect(out).not.toContain('duplicate objects')
    const parsed = JSON.parse(out.split('\n[')[0]!)
    expect(parsed).toHaveLength(10)
  })

  it('deduplicates objects with identical values', () => {
    const arr = Array.from({ length: 10 }, () => ({ id: 1, name: 'same' }))
    const out = apply(jsonArrayFilter, JSON.stringify(arr), ['json'])
    // All 10 are value-identical → first kept, 9 deduped
    expect(out).toContain('9 duplicate objects with keys {id, name}')
    const parsed = JSON.parse(out.split('\n[')[0]!)
    expect(parsed).toHaveLength(1)
  })

  it('preserves objects with high-entropy values (UUIDs, hashes)', () => {
    const arr = [
      { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'item1' },
      { id: 'b2c3d4e5-f6a7-8901-bcde-f01234567890', name: 'item2' },
    ]
    const out = apply(jsonArrayFilter, JSON.stringify(arr), ['json'])
    const parsed = JSON.parse(out.split('\n[')[0]!)
    expect(parsed).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// SeverityLogFilter
// ---------------------------------------------------------------------------

describe('SeverityLogFilter.detect', () => {
  it('detects log stream with ≥30% log-level lines', () => {
    const lines = [
      '2024-01-01 INFO Starting server',
      '2024-01-01 INFO Listening on :3000',
      '2024-01-01 WARN Rate limit exceeded',
      '2024-01-01 INFO Processing request',
      '2024-01-01 ERROR Unhandled exception',
    ].join('\n')
    expect(SeverityLogFilter.detect(lines)).toBe(true)
  })

  it('returns false for non-log output', () => {
    const lines = 'Hello world\nThis is a test\nFoo bar baz\nLine 4\nLine 5'
    expect(SeverityLogFilter.detect(lines)).toBe(false)
  })

  it('returns false for fewer than 5 lines', () => {
    const lines = 'INFO one\nINFO two'
    expect(SeverityLogFilter.detect(lines)).toBe(false)
  })
})

describe('SeverityLogFilter compression', () => {
  it('matches() always returns false', () => {
    expect(severityLogFilter.matches(['anything'])).toBe(false)
    expect(severityLogFilter.matches([])).toBe(false)
  })

  it('passes through non-log output', () => {
    const text = 'Hello\nWorld\nFoo\nBar\nBaz'
    const out = apply(severityLogFilter, text, [])
    expect(out).toContain('Hello')
  })

  it('suppresses DEBUG/INFO lines but keeps WARN/ERROR with context', () => {
    const lines = [
      '2024-01-01 DEBUG trace: a',
      '2024-01-01 DEBUG trace: b',
      '2024-01-01 INFO unimportant',
      '2024-01-01 WARN rate limit exceeded',
      '2024-01-01 DEBUG trace: c',
      '2024-01-01 DEBUG trace: d',
      '2024-01-01 INFO request complete',
      '2024-01-01 ERROR exception in handler',
      '2024-01-01 DEBUG trace: e',
    ].join('\n')
    const out = apply(severityLogFilter, lines, [])
    expect(out).toContain('WARN rate limit exceeded')
    expect(out).toContain('ERROR exception in handler')
    expect(out).toMatch(/suppressed/)
  })
})

// ---------------------------------------------------------------------------
// TailTruncFilter
// ---------------------------------------------------------------------------

describe('TailTruncFilter', () => {
  it('matches() returns false (content-based, not auto-dispatched by command name)', () => {
    // TailTruncFilter is applied explicitly (via filterByName) rather than auto-matched: the TS pre-bash hook rewrites commands before they execute, making a universal catch-all prohibitively expensive for trivial outputs (echo, ls, head, etc.).
    expect(tailTruncFilter.matches(['anything'])).toBe(false)
    expect(tailTruncFilter.matches([])).toBe(false)
  })

  it('passes through output with ≤500 lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = apply(tailTruncFilter, text, [])
    expect(out).toContain('line 0')
    expect(out).toContain('line 99')
  })

  it('truncates output >500 lines to first 50 + marker + last 50', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`)
    const out = apply(tailTruncFilter, lines.join('\n'), [])
    expect(out).toContain('line 0')
    expect(out).toContain('line 49')
    expect(out).toContain('500 lines suppressed')
    expect(out).toContain('line 550')
    expect(out).toContain('line 599')
    expect(out).not.toContain('line 50\n')
  })

  it('is truly the last filter in TOOL_FILTERS', () => {
    const lastFilter = TOOL_FILTERS[TOOL_FILTERS.length - 1]
    expect(lastFilter).toBeInstanceOf(TailTruncFilter)
  })
})
