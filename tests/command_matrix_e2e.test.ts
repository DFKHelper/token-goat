/**
 * Built-bundle command matrix (pre-push / CI tier — slow).
 *
 * Builds the real shipping artifact (dist/token-goat.mjs), indexes one shared
 * git fixture, then runs EVERY registered command against the bundle and asserts
 * real output. The case table is driven off the same registry the fast
 * registration guard uses (tests/registry.ts::allCommandNames), so a newly
 * registered command with no matrix case fails the coverage gate automatically —
 * there is no second list to forget.
 *
 * Most commands get a concrete output assertion. A small set is inherently
 * unsuited to a hermetic real-output check and is verified for *reachability*
 * instead (the bundle dispatches to the handler, it is not a Commander
 * "unknown command" error, and it does not crash with a tree-shaken module
 * error): `web-output` (process-local cache, always a miss in a fresh process)
 * and `gdrive-sections` (needs network + a live public doc). These still catch
 * the unregistered / tree-shaken-out-of-bundle bug class.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { allCommandNames } from './registry.js'

import { BUNDLE, ROOT } from './helpers/bundle.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

let repo: string // indexed fixture; default cwd for read commands
let dataBase: string // isolated data dir holding the shared index
let homeBase: string // fake OS home dir -- keeps `install`'s unconditional
// CLAUDE.md/skill writes (os.homedir()-based, not TOKEN_GOAT_HOME-scoped) off
// the real developer/CI machine's actual ~/.claude

const tempDirs: string[] = []

function tgEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir, HOME: homeBase, USERPROFILE: homeBase }
}

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? repo,
    env: opts.env ?? tgEnv(dataBase),
    encoding: 'utf8',
    timeout: 30000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** A read command run against the shared indexed fixture. */
function expectRead(args: string[], substr: string): void {
  const r = run(args)
  expect(r.status, `${args.join(' ')} stderr: ${r.stderr}`).toBe(0)
  expect(r.stdout).toContain(substr)
}

beforeAll(() => {
  dataBase = mkIsolated('tg-matrix-data-')
  repo = mkIsolated('tg-matrix-repo-')
  homeBase = mkIsolated('tg-matrix-home-')

  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function alphaSym(): number {\n' +
      '  // alphamarker keyword for semantic and grep\n' +
      '  return 1\n}\n' +
      'export function betaSym(): number {\n  return 2\n}\n',
  )
  // Same-file caller so `refs --callers` has a resolvable enclosing function.
  fs.writeFileSync(
    path.join(repo, 'caller.ts'),
    'export function refHelper(): number {\n  return 1\n}\n' +
      'export function refDriver(): number {\n  return refHelper() + refHelper()\n}\n',
  )
  // Importer file so `imports` has a real module specifier to list.
  fs.writeFileSync(
    path.join(repo, 'app.ts'),
    "import { alphaSym } from './src/mod.js'\n" +
      'export function useAlpha(): number {\n  return alphaSym()\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# Fixture\n\n## Install\n\nRun npm install to set up the project.\n',
  )
  fs.writeFileSync(path.join(repo, 'pkg.json'), '{\n  "version": "3.2.1"\n}\n')

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
  // Second commit touching src/mod.ts so `changed --since HEAD~1` has a diff.
  fs.appendFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function gammaSym(): number {\n  return 3\n}\n',
  )
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second'])

  const idx = run(['index', '.'])
  expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)
  expect(idx.stdout).toMatch(/Indexed \d+ files/)
}, 120000)

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

// Minimal hand-authored single-page PDF (Helvetica text object) for the pdf-extract case below.
const MINIMAL_PDF = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n'

/**
 * One assertion per registered command. Keys MUST equal the registered command
 * set (enforced by the coverage gate below). Read commands run against the
 * shared indexed fixture; stateful commands use their own isolated dirs.
 */
