/** Structural guard for the "freshness gate keyed on one of two inputs" defect class. `reconcile.ts::reconcileProject`'s drift sweep used to compare only a file's content hash (`files.sha`) against a fresh disk read, and treat a match as "nothing to do" -- skipping the file entirely, forever, unless something later happened to edit it. That misses the case a parser fix or a new parser version creates: a file nobody touched afterward still holds symbol/reference rows written by the OLD extractor, recorded in `files.parser_sha`. Content and parser version are two independent freshness keys (see `fold_delivery.ts::resolveFoldSpans`'s own doc comment: "measured on a real index, 37 of 237 source files disagreed with what the current parser produced while their content sha still matched"), and a function that reads `files.sha` to decide whether to skip re-deriving a file's rows has to check both or it is wrong in exactly this shape. A per-site regression test (tests/reconcile_parser_stale.test.ts) pins reconcile.ts's own fix. It says nothing about the next bulk sweep someone writes that makes the same content-only mistake -- this repo's cmdIndex, worker.ts's dirty-drain, and fold_delivery.ts's fold-span resolver all read `files.sha` for the same kind of decision, and a new one is exactly as easy to get wrong as reconcile.ts's was. So this guard enumerates every top-level function in `src/` whose body calls `fingerprintFile(` (the disk-hash primitive every one of these checks uses) and requires an explicit classification: does it gate a skip/reuse decision on BOTH `files.sha` and `files.parser_sha`/`PARSER_FINGERPRINT`, does it only ever WRITE the current parser fingerprint (not gate a skip on it), or does it operate on one file the caller named explicitly rather than running a background bulk sweep that could silently skip a parser-stale file forever? An unclassified function is red. */
// This census also includes the byte-carrying fingerprintFileWithBytes helper used by the worker.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { parseTopLevelFunctions } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface Site {
  readonly file: string
  readonly name: string
}

interface FingerprintBindings {
  readonly functions: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

const FINGERPRINT_FUNCTION_NAMES = new Set(['fingerprintFile', 'fingerprintFileWithBytes'])

function callTargetName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text
  }
  return undefined
}

// limit: follows relative imports to fingerprint.ts and local aliases, not path aliases or re-export chains; revisit when src uses either.
function fingerprintBindingsForModule(src: string, filePath: string): FingerprintBindings {
  const source = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true)
  const functions = new Set(FINGERPRINT_FUNCTION_NAMES)
  const namespaces = new Set<string>()
  const fingerprintModulePath = path.resolve(SRC_DIR, 'fingerprint').toLowerCase()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const importedPath = path
      .resolve(path.dirname(filePath), specifier)
      .replace(/\.(?:[cm]?[jt]sx?)$/i, '')
      .toLowerCase()
    if (importedPath !== fingerprintModulePath) continue

    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text)
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const binding of namedBindings.elements) {
        const importedName = binding.propertyName?.text ?? binding.name.text
        if (FINGERPRINT_FUNCTION_NAMES.has(importedName)) functions.add(binding.name.text)
      }
    }
  }

  return { functions, namespaces }
}

function callsFileFingerprint(body: string, bindings: FingerprintBindings): boolean {
  const source = ts.createSourceFile('fingerprint-site.ts', body, ts.ScriptTarget.Latest, true)
  const functions = new Set(bindings.functions)
  const namespaces = new Set(bindings.namespaces)
  const isFingerprintReference = (expression: ts.Expression): boolean => {
    const name = callTargetName(expression)
    if (name !== undefined) return functions.has(name)
    return (
      ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text)
    )
  }
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isIdentifier(node.initializer) && namespaces.has(node.initializer.text)) {
        namespaces.add(node.name.text)
      } else if (isFingerprintReference(node.initializer)) {
        functions.add(node.name.text)
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (ts.isIdentifier(node.right) && namespaces.has(node.right.text)) {
        namespaces.add(node.left.text)
      } else if (isFingerprintReference(node.right)) {
        functions.add(node.left.text)
      }
    }

    if (ts.isCallExpression(node)) {
      if (isFingerprintReference(node.expression)) found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function sites(): readonly Site[] {
  const out: Site[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      const src = fs.readFileSync(p, 'utf8')
      const bindings = fingerprintBindingsForModule(src, p)
      for (const fn of parseTopLevelFunctions(src)) {
        if (callsFileFingerprint(fn.body, bindings)) {
          out.push({ file: path.relative(SRC_DIR, p).split(path.sep).join('/'), name: fn.name })
        }
      }
    }
  })(SRC_DIR)
  return out
}

type Bucket =
  /** Compares files.sha AND files.parser_sha/PARSER_FINGERPRINT before treating a row as reusable. */
  | 'gates-a-skip-decision-on-both-freshness-keys'
  /** Always stamps the CURRENT parser fingerprint on write; nothing here reuses an old row based on a sha match, so there is no skip decision to key on parser_sha in the first place. */
  | 'always-writes-current-parser-sha-does-not-gate-a-skip'
  /** Runs against one file the caller (or an explicit dirty-queue entry) already named, not a background bulk sweep that could silently skip a parser-stale file forever -- a parser upgrade affecting this file is caught by reconcile.ts's own sweep instead. */
  | 'explicit-single-file-path-not-a-bulk-skip-sweep'

