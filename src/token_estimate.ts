/** Bytes-to-tokens estimation, by content class. Every other estimate in this repository prices a byte flat, and a byte is not a fixed number of tokens. Measured with tiktoken (cl100k_base and o200k_base) over 120 real files in this repository, natural source text runs 3.83-4.22 bytes per token while a base64url payload runs 1.41-1.49 -- a 2.8x spread that decides whether a credited saving is honest and whether a buffer guard fires before or after the context it was protecting is already gone. Two divisors, deliberately not one. A credit prices bytes at their measured rate; a guard prices them at {@link GUARD_MARGIN} of that rate, so it guesses high on purpose. That relationship is what `tests/saved_tokens_use_one_divisor.test.ts` pins, and 0.75 is chosen so the text class reproduces the two numbers this repository has always used -- 4.0 for a credit, 3.0 for a guard -- exactly. Nothing is re-priced by this module's arrival; it only makes a second class expressible. The classifier is precise rather than eager. A payload it does not recognise is priced as text, which is what happens today, so a miss costs nothing that was not already being lost; a false positive would over-credit a saving, which is the direction this project has had to undo before. */

/** How a run of bytes tokenizes. `dense` is base64, base64url, hex and the like: a high-entropy alphabet with no word boundaries for the tokenizer to merge on. `text` is everything else -- source, prose, logs, JSON with real keys in it. `wide` is Han (Chinese), Hiragana, Katakana (Japanese) or Hangul (Korean): three UTF-8 bytes and one UTF-16 unit per character, so a guard that divides a string length by three prices it at 0.33 tokens per character. The OpenAI tokenizers (tiktoken cl100k_base and o200k_base; Claude's tokenizer was not measured) ran 0.78-1.04 and 0.51-0.74 tokens per character over three Japanese, Chinese and Korean technical prose samples, and 0.76-1.56 and 0.51-1.28 over eight CPython cjkencodings files (tests/fixtures/token_estimate/wide_rate_cpython_cjk.tsv, from scripts/measure-wide-token-rate.py). A credit prices the class at 3.6 bytes per token and a guard, which divides string length, at 0.9 units per token (see {@link guardDivisor}); the one garbled-Hangul sample (cp949) sits above that guard rate, so it can undershoot on pathological text. */
export type ContentClass = 'text' | 'dense' | 'wide'

/** Measured bytes per token, by class. See the module docblock for the measurement. */
export const BYTES_PER_TOKEN: Record<ContentClass, number> = {
  text: 4.0,
  dense: 1.45,
  wide: 3.6,
}

/** UTF-8 bytes in one UTF-16 code unit of a class. A guard divides a string length (UTF-16 units) while a credit divides bytes, and the two coincide only for ASCII; a wide-script character is one unit and three bytes. */
const UTF8_BYTES_PER_UNIT: Record<ContentClass, number> = {
  text: 1,
  dense: 1,
  wide: 3,
}

/** A guard's divisor is this fraction of the credit divisor, so an overflow guard estimates high within whatever class it is looking at. At `text` this is exactly the 3.0 the overflow guard has always divided by. */
export const GUARD_MARGIN = 0.75

/** Bytes per token when crediting a saving: the measured rate, unmodified. */
export function creditDivisor(cls: ContentClass = 'text'): number {
  return BYTES_PER_TOKEN[cls]
}

/** String-length units per token when guarding a buffer: {@link GUARD_MARGIN} of the measured rate, so the estimate is high, scaled from bytes to UTF-16 units. 3.0 at `text`, 0.9 at `wide` (about 1.1 tokens per character, above every measured prose sample but below the garbled-Hangul outlier). */
export function guardDivisor(cls: ContentClass = 'text'): number {
  return (BYTES_PER_TOKEN[cls] * GUARD_MARGIN) / UTF8_BYTES_PER_UNIT[cls]
}

/** Characters that carry a base64url or hex payload. `+/=` covers standard base64, `-_` its url-safe spelling. */
const DENSE_ALPHABET = /^[A-Za-z0-9+/=_-]$/

/** One BMP character of Han (3400-9FFF), Hiragana and Katakana (3040-30FF) or Hangul syllables (AC00-D7AF): one UTF-16 unit, three UTF-8 bytes. Supplementary-plane ideographs are two units and are left to the text class. */
const WIDE_CHAR = /^[㐀-鿿぀-ヿ가-힯]$/

/** A sample is wide when at least this share of its non-whitespace characters is wide-script. Below it, a few CJK words inside English stay text. */
const WIDE_SHARE = 0.3

/** Every wide-script character of a string, the same set as {@link WIDE_CHAR}, for counting rather than testing one. */
const WIDE_CHARS = new RegExp(WIDE_CHAR.source.slice(1, -1), 'g')

/** Estimated guard tokens for a string, pricing each part at its own rate: wide-script characters at the `wide` guard divisor and the rest at the `text` one, or the whole string at the `dense` divisor when the caller has classified the payload dense. Proportional on purpose: a class chosen for the whole string made the ASCII share of a mixed text pay the wide rate above the {@link WIDE_SHARE} cliff and the CJK share pay the text rate below it. */
export function guardTokens(text: string, dense = false): number {
  if (dense) return text.length / guardDivisor('dense')
  const wide = text.match(WIDE_CHARS)?.length ?? 0
  return wide / guardDivisor('wide') + (text.length - wide) / guardDivisor('text')
}

/** Below this many sampled characters there is not enough evidence to call anything dense: a short hex word inside a sentence is still a sentence. */
const MIN_DENSE_SAMPLE = 200

/** A dense payload is dense because it is high-entropy, and the alphabet test alone does not measure that: a run of one repeated letter passes it while tokenizing better than prose, since a tokenizer merges the repeat. Hex draws on 16 characters and base64 on 64, so requiring at least this many distinct ones separates a real payload from a long uniform run without needing a real entropy calculation. */
const MIN_DENSE_DISTINCT = 16

/** How much of the text to look at. A payload is uniform by nature, so a prefix answers the question and a megabyte of it costs the same as a kilobyte. */
const CLASSIFY_SAMPLE_CHARS = 4096

/** Classify a run of text for {@link creditDivisor} / {@link guardDivisor}. A sample at least {@link WIDE_SHARE} wide-script is `wide`, at any length: a CJK line is short, and `wide` only raises a guard's estimate, so it carries no over-credit risk and needs no minimum sample. (A dense payload cannot also be wide: the dense alphabet is ASCII.) Otherwise, three conditions, all required: almost no whitespace, almost every character drawn from the dense alphabet, and at least {@link MIN_DENSE_DISTINCT} distinct characters. Prose and source fail the first on word breaks alone; minified JavaScript and JSON fail the second on their punctuation, and are priced as text -- under-priced, which is this classifier's safe direction and the behavior that already ships. */
export function classifyContent(text: string): ContentClass {
  const sample = text.slice(0, CLASSIFY_SAMPLE_CHARS)
  let whitespace = 0
  let wide = 0
  let dense = 0
  const distinct = new Set<string>()
  for (const ch of sample) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') whitespace++
    else if (WIDE_CHAR.test(ch)) wide++
    else if (DENSE_ALPHABET.test(ch)) {
      dense++
      distinct.add(ch)
    }
  }
  if (wide > 0 && wide >= (sample.length - whitespace) * WIDE_SHARE) return 'wide'
  if (sample.length < MIN_DENSE_SAMPLE) return 'text'
  if (whitespace / sample.length >= 0.05) return 'text'
  if (distinct.size < MIN_DENSE_DISTINCT) return 'text'
  return dense / sample.length >= 0.95 ? 'dense' : 'text'
}