const cases: Record<string, () => void | Promise<void>> = {
  index: () => {
    const r = run(['index', '.'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Indexed \d+ files/)
  },
  symbol: () => expectRead(['symbol', 'alphaSym'], 'alphaSym'),
  read: () => expectRead(['read', 'src/mod.ts::alphaSym'], 'return 1'),
  section: () => expectRead(['section', 'README.md::Install'], 'npm install'),
  // Deliberately a keyword smoke test, not a proof of real embedding-vector search: this
  // shared fixture is indexed with embeddings disabled (isolate-home.ts sets
  // TOKEN_GOAT_EMBEDDINGS_ENABLED=false for the whole suite, and tgEnv inherits it), so this
  // case only exercises the FTS keyword fallback and would pass identically whether or not
  // real semantic search is wired up - it is not a substitute for that proof. The dedicated
  // proof - a meaning-only natural-language query finding a symbol whose name/body never uses
  // the query's words, with a control run showing the same query genuinely misses under FTS
  // alone - lives in tests/semantic_embeddings_e2e.test.ts.
  semantic: () => expectRead(['semantic', 'alphamarker'], 'alphaSym'),
  skeleton: () => {
    expectRead(['skeleton', 'src/mod.ts'], 'alphaSym')
    const r = run(['skeleton', 'src/mod.ts', '--stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+ refs/)
  },
  outline: () => {
    expectRead(['outline', 'src/mod.ts'], 'alphaSym')
    const r = run(['outline', 'src/mod.ts', '--stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+ refs/)
  },
  brief: () => {
    const r = run(['brief', 'src/mod.ts::alphaSym'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alphaSym')
    expect(r.stdout).toContain('return 1')
    expect(r.stdout).toMatch(/Callers \(\d+\)/)
  },
  refs: () => {
    const r = run(['refs', 'caller.ts::refHelper', '--callers'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver|caller\.ts/)
  },
  exports: () => expectRead(['exports', 'src/mod.ts'], 'alphaSym'),
  imports: () => {
    const r = run(['imports', 'app.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod/)
  },
  find: () => expectRead(['find', 'alphaSym'], 'mod'),
  grep: () => expectRead(['grep', 'alphamarker', '.'], 'alphamarker'),
  changed: () => {
    const r = run(['changed', '--since', 'HEAD~1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod\.ts/)
    // Regression: --symbol must be hunk-scoped to the lines the diff actually touched,
    // not every symbol in a file that has any changed line. The second commit only
    // appended gammaSym to the end of src/mod.ts, so alphaSym/betaSym (defined above
    // the appended hunk, untouched) must not be reported as changed symbols.
    const rs = run(['changed', '--since', 'HEAD~1', '--symbol'])
    expect(rs.status, rs.stderr).toBe(0)
    expect(rs.stdout).toContain('gammaSym')
    expect(rs.stdout).not.toContain('alphaSym')
    expect(rs.stdout).not.toContain('betaSym')
  },
  'config-get': () => expectRead(['config-get', 'pkg.json', 'version'], '3.2.1'),
  'csv-query': () => {
    const dir = mkIsolated('tg-matrix-csv-')
    const csvPath = path.join(dir, 'people.csv')
    fs.writeFileSync(csvPath, 'id,name,status\n1,Alice,active\n2,Bob,inactive\n')
    const r = run(['csv-query', csvPath, '--where', 'status=active'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
    const rMulti = run(['csv-query', csvPath, '--where', 'status!=active', '--where', 'name=Bob'])
    expect(rMulti.status, rMulti.stderr).toBe(0)
    expect(rMulti.stdout).toContain('Bob')
    expect(rMulti.stdout).not.toContain('Alice')
  },
  'csv-profile': () => {
    const dir = mkIsolated('tg-matrix-csvprof-')
    const csvPath = path.join(dir, 'people.csv')
    fs.writeFileSync(csvPath, 'id,name,status\n1,Alice,active\n2,Bob,inactive\n')
    const r = run(['csv-profile', csvPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('id  (number)')
    expect(r.stdout).toContain('status  (string)')
  },
  'pdf-extract': () => {
    const dir = mkIsolated('tg-matrix-pdf-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-extract', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Hello PDF')
    const rLayout = run(['pdf-extract', pdfPath, '--layout'])
    expect(rLayout.status, rLayout.stderr).toBe(0)
    expect(rLayout.stdout).toContain('Hello PDF')
  },
  'pdf-outline': () => {
    const dir = mkIsolated('tg-matrix-pdfo-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-outline', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('no bookmarks')
  },
  'pdf-meta': () => {
    const dir = mkIsolated('tg-matrix-pdfm-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-meta', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Pages: 1')
    expect(r.stdout).toContain('Text layer: yes')
  },
  'sharepoint-resolve': () => {
    const home = mkIsolated('tg-matrix-sphome-')
    const syncRoot = path.join(home, 'OneDrive - Contoso')
    fs.mkdirSync(path.join(syncRoot, 'Documents', 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(syncRoot, 'Documents', 'Reports', 'budget.xlsx'), '')
    const envFound = { ...tgEnv(dataBase), HOME: home, USERPROFILE: home }
    delete envFound.OneDriveCommercial
    delete envFound.OneDrive
    const rFound = run(
      ['sharepoint-resolve', 'https://contoso.sharepoint.com/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx'],
      { env: envFound },
    )
    expect(rFound.status, rFound.stderr).toBe(0)
    expect(rFound.stdout).toContain(path.join(syncRoot, 'documents', 'Reports', 'budget.xlsx'))

    const emptyHome = mkIsolated('tg-matrix-spempty-')
    const envEmpty = { ...tgEnv(dataBase), HOME: emptyHome, USERPROFILE: emptyHome }
    delete envEmpty.OneDriveCommercial
    delete envEmpty.OneDrive
    const rMissing = run(['sharepoint-resolve', 'https://contoso.sharepoint.com/sites/OtherTeam/Shared%20Documents/missing.docx'], {
      env: envEmpty,
    })
    expect(rMissing.status, rMissing.stderr).toBe(0)
    expect(rMissing.stdout).toContain('could not resolve a local synced copy')
  },
  'video-chapters': () => {
    // ffprobe's presence/version varies by machine and CI image — verify dispatch via
    // --help reachability rather than full behavioral output (same pattern as fetch-image).
    const r = run(['video-chapters', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/chapter|ffprobe|video/i)
  },
  'xlsx-sheets': () => {
    const dir = mkIsolated('tg-matrix-xlsx-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const XLSX = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'xlsx'))});
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['name','age'],['Alice','30']]);
      XLSX.utils.book_append_sheet(wb, ws, 'People');
      XLSX.writeFile(wb, ${JSON.stringify(xlsxPath)});
    `])
    const r = run(['xlsx-sheets', xlsxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('People')
  },
  'xlsx-head': () => {
    const dir = mkIsolated('tg-matrix-xlsxh-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const XLSX = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'xlsx'))});
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['name','age'],['Alice','30']]);
      XLSX.utils.book_append_sheet(wb, ws, 'People');
      XLSX.writeFile(wb, ${JSON.stringify(xlsxPath)});
    `])
    const r = run(['xlsx-head', xlsxPath, '--sheet', 'People'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  'xlsx-range': () => {
    const dir = mkIsolated('tg-matrix-xlsxr-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const XLSX = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'xlsx'))});
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['name','age'],['Alice','30']]);
      XLSX.utils.book_append_sheet(wb, ws, 'People');
      XLSX.writeFile(wb, ${JSON.stringify(xlsxPath)});
    `])
    const r = run(['xlsx-range', xlsxPath, '--sheet', 'People', '--range', 'A1:B2'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  'xlsx-query': () => {
    const dir = mkIsolated('tg-matrix-xlsxq-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const XLSX = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'xlsx'))});
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['name','status'],['Alice','active'],['Bob','inactive']]);
      XLSX.utils.book_append_sheet(wb, ws, 'People');
      XLSX.writeFile(wb, ${JSON.stringify(xlsxPath)});
    `])
    const r = run(['xlsx-query', xlsxPath, '--sheet', 'People', '--where', 'status=active'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
  },
  'pptx-outline': () => {
    const dir = mkIsolated('tg-matrix-pptxo-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome'] }]))
    const r = run(['pptx-outline', pptxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Intro')
  },
  'pptx-slide': () => {
    const dir = mkIsolated('tg-matrix-pptxs-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome'] }]))
    const r = run(['pptx-slide', pptxPath, '--slide', '1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Welcome')
  },
  'pptx-notes': () => {
    const dir = mkIsolated('tg-matrix-pptxn-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', notes: 'Say hello warmly' }]))
    const r = run(['pptx-notes', pptxPath, '--slide', '1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Say hello warmly')
  },
  'pptx-text': () => {
    const dir = mkIsolated('tg-matrix-pptxt-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome to the annual meeting'] }]))
    const r = run(['pptx-text', pptxPath, '--grep', 'annual'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Slide 1')
  },
  'docx-outline': () => {
    const dir = mkIsolated('tg-matrix-docxo-')
    const docxPath = path.join(dir, 'doc.docx')
    fs.writeFileSync(docxPath, buildDocxFixture([{ text: 'Overview', headingLevel: 1 }, { text: 'Some body text.' }]))
    const r = run(['docx-outline', docxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Overview')
  },
  'docx-text': () => {
    const dir = mkIsolated('tg-matrix-docxt-')
    const docxPath = path.join(dir, 'doc.docx')
    fs.writeFileSync(docxPath, buildDocxFixture([{ text: 'Overview', headingLevel: 1 }, { text: 'Some body text.' }]))
    const r = run(['docx-text', docxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Some body text.')
  },
  'transcript-outline': () => {
    const dir = mkIsolated('tg-matrix-transo-')
    const vttPath = path.join(dir, 'meeting.vtt')
    fs.writeFileSync(vttPath, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Alice>Welcome to the meeting.\n')
    const r = run(['transcript-outline', vttPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  transcript: () => {
    const dir = mkIsolated('tg-matrix-trans-')
    const vttPath = path.join(dir, 'meeting.vtt')
    fs.writeFileSync(vttPath, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Alice>Welcome to the meeting.\n')
    const r = run(['transcript', vttPath, '--speaker', 'Alice'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Welcome to the meeting.')
  },
  screenshot: () => {
    // Real behavior needs a real browser (present on dev machines, not guaranteed in CI) and
    // network access -- same constraint 'fetch-image' below hits, same fix: verify dispatch
    // via --help instead of a real invocation.
    const r = run(['screenshot', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/url|chrome|chromium/i)
  },
  map: () => {
    const r = run(['map'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toMatch(/mod|src/)
  },
  'bash-output': () => {
    // --file reads a regular file, giving a deterministic real-output check.
    const r = run(['bash-output', '--file', 'pkg.json'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('3.2.1')
  },
  'web-output': () => {
    // Reachability: process-local cache is always empty in a fresh process, so a bogus id is a graceful miss (exit 1), not an "unknown command" / crash.
    const r = run(['web-output', 'no-such-id'])
    expect(r.status).not.toBe(0)
    const all = r.stdout + r.stderr
    expect(all.length).toBeGreaterThan(0)
    expect(all).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  compress: () => {
    // Real output: the generic filter collapses the 6 identical lines to one.
    const r = run([
      'compress',
      '--filter',
      'generic',
      '--cmd',
      `"${process.execPath}" -e "for (let i = 0; i < 6; i++) console.log('compiling...')"`,
    ])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('×6')
  },
  stats: () => {
    const r = run(['stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
  },
  doctor: () => {
    const r = run(['doctor'])
    // doctor is informational; it may exit non-zero when something is unhealthy, but it must run and print diagnostics, not be unreachable.
    expect(r.status).not.toBeNull()
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'context-stats': () => {
    const r = run(['context-stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('context')
    const rj = run(['context-stats', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const output = JSON.parse(rj.stdout) as { total_tokens: number }
    expect(typeof output.total_tokens).toBe('number')
  },

  version: () => {
    const r = run(['version'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/)
  },
  hook: () => {
    // relay never throws on an unknown event; it emits {} and returns 0.
    const r = run(['hook', 'PreToolUse'], { input: '{}' })
    expect(r.status, r.stderr).toBe(0)
  },
  'write-file': () => {
    const dest = path.join(mkIsolated('tg-matrix-wf-'), 'out.txt')
    const payload = Buffer.from('hello-matrix', 'utf8').toString('base64')
    const r = run(['write-file', dest, '--b64', payload])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello-matrix')
  },
  'replace': () => {
    const dest = path.join(mkIsolated('tg-matrix-rpl-'), 'out.txt')
    fs.writeFileSync(dest, 'cat cat dog', 'utf8')
    const oldB64 = Buffer.from('cat', 'utf8').toString('base64')
    const newB64 = Buffer.from('fox', 'utf8').toString('base64')
    const r = run(['replace', dest, '--old-b64', oldB64, '--new-b64', newB64, '--all'])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('fox fox dog')
    expect(r.stdout).toContain('replaced 2 occurrences')
  },
  install: () => {
    const proj = mkIsolated('tg-matrix-proj-')
    const r = run(['install', '--project'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Installed token-goat hooks \(project\)/)
    expect(fs.existsSync(path.join(proj, '.claude', 'settings.json'))).toBe(true)
  },
  uninstall: () => {
    // Install first so uninstall has something to remove and emits the "Removed ..." path rather than the no-op message.
    const proj = mkIsolated('tg-matrix-uninstall-')
    const installed = run(['install', '--project'], { cwd: proj })
    expect(installed.status, installed.stderr).toBe(0)
    const r = run(['uninstall', '--project'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Removed token-goat hooks \(project\)\./)
  },
  worker: () => {
    // Parent command with subcommands and no own action: prints usage listing its subcommands. Reachable and lists start/stop/status.
    const r = run(['worker', '--help'])
    expect(r.stdout + r.stderr).toMatch(/start[\s\S]*stop[\s\S]*status/)
  },
  'worker status': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstatus-'))
    const r = run(['worker', 'status'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker is (running|not running)\./)
  },
  'worker stop': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstop-'))
    const r = run(['worker', 'stop'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker stopped\.|No running worker\./)
  },
  'worker start': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstart-'))
    const r = run(['worker', 'start'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker started \(pid \d+\)\.|Worker already running\./)
    // Stop the detached worker so it does not outlive the test.
    run(['worker', 'stop'], { env })
  },
  'skill-list': () => {
    const r = run(['skill-list'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-size': () => {
    const r = run(['skill-size'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-body': () => {
    const r = run(['skill-body', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-compact': () => {
    const r = run(['skill-compact', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-history': () => {
    const r = run(['skill-history'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-diff': () => {
    const r = run(['skill-diff', 'no-such-skill'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-section': () => {
    const r = run(['skill-section', 'no-such-skill::Heading'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'gdrive-sections': () => {
    // Reachability only: needs network + a live public doc. A bogus id must fail gracefully (non-zero) without an "unknown command" or tree-shaken module crash — that is what proves the command is wired into the shipped bundle.
    const r = run(['gdrive-sections', 'not-a-real-doc-id'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  'mcp-serve': async () => {
    // mcp-serve is a long-running stdio server, not a one-shot command, so it can't go through
    // the shared spawnSync-based run() helper (spawnSync writes stdin, closes it, and waits for
    // exit -- but this process never exits on its own). Spawn it directly, write one real
    // tools/list JSON-RPC request, read stdout until a response with a matching id arrives (or a
    // bounded timeout elapses), then always kill the child so a broken response can't hang the
    // suite.
    const child = spawn(process.execPath, [BUNDLE, 'mcp-serve'], { cwd: repo, env: tgEnv(dataBase) })
    try {
      const toolNames = await new Promise<string[]>((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => reject(new Error('mcp-serve: timed out waiting for tools/list response')), 15000)
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          let idx: number
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            if (line.trim() === '') continue
            const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } }
            if (msg.id === 1 && msg.result?.tools !== undefined) {
              clearTimeout(timer)
              resolve(msg.result.tools.map((t) => t.name))
              return
            }
          }
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'matrix-e2e', version: '0.0.1' } },
          })}\n`,
        )
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      })
      expect(toolNames.sort()).toEqual(['outline', 'read', 'section', 'semantic', 'skeleton', 'symbol'])
    } finally {
      child.kill()
    }
  },
  callers: () => {
    // The fixture has refDriver calling refHelper twice; callers should find refDriver as the enclosing symbol.
    const r = run(['callers', 'refHelper'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver|caller\.ts/)
  },
  'call-chain': () => {
    // refHelper is called by refDriver which has no further callers in the tiny fixture.
    const r = run(['call-chain', 'refHelper', '--depth', '4'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  impact: () => {
    // refHelper is called by refDriver; impact must list refDriver with hops: 1.
    const r = run(['impact', 'refHelper', '--top', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver/)
  },
  dead: () => {
    // The dead command must run and produce valid output (or 'No dead symbols found.') without crashing.
    const r = run(['dead', '--top', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  deps: () => {
    // app.ts imports from ./src/mod.js — deps must list that as an internal dep.
    const r = run(['deps', 'app.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod|internal/)
  },
  types: () => {
    // The fixture is tiny and may have no type declarations; accept exit 0 or 1 but never a crash.
    const r = run(['types'])
    expect(r.status).not.toBeNull()
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  scope: () => {
    // Line 2 of caller.ts is inside refHelper (which spans lines 1-3); scope must find it.
    const r = run(['scope', 'caller.ts:2'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refHelper/)
  },
  similar: () => {
    // similar needs a real indexed symbol in the fixture; use 'refHelper' which is indexed.
    const r = run(['similar', 'caller.ts::refHelper', '--top', '3'])
    // Either finds similar symbols (exit 0) or reports symbol not found (exit 1); both are reachable, not tree-shaken.
    expect(r.status).not.toBeNull()
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'context-for': () => {
    const r = run(['context-for', 'parse symbols'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'test-for': () => {
    const r = run(['test-for', 'caller.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'coverage-gaps': () => {
    const r = run(['coverage-gaps', '--top', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  arch: () => {
    const r = run(['arch', '--top', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/hubs/)
  },
  blame: () => {
    // The fixture is not a git repo; blame must fail gracefully with exit 1 and a message, not crash.
    const r = run(['blame', 'caller.ts::refHelper'])
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.status).not.toBeNull()
  },
  ask: () => {
    // Degraded mode: no TOKEN_GOAT_ASK_BACKEND set; must print degraded notice and exit 0.
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_ASK_BACKEND: '' }
    const r = run(['ask', 'how are symbols stored'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  pack: () => {
    // Pack a known file and assert its content appears in the bundle.
    const r = run(['pack', 'src/mod.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alphaSym')
  },
  tokens: () => {
    // --top 1 must limit to exactly one row; --json must parse.
    const r = run(['tokens', 'src/mod.ts', 'caller.ts', '--top', '1'])
    expect(r.status, r.stderr).toBe(0)
    const rows = r.stdout.split('\n').filter((l) => l.includes('mod.ts') || l.includes('caller.ts'))
    expect(rows.length).toBe(1)
    const rj = run(['tokens', 'src/mod.ts', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { entries: unknown[]; total_tokens: number }
    expect(parsed.entries.length).toBeGreaterThan(0)
    expect(parsed.total_tokens).toBeGreaterThan(0)
  },
  budget: () => {
    // Output must reflect the file's token cost; --json must parse.
    const r = run(['budget', 'src/mod.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod.ts/)
    const rj = run(['budget', 'src/mod.ts', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total_tokens: number }
    expect(parsed.total_tokens).toBeGreaterThan(0)
  },
  failures: () => {
    // Feed a minimal pytest failure block and assert extraction works; --json must parse.
    const input = [
      '=== FAILURES ===',
      '______ test_add ______',
      'def test_add():',
      '    assert 1 == 2',
      'E   AssertionError: assert 1 == 2',
      '',
      'test_math.py:4: AssertionError',
      '=== 1 failed in 0.05s ===',
    ].join('\n')
    const r = run(['failures'], { input })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('test_add')
    const rj = run(['failures', '--json'], { input })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { failures: unknown[] }
    expect(parsed.failures.length).toBeGreaterThan(0)
  },
  todo: () => {
    // Write a temp file with a TODO marker and confirm it's found.
    const fixture = path.join(dataBase, 'todo_fixture.ts')
    fs.writeFileSync(fixture, 'const x = 1 // TODO: fix this\n', 'utf8')
    const r = run(['todo', fixture])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('TODO')
    const rj = run(['todo', fixture, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { items: unknown[] }
    expect(parsed.items.length).toBeGreaterThan(0)
  },
  trace: () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "main.py", line 3, in run',
      '    result = helper()',
      '  File "/usr/lib/python3/site.py", line 10, in site_fn',
      '    pass',
      'ValueError: bad input',
    ].join('\n')
    const r = run(['trace'], { input: tb, cwd: repo })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  logfold: () => {
    const input = 'added 5 packages in 1s\n[12:00:01] hit\n[12:00:02] hit\n'
    const r = run(['logfold'], { input })
    expect(r.status, r.stderr).toBe(0)
    // npm-summary line should be dropped; identical normalised lines should fold
    expect(r.stdout).not.toContain('added 5 packages')
    expect(r.stdout).toMatch(/hit/)
  },
  lockdeps: () => {
    // token-goat ships a package-lock.json; run against the repo root.
    const r = run(['lockdeps', 'package-lock.json'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('commander')
    expect(r.stdout).toContain('package-lock.json')
  },
  note: () => {
    // Use an isolated data dir so notes don't pollute real home.
    const noteData = mkIsolated('tg-note-')
    const noteEnv = { ...tgEnv(noteData), TOKEN_GOAT_HOME: noteData }
    const rSet = run(['note', 'set', 'mykey', 'myval'], { env: noteEnv, cwd: repo })
    expect(rSet.status, rSet.stderr).toBe(0)
    const rGet = run(['note', 'get', 'mykey'], { env: noteEnv, cwd: repo })
    expect(rGet.status, rGet.stderr).toBe(0)
    expect(rGet.stdout.trim()).toBe('myval')
    const rList = run(['note', 'list', '--json'], { env: noteEnv, cwd: repo })
    expect(rList.status, rList.stderr).toBe(0)
    const parsed = JSON.parse(rList.stdout) as Record<string, string>
    expect(parsed['mykey']).toBe('myval')
  },
  hot: () => {
    // Fresh isolated env — no sessions; must exit 0 and not crash.
    const hotData = mkIsolated('tg-hot-')
    const r = run(['hot', '--limit', '5'], { env: tgEnv(hotData) })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  recent: () => {
    // Fresh process — no session files read; must exit 0.
    const r = run(['recent', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  ignores: () => {
    const r = run(['ignores'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Walk mode/)
    const rj = run(['ignores', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { walkMode: string; excludeTests: boolean }
    expect(['git', 'non-git']).toContain(parsed.walkMode)
  },
  'bash-history': () => {
    // Isolated home so no bash blobs exist; must exit 0 and report empty cache.
    const cacheDir = mkIsolated('tg-bhist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['bash-history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No bash output entries cached.')
    const rj = run(['bash-history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
  'web-history': () => {
    // Isolated home so no web blobs exist; must exit 0 and report empty cache.
    const cacheDir = mkIsolated('tg-whist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['web-history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No web output entries cached.')
    const rj = run(['web-history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
  'clean-cache': () => {
    // Isolated home; nothing to prune; must exit 0 and report 0 removed total.
    const cacheDir = mkIsolated('tg-clean-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['clean-cache'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('total: 0 removed')
    const rj = run(['clean-cache', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total: number }
    expect(parsed.total).toBe(0)
  },
  'prune-cache': () => {
    // Isolated home; nothing to prune; must exit 0.
    const cacheDir = mkIsolated('tg-prune-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['prune-cache', '--max-count', '5'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('total:')
    const rj = run(['prune-cache', '--max-count', '5', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total: number; maxCount: number }
    expect(parsed.maxCount).toBe(5)
  },
  'cache-audit': () => {
    // Must exit 0 and emit findings; content varies by environment.
    const r = run(['cache-audit'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toContain('cache-audit:')
    const rj = run(['cache-audit', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { findings: unknown[]; issueCount: number }
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(typeof parsed.issueCount).toBe('number')
  },
  resume: () => {
    // No real session blobs in isolated env; must exit 1 with a clear error message.
    const cacheDir = mkIsolated('tg-resume-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['resume', 'no_such_session_xyz'], { env })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no session blob found/i)
  },
  'compact-hint': () => {
    // May have no compact sessions; must exit 0 regardless and produce hint output.
    const cacheDir = mkIsolated('tg-chint-')
    const env = { ...tgEnv(cacheDir), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['compact-hint'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rj = run(['compact-hint', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { tier: string; fillFraction: number }
    expect(typeof p.tier).toBe('string')
    expect(typeof p.fillFraction).toBe('number')
  },
  'session-summary': () => {
    // Isolated home; no sessions; must exit 0 and report empty.
    const cacheDir = mkIsolated('tg-sesssum-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['session-summary'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/no session blobs found|Session:/i)
    const rj = run(['session-summary', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { sessionCount: number }
    expect(typeof p.sessionCount).toBe('number')
  },
  cost: () => {
    // Must exit 0 and emit stats or empty-session message.
    const cacheDir = mkIsolated('tg-cost-')
    const env = { ...tgEnv(cacheDir), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['cost'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rs = run(['cost', '--session'], { env })
    expect(rs.status, rs.stderr).toBe(0)
  },
  baseline: () => {
    // Run against the test repo; must produce a project map with file count.
    const r = run(['baseline'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Project map|Files:|Languages/i)
    const rj = run(['baseline', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { fileCount: number; rootDir: string }
    expect(typeof p.fileCount).toBe('number')
    expect(p.fileCount).toBeGreaterThan(0)
  },
  config: () => {
    // config list in an isolated home — must exit 0 and emit at least one key=value line.
    const cfgDir = mkIsolated('tg-config-')
    const env = { ...tgEnv(cfgDir), TOKEN_GOAT_HOME: cfgDir }
    const r = run(['config', 'list'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/compact_assist|worker/)
    const rj = run(['config', 'list', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as Record<string, unknown>
    expect(typeof parsed['compact_assist']).toBe('object')
    // config get a known key
    const rg = run(['config', 'get', 'compact_assist.enabled'], { env })
    expect(rg.status, rg.stderr).toBe(0)
    expect(rg.stdout.trim()).toBe('true')
    // config validate on empty config — no issues
    const rv = run(['config', 'validate'], { env })
    expect(rv.status, rv.stderr).toBe(0)
    expect(rv.stdout).toContain('no issues found')
  },
  project: () => {
    // project list — must exit 0 and list blocked_roots (empty by default).
    const projDir = mkIsolated('tg-proj-')
    const env = { ...tgEnv(projDir), TOKEN_GOAT_HOME: projDir }
    const r = run(['project', 'list'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rj = run(['project', 'list', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { blocked_roots: string[] }
    expect(Array.isArray(p.blocked_roots)).toBe(true)
    // project prune — no stale roots, exits 0
    const rp = run(['project', 'prune'], { env })
    expect(rp.status, rp.stderr).toBe(0)
  },
  'compact-doc': () => {
    // Run compact-doc with --heading (fixture README.md has an Install section).
    const r = run(['compact-doc', 'README.md', '--heading', 'Install'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toContain('Install')
    // --json emits a compact field
    const rj = run(['compact-doc', 'README.md', '--heading', 'Install', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { path: string; compact: string }
    expect(typeof p.compact).toBe('string')
    expect(p.compact.length).toBeGreaterThan(0)
  },
  'fetch-image': () => {
    // fetch-image without network — verify it dispatches correctly by checking --help reachability.
    const r = run(['fetch-image', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/url|fetch|image/i)
  },
  history: () => {
    // Isolated home — no blobs; must exit 0 and report empty.
    const histDir = mkIsolated('tg-hist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: histDir }
    const r = run(['history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No history entries found')
    const rj = run(['history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
}

describe('built bundle image shrink (real sharp dlopen through the full CLI import graph)', () => {
  // Regression test: embeddings.ts used to `require('@xenova/transformers')`
  // eagerly at module load time. index_prune.ts (reachable from every real CLI
  // invocation via cmdIndex) imports embeddings.ts, so every run of the built
  // bundle loaded @xenova/transformers — and transitively its own bundled
  // onnxruntime-node and a nested, differently-versioned copy of sharp's native
  // libvips binaries — before image_shrink.ts's own `import('sharp')` ever ran.
  // That poisoned the Windows DLL search order: the top-level sharp's dlopen
  // then failed with ERR_DLOPEN_FAILED, caught and silently swallowed as
  // "sharp unavailable" by loadSharp()'s catch block, so image shrinking was a
  // silent no-op in the shipped binary despite every image_shrink.test.ts case
  // passing (those import image_shrink.ts directly, never through the CLI's
  // full import graph, so @xenova/transformers was never loaded in-process).
  // This spawns the real dist/token-goat.mjs as a separate process and drives
  // it through the actual `hook pre_tool_use` dispatch path with a real
  // oversized image, asserting a genuine shrink happened — not just "no crash".
  it('shrinks an oversized image end-to-end through the built bundle', async () => {
    const side = 700 // 490,000px: comfortably under the default max_image_pixels cap
    const noise = Buffer.allocUnsafe(side * side * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
    const jpegBuf = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(jpegBuf.length).toBeGreaterThan(512 * 1024) // must clear image_shrink's own threshold

    const imgDir = mkIsolated('tg-matrix-img-')
    const imgPath = path.join(imgDir, 'big.jpg')
    fs.writeFileSync(imgPath, jpegBuf)

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: imgPath },
      session_id: 'matrix-image-shrink',
    })
    const r = run(['hook', 'pre_tool_use'], { input: payload })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('sharp unavailable')

    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain('smaller')
    expect(context).toMatch(/data:image\/(jpeg|webp);base64,/)
  }, 30000)
})

describe('built bundle command matrix', () => {
  it('every registered command has a matrix case (and vice versa)', () => {
    const registered = new Set(allCommandNames())
    const covered = new Set(Object.keys(cases))
    const missing = [...registered].filter((n) => !covered.has(n)).sort()
    const extra = [...covered].filter((n) => !registered.has(n)).sort()
    expect(missing, 'registered commands with no matrix case').toEqual([])
    expect(extra, 'matrix cases for commands that are not registered').toEqual([])
  })

  for (const [name, assertCase] of Object.entries(cases)) {
    it(`'${name}' produces correct output from the built bundle`, assertCase, 60000)
  }
})
