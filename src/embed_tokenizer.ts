/**
 * A BERT WordPiece tokenizer for exactly the spec `bge-small-en-v1.5`'s `tokenizer.json` declares:
 * BertNormalizer(clean_text, handle_chinese_chars, strip_accents=null, lowercase=true),
 * BertPreTokenizer, WordPiece('##', [UNK], 100), TemplateProcessing([CLS] A [SEP]).
 *
 * It refuses any other spec rather than tokenizing it a bit differently. A tokenizer that silently
 * mishandles a shape it does not implement produces vectors that are wrong by a little, which is
 * invisible right up until an index has been half-built with each -- the same failure the
 * embedding_provenance stamp exists to catch one level up, arriving through a door provenance
 * cannot see, because the model and runtime would both be unchanged.
 *
 * Correctness here is not judged by reading it. Every rule below matches the reference
 * implementation on a frozen corpus of its known-awkward inputs; see
 * tests/embed_tokenizer_oracle.test.ts and scripts/regen_wordpiece_oracle.mjs.
 */

/** The sequence length the model was exported with, [CLS] and [SEP] included. */
export const MAX_SEQUENCE_TOKENS = 512

/** A tokenizer.json this implementation refuses, naming the field that made it refuse. */
export class UnsupportedTokenizerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedTokenizerError'
  }
}

function fail(message: string): never {
  throw new UnsupportedTokenizerError(message)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${path} is not an object`)
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} is not a string`)
  return value
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} is not an array`)
  return value
}

function expectValue(actual: unknown, wanted: unknown, path: string): void {
  if (actual !== wanted) fail(`${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
}

/**
 * A codepoint the reference BasicTokenizer treats as CJK and pads with a space on each side, so
 * every such character becomes its own word. The ranges are the reference's, not Unicode's own
 * Han blocks -- they deliberately leave out the compatibility forms it does not pad.
 */
function isChinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

/**
 * The reference `_is_punctuation` exactly: the four ASCII ranges that are punctuation to it but not
 * to Unicode, then category P -- and deliberately NOT category S. Symbols do not separate words
 * there, so `---` (box drawing) is one word tokenized as three pieces and a run of emoji is one
 * unknown word producing a single [UNK]. Adding \p{S} here splits both, and was the only tokenizer
 * defect the differential run against the reference found.
 */
const PUNCTUATION = /\p{P}/u
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }
  return PUNCTUATION.test(ch)
}

const CONTROL = /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u
function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false
  return CONTROL.test(ch)
}

const SPACE_SEPARATOR = /\p{Zs}/u
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || SPACE_SEPARATOR.test(ch)
}

/**
 * The combining marks accent stripping removes. This is the Latin block alone, deliberately, and
 * not category Mn: the reference implementation this has to agree with strips exactly this range,
 * so a mark outside it -- Arabic tanween, Hebrew niqqud, Devanagari matras -- survives
 * normalization and usually makes its word unknown. The canonical Rust tokenizer strips every Mn
 * instead, which would tokenize those scripts differently. Agreeing with the implementation whose
 * vectors are already in people's indexes is worth more than agreeing with one this cannot run, and
 * the two only ever differ outside Latin, which is outside an English model's competence anyway.
 * The oracle pins both halves of that: an Arabic case and a Latin one.
 */
const COMBINING_MARK = /[\u0300-\u036f]/gu

/** BertNormalizer: drop control characters, fold whitespace, pad CJK, strip accents, lowercase. */
function normalize(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue
    if (isWhitespace(ch)) {
      out += ' '
      continue
    }
    if (isChinese(cp)) {
      out += ` ${ch} `
      continue
    }
    out += ch
  }
  // strip_accents is null, which in the reference means "follow lowercase", and lowercase is on:
  // decompose, drop the combining marks, then fold case.
  return out.normalize('NFD').replace(COMBINING_MARK, '').toLowerCase()
}

/** BertPreTokenizer: split on whitespace, then peel every punctuation character off as its own word. */
function preTokenize(text: string): string[] {
  const words: string[] = []
  for (const piece of text.split(/\s+/)) {
    if (!piece) continue
    let buf = ''
    for (const ch of piece) {
      if (isPunctuation(ch)) {
        if (buf) {
          words.push(buf)
          buf = ''
        }
        words.push(ch)
      } else {
        buf += ch
      }
    }
    if (buf) words.push(buf)
  }
  return words
}

/** Everything this implementation needs out of a tokenizer.json, validated on the way in. */
interface WordPieceSpec {
  vocab: Map<string, number>
  unkToken: string
  maxInputCharsPerWord: number
}