interface Classification {
  readonly bucket: Bucket
  readonly reason: string
}

const CLASSIFICATION: ReadonlyMap<string, Classification> = new Map([
  [
    'reconcileProjectWith',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'reconcile.ts checks entry.parserSha !== PARSER_FINGERPRINT before the mtime/sha shortcut ' +
        'and counts it as parserStale -- this is the C1 fix; see tests/reconcile_parser_stale.test.ts.',
    },
  ],
  [
    'cmdIndex',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'cli.ts\'s bulk `token-goat index` walk compares fingerprintFile against the stored sha AND ' +
        'checks the parser fingerprint before skipping a file as already-current.',
    },
  ],
  [
    'resolveFoldSpans',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'fold_delivery.ts only reuses indexed spans when entry.sha matches AND entry.parserSha === ' +
        'PARSER_FINGERPRINT; a miss on either falls through to a fresh disk-based fold and enqueues ' +
        'a reindex. Its own doc comment cites the 37/237 measurement this guard generalizes.',
    },
  ],
  [
    'indexFreshness',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'read_commands.ts (the judgement behind staleWarning) checks one file the caller\'s spec already named against a fresh disk read ' +
        '-- detecting content drift for that one file, not scanning the whole project and silently ' +
        'skipping ones that look unchanged. A parser-stale-but-content-unchanged file here is caught ' +
        'by healStaleIndex, which the single-file commands run before it, and by reconcile.ts\'s sweep, not by this function.',
    },
  ],
  [
    'healStaleIndex',
    {
      bucket: 'gates-a-skip-decision-on-both-freshness-keys',
      reason:
        'staleWarning\'s companion self-heal skips the reparse only when the content sha AND entry.parserSha ' +
        'match: a project never run through `token-goat index` gets no session-start reconcile sweep, so this ' +
        'is the only place a file indexed on demand there is ever reparsed after a parser upgrade; see ' +
        'tests/read_commands_parser_stale_heal.test.ts.',
    },
  ],
  [
    'matchingFileEntry',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'index_freshness.ts matchingFileEntry (which indexMatchesDisk wraps as a boolean) holds the one copy of the four-line check its three hook-tier callers ' +
        'used to each carry inline -- detectStructuralIndexRewrite (bash_structural_index.ts), ' +
        'rangeSubstituteFor (bash_range_savings.ts) and hintTarget (hint_target.ts). ' +
        'Every one of them checks the single file an rg/sed/cat command already named, against a ' +
        'fresh disk read: the same single-named-file scope as staleWarning, built from getFileEntry ' +
        '+ fingerprintFile rather than by importing staleWarning itself, because read_commands.ts ' +
        'pulls the full parser/language-adapter graph into the eager bundle of the pre_tool_use hook ' +
        '(see tests/guards/dist_chunks_deduped.test.ts). None of the three skips or reuses anything: ' +
        'a stale file makes each decline to price, rewrite, or name, which suppresses a hint rather ' +
        'than serving stale rows. It gates on files.sha alone rather than parser_sha as well, ' +
        'deliberately: the names it clears are handed to `token-goat section`/`config-get`, which ' +
        'answer out of the same rows this read, so a parser-stale name is still a name that command ' +
        'resolves -- what it must never clear is a name the file on disk no longer contains. A ' +
        'parser-stale-but-content-unchanged file is caught by the sweep in reconcile.ts instead.',
    },
  ],
  [
    'indexedCopyIsStale',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'read_navigation_evidence.ts checks the one file a Read is about to load, and only when its mtime moved since ' +
        'indexing, to tell a checkout that rewrote the mtime from a real edit. Nothing is skipped or reused: a ' +
        'drifted file makes hints.first_read_symbol_policy stand aside rather than deny or warn. It keys on ' +
        'files.sha alone because the names it suggests go to `token-goat read`/`section`, which heal a ' +
        'parser-stale row before answering, the same reasoning as indexMatchesDisk above. It cannot call ' +
        'indexMatchesDisk itself: index_freshness.ts imports index_reader.ts.',
    },
  ],
  [
    'fingerprintFile',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'fingerprint.ts retains the sha-only API as a one-path wrapper over fingerprintFileWithBytes; ' +
        'it returns a hash without a database read or a freshness skip decision.',
    },
  ],
  [
    'processDirtyBatch',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'worker.ts drains an explicit dirty-queue entry list -- every path here was already queued ' +
        'for reindexing by something else, so there is no "looks unchanged, skip it forever" ' +
        'decision being made; fingerprintFileWithBytes here carries the content hash for the queued ' +
        'path, not a parser-freshness gate.',
    },
  ],
  [
    'postBashHandler',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason:
        'hooks_bash_post.ts re-fingerprints the one file named by the completed section command to ' +
        'validate its one-use receipt; it does not skip or reuse a bulk index candidate.',
    },
  ],
  [
    'onceCurrentFileHash',
    {
      bucket: 'explicit-single-file-path-not-a-bulk-skip-sweep',
      reason: 'session.ts hashes the one file a ranged Read names, once per hook call, for the range record and the ranged re-read check; session state, no index row, no parser_sha, no skip sweep.',
    },
  ],
])

