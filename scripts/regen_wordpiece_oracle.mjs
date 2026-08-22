/**
 * Regenerates the frozen WordPiece oracle that tests/embed_tokenizer_oracle.test.ts checks
 * src/embed_tokenizer.ts against.
 *
 *   node scripts/regen_wordpiece_oracle.mjs
 *
 * The oracle is produced by @xenova/transformers -- a genuinely separate implementation of the same
 * tokenizer, kept as a devDependency for exactly this -- so the test compares against something
 * other than our own code under a mock. It writes two files:
 *
 *   tests/fixtures/wordpiece/tokenizer.json.gz  the pinned model's own tokenizer.json
 *   tests/fixtures/wordpiece/oracle.json.gz     {text, ids} for every case in CORPUS below
 *
 * Both are gzipped because the vocabulary is 711 KB of JSON, and are read back with node:zlib so
 * the test needs no network, no model download and no optional dependency -- it runs everywhere CI
 * runs, with nothing to skip.
 *
 * The corpus is written out here rather than sampled from the repo so that regenerating it changes
 * the ids and never the inputs: a case that once discriminated cannot quietly stop being tested.
 * Every entry is here because it separates a plausible implementation from the correct one.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { AutoTokenizer, env } from '@xenova/transformers'

const MODEL = 'Xenova/bge-small-en-v1.5'
const REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'
const MAX_LENGTH = 512

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'tests', 'fixtures', 'wordpiece')

/** A word long enough to trip max_input_chars_per_word, and one a single character below it. */
const OVER_LONG_WORD = 'a'.repeat(101)
const AT_LIMIT_WORD = 'b'.repeat(100)

const CORPUS = [
  // --- prototype-chain words. A plain-object vocab answers these from Object.prototype.
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'prototype',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'obj.constructor.prototype.toString.call(x)',
  'the constructor of a class has a prototype whose toString we never call',

  // --- Unicode category S is NOT punctuation to the reference: these stay whole words.
  '\u2500\u2500\u2500',
  '\u2550\u2550\u2550 section \u2550\u2550\u2550',
  '\u25b2\u25bc',
  '\u2192 \u2190 \u21d2',
  '\u00b1\u00d7\u00f7',
  '$100 \u20ac50 \u00a375 \u00a5900',
  '\u00a9 \u00ae \u2122',
  '90\u00b0 north',
  '\u00a7 12 \u00b6 3',
  'a+b=c<d>e|f~g^h`i',

  // --- emoji, including a zero-width-joiner sequence and a flag
  '\ud83d\ude80\ud83d\udd25',
  'ship it \ud83d\ude80',
  '\ud83d\udc4d\ud83c\udffd',
  '\ud83d\udc69\u200d\ud83d\udcbb',
  '\ud83c\uddec\ud83c\udde7',

  // --- CJK, which is padded per character, and CJK glued to latin with no space
  '\u4e2d\u6587\u6d4b\u8bd5',
  '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8',
  '\ud55c\uad6d\uc5b4',
  'code\u4e2d\u6587code',
  '\u4e00\u3002\u4e8c',

  // --- accents and case folding, including forms where NFD and lowercase interact
  'caf\u00e9',
  'na\u00efve r\u00e9sum\u00e9',
  '\u00c5ngstr\u00f6m',
  'cafe\u0301',
  '\u0130stanbul',
  'stra\u00dfe',
  '\u0141\u00f3d\u017a',
  'MiXeD CaSe WoRd',

  // --- characters the normalizer drops outright
  'a\u0000b',
  'a\ufffdb',
  'a\u200bb',
  'a\u00adb',
  'a\u0007b',
  'a\tb\nc\rd',
  'a\u00a0b',
  'a\u3000b',
  'a\u2028b\u2029c',
  '   leading and trailing   ',
  '',
  ' ',
  '\n\n\n',

  // --- word-length boundary
  OVER_LONG_WORD,
  AT_LIMIT_WORD,
  `${OVER_LONG_WORD} tail`,

  // --- punctuation runs and identifier shapes
  '!!!',
  '...',
  '--',
  'a.b.c',
  'foo_bar-baz',
  'snake_case camelCase PascalCase SCREAMING_SNAKE',
  "don't can't it's",
  '"quoted" and (parenthesised) and [bracketed] and {braced}',

  // --- real code, which is what this is actually pointed at
  'const { alpha = fallbackValue } = load()',
  "db.prepare('SELECT * FROM chunks WHERE file_path = ?')",
  '#!/usr/bin/env node',
  'https://example.com/a/b?c=d&e=f#frag',
  'a === b && c !== d',
  'x?.y ?? z',
  '<div class="foo" data-id={id} />',
  '/* a block comment */ // a line comment',
  '#[derive(Debug, Clone)]',
  'export function resolveCredential(id: string, scope: string): string {',
  'SELECT COUNT(*) c FROM chunk_vectors WHERE rowid = ?',
  'git rev-parse HEAD~1',
  '0x1f 1e-9 3.14159 1_000_000',
  'C:\\Users\\zelys\\AppData\\Local\\Temp',
  '/usr/local/lib/node_modules/token-goat',
  'e2e i18n a11y k8s',

  // --- subwords the greedy longest-match has to split
  'tokenization',
  'unbelievability',
  'antidisestablishmentarianism',
  'zzzqqqxxx',
  'preprocessing postprocessing',

  // --- unknowns and rare categories
  '\u2167',
  '\u2460\u2461',
  '\ufb01ne',
  '\u0623\u0647\u0644\u0627\u064b',
  '\u05e9\u05dc\u05d5\u05dd',

  // --- long enough to be truncated, in a shape where the cut lands mid-word
  `${'tokenization of a long document '.repeat(200)}FINALWORD`,
  'lorem ipsum dolor sit amet '.repeat(80),
]

async function main() {
  env.allowRemoteModels = true
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION })

  const records = CORPUS.map((text) => {
    const encoded = tokenizer(text, { truncation: true, max_length: MAX_LENGTH, add_special_tokens: true })
    const ids = Array.from(encoded.input_ids.data, (v) => Number(v))
    return { text, ids }
  })

  const duplicates = records.map((r) => r.text).filter((t, i, all) => all.indexOf(t) !== i)
  if (duplicates.length > 0) throw new Error(`duplicate corpus entries: ${JSON.stringify(duplicates)}`)

  const cached = path.join(
    repoRoot,
    'node_modules',
    '@xenova',
    'transformers',
    '.cache',
    ...MODEL.split('/'),
    REVISION,
    'tokenizer.json',
  )
  const spec = fs.readFileSync(cached)

  fs.mkdirSync(outDir, { recursive: true })
  const gzip = (buf) => zlib.gzipSync(buf, { level: 9 })
  fs.writeFileSync(path.join(outDir, 'tokenizer.json.gz'), gzip(spec))
  fs.writeFileSync(
    path.join(outDir, 'oracle.json.gz'),
    gzip(
      Buffer.from(
        `${JSON.stringify({ model: MODEL, revision: REVISION, maxLength: MAX_LENGTH, generatedBy: `@xenova/transformers@${env.version}`, records }, null, 1)}\n`,
        'utf8',
      ),
    ),
  )

  const tokens = records.reduce((sum, r) => sum + r.ids.length, 0)
  console.log(`wrote ${records.length} records (${tokens} tokens) and a ${spec.length}-byte vocabulary to ${outDir}`)
}

await main()