function readSpec(raw: unknown): WordPieceSpec {
  const spec = asRecord(raw, 'tokenizer.json')

  const normalizer = asRecord(spec['normalizer'], 'normalizer')
  expectValue(normalizer['type'], 'BertNormalizer', 'normalizer.type')
  expectValue(normalizer['clean_text'], true, 'normalizer.clean_text')
  expectValue(normalizer['handle_chinese_chars'], true, 'normalizer.handle_chinese_chars')
  expectValue(normalizer['lowercase'], true, 'normalizer.lowercase')
  // null means "follow lowercase", which is on, so null and true are the same thing here.
  const stripAccents = normalizer['strip_accents']
  if (stripAccents !== null && stripAccents !== true) {
    fail(`normalizer.strip_accents is ${JSON.stringify(stripAccents)}, expected null or true`)
  }

  expectValue(asRecord(spec['pre_tokenizer'], 'pre_tokenizer')['type'], 'BertPreTokenizer', 'pre_tokenizer.type')

  const model = asRecord(spec['model'], 'model')
  expectValue(model['type'], 'WordPiece', 'model.type')
  expectValue(model['continuing_subword_prefix'], '##', 'model.continuing_subword_prefix')

  const post = asRecord(spec['post_processor'], 'post_processor')
  expectValue(post['type'], 'TemplateProcessing', 'post_processor.type')
  const template = asArray(post['single'], 'post_processor.single')
    .map((part) => {
      const special = asRecord(part, 'post_processor.single[]')['SpecialToken']
      return special === undefined ? 'A' : asString(asRecord(special, 'SpecialToken')['id'], 'SpecialToken.id')
    })
    .join(' ')
  if (template !== '[CLS] A [SEP]') fail(`post_processor.single is "${template}", expected "[CLS] A [SEP]"`)

  // A Map, not the parsed object. `vocab['constructor']` on a plain object walks the prototype
  // chain and answers with Object.prototype.constructor, which is not undefined -- so the lookup
  // "succeeds" and a function lands where a token id belongs. The same goes for toString, valueOf,
  // hasOwnProperty and __proto__, every one of them an ordinary word in source code, which is what
  // this is pointed at. The differential run caught it on the word "constructor".
  const vocab = new Map<string, number>()
  for (const [token, id] of Object.entries(asRecord(model['vocab'], 'model.vocab'))) {
    if (typeof id !== 'number' || !Number.isInteger(id)) fail(`model.vocab["${token}"] is not an integer id`)
    vocab.set(token, id)
  }

  const maxChars = model['max_input_chars_per_word']
  if (maxChars !== undefined && (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1)) {
    fail('model.max_input_chars_per_word is not a positive integer')
  }

  return {
    vocab,
    unkToken: asString(model['unk_token'], 'model.unk_token'),
    maxInputCharsPerWord: typeof maxChars === 'number' ? maxChars : 100,
  }
}

export class BertWordPiece {
  private readonly vocab: Map<string, number>
  private readonly maxInputCharsPerWord: number
  readonly clsId: number
  readonly sepId: number
  readonly padId: number
  readonly unkId: number

  /** @param raw the parsed contents of a tokenizer.json. */
  constructor(raw: unknown) {
    const spec = readSpec(raw)
    this.vocab = spec.vocab
    this.maxInputCharsPerWord = spec.maxInputCharsPerWord
    this.clsId = this.requireToken('[CLS]')
    this.sepId = this.requireToken('[SEP]')
    this.padId = this.requireToken('[PAD]')
    this.unkId = this.requireToken(spec.unkToken)
  }

  /** Parse and validate in one step, for the common case of reading the file off disk. */
  static fromJson(json: string): BertWordPiece {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new UnsupportedTokenizerError(`tokenizer.json is not valid JSON: ${(err as Error).message}`)
    }
    return new BertWordPiece(parsed)
  }

  private requireToken(token: string): number {
    const id = this.vocab.get(token)
    if (id === undefined) fail(`model.vocab is missing the ${token} token`)
    return id
  }

  /** Greedy longest-match-first over one whitespace- and punctuation-free word. */
  private wordToIds(word: string, into: number[]): void {
    if (word.length > this.maxInputCharsPerWord) {
      into.push(this.unkId)
      return
    }
    const pieces: number[] = []
    let start = 0
    while (start < word.length) {
      let end = word.length
      let found = -1
      while (start < end) {
        const sub = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`
        const id = this.vocab.get(sub)
        if (id !== undefined) {
          found = id
          break
        }
        end--
      }
      // One unmatchable piece makes the whole word unknown, rather than a partly-tokenized word.
      if (found === -1) {
        into.push(this.unkId)
        return
      }
      pieces.push(found)
      start = end
    }
    for (const id of pieces) into.push(id)
  }

  /**
   * `[CLS] ... [SEP]`, cut to `maxLength` tokens.
   *
   * The cut is taken after the markers are added, not before, which means a sequence long enough to
   * be truncated ends on an ordinary token and has no [SEP] at all. That is what the reference does
   * and therefore what the model has been fed all along, so it is deliberate rather than an
   * oversight: keeping the [SEP] would be the more defensible sequence and a different one, and a
   * tokenizer whose whole justification is producing identical ids does not get to improve on them.
   * The oracle carries two cases that reach the limit; both end mid-text.
   */
  encode(text: string, maxLength: number = MAX_SEQUENCE_TOKENS): number[] {
    if (!Number.isInteger(maxLength) || maxLength < 2) {
      throw new RangeError(`maxLength must be an integer >= 2 (both markers), got ${maxLength}`)
    }
    const ids: number[] = [this.clsId]
    for (const word of preTokenize(normalize(text))) {
      this.wordToIds(word, ids)
      // One more word cannot bring anything back under the limit, so stop reading the text.
      if (ids.length >= maxLength) return ids.slice(0, maxLength)
    }
    ids.push(this.sepId)
    return ids.length > maxLength ? ids.slice(0, maxLength) : ids
  }
}