describe('every bulk-vs-single freshness check on file fingerprint APIs is classified for parser_sha (freshness-gate defect class)', () => {
  it('recognizes both fingerprint APIs and ignores comments, strings and longer-name near misses', () => {
    const found = parseTopLevelFunctions(`
function shaOnly() { fingerprintFile(path) }
function withBytes() { fingerprintFileWithBytes(path) }
function memberBytes() { api.fingerprintFileWithBytes(path) }
function computedBytes() { api['fingerprintFileWithBytes'](path) }
function spreadBytes() { fingerprintFileWithBytes(...paths) }
function aliasedBytes() {
  const first = fingerprintFileWithBytes
  const second = first
  return second(path)
}
function commentOnly() { /* fingerprintFileWithBytes(path) */ }
function stringOnly() { const note = "fingerprintFileWithBytes(path)" }
function shaNearMiss() { fingerprintFileExtra(path) }
function bytesNearMiss() { fingerprintFileWithBytesExtra(path) }
function unrelatedStaticMember() { api['lookup'](path) }
`)
      .filter((fn) =>
        callsFileFingerprint(fn.body, {
          functions: FINGERPRINT_FUNCTION_NAMES,
          namespaces: new Set<string>(),
        }),
      )
      .map((fn) => fn.name)
    expect(found).toEqual(['shaOnly', 'withBytes', 'memberBytes', 'computedBytes', 'spreadBytes', 'aliasedBytes'])
  })

  it('fails closed on op-keyed calls through the imported fingerprint namespace', () => {
    const src = `
import * as fingerprint from './fingerprint.js'
import { fingerprintFileWithBytes as hashBytes } from './fingerprint.js'
function opKeyed() { fingerprint[operation](path) }
function namespaceAlias() {
  const localFingerprint = fingerprint
  return localFingerprint[operation](path)
}
function computedAlias() {
  const selected = fingerprint[operation]
  return selected(path)
}
function namedImportAlias() { return hashBytes(path) }
function unrelatedComputedCall() { values[Symbol.iterator]() }
`
    const bindings = fingerprintBindingsForModule(src, path.join(SRC_DIR, 'guard-fixture.ts'))
    const found = parseTopLevelFunctions(src)
      .filter((fn) => callsFileFingerprint(fn.body, bindings))
      .map((fn) => fn.name)

    expect(found).toEqual(['opKeyed', 'namespaceAlias', 'computedAlias', 'namedImportAlias'])
  })

  it('scans a real, non-empty population', () => {
    const found = sites().map((s) => s.name)
    pinnedPopulation({
      what: 'top-level functions in src/**/*.ts that call fingerprintFile() or fingerprintFileWithBytes()',
      items: found,
      floor: 6,
      mustInclude: ['reconcileProjectWith', 'fingerprintFile', 'processDirtyBatch', 'postBashHandler'],
    })
  })

  it('every discovered site is classified', () => {
    const unclassified = sites().filter((s) => !CLASSIFICATION.has(s.name))
    expect(
      unclassified.map((s) => `${s.file}::${s.name}`),
      'These functions call a file fingerprint helper but carry no entry in CLASSIFICATION. Decide whether ' +
        'they gate a skip/reuse decision on BOTH files.sha and files.parser_sha, only ever write the ' +
        'current parser fingerprint, or run against one explicitly-named file rather than a bulk ' +
        'sweep -- and classify them here, or fix them if a bulk sweep is keying on content alone.',
    ).toEqual([])
  })

  it('every classification is still a real function in src', () => {
    const found = new Set(sites().map((s) => s.name))
    const stale = [...CLASSIFICATION.keys()].filter((n) => !found.has(n))
    expect(stale, 'these names are classified but the scan no longer finds them').toEqual([])
  })

  it('every gates-a-skip-decision function actually references parser_sha/PARSER_FINGERPRINT', () => {
    const byName = new Map<string, Site>()
    for (const s of sites()) byName.set(s.name, s)
    for (const [name, c] of CLASSIFICATION) {
      if (c.bucket !== 'gates-a-skip-decision-on-both-freshness-keys') continue
      const site = byName.get(name)
      expect(site, `${name} was classified but not found by the scan`).toBeDefined()
      const abs = path.join(SRC_DIR, site!.file)
      const src = fs.readFileSync(abs, 'utf8')
      const fn = parseTopLevelFunctions(src).find((f) => f.name === name)
      expect(fn, `could not re-locate ${name} in ${site!.file}`).toBeDefined()
      expect(
        /parserSha|parser_sha|PARSER_FINGERPRINT/.test(fn!.body),
        `${name} is classified as gating on parser_sha but its body no longer mentions ` +
          'parserSha/parser_sha/PARSER_FINGERPRINT at all -- the classification is stale.',
      ).toBe(true)
    }
  })
})
