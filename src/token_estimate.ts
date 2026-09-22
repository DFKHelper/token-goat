/**
 * Bytes-to-tokens estimation, by content class.
 *
 * Every other estimate in this repository prices a byte flat, and a byte is not a fixed number of tokens. Measured with tiktoken (cl100k_base and o200k_base) over 120 real files in this repository, natural source text runs 3.83-4.22 bytes per token while a base64url payload runs 1.41-1.49 -- a 2.8x spread that decides whether a credited saving is honest and whether a buffer guard fires before or after the context it was protecting is already gone.
 *
 * Two divisors, deliberately not one. A credit prices bytes at their measured rate; a guard prices them at {@link GUARD_MARGIN} of that rate, so it guesses high on purpose. That relationship is what `tests/saved_tokens_use_one_divisor.test.ts` pins, and 0.75 is chosen so the text class reproduces the two numbers this repository has always used -- 4.0 for a credit, 3.0 for a guard -- exactly. Nothing is re-priced by this module's arrival; it only makes a second class expressible.
 *
 * The classifier is precise rather than eager. A payload it does not recognise is priced as text, which is what happens today, so a miss costs nothing that was not already being lost; a false positive would over-credit a saving, which is the direction this project has had to undo before.
 */

/**
 * How a run of bytes tokenizes.
 *
 * `dense` is base64, base64url, hex and the like: a high-entropy alphabet with no word boundaries for the tokenizer to merge on. `text` is everything else -- source, prose, logs, JSON with real keys in it.
 */
export type ContentClass = 'text' | 'dense'

/** Measured bytes per token, by class. See the module docblock for the measurement. */
export const BYTES_PER_TOKEN: Record<ContentClass, number> = {
  text: 4.0,
  dense: 1.45,
}

/** A guard's divisor is this fraction of the credit divisor, so an overflow guard estimates high within whatever class it is looking at. At `text` this is exactly the 3.0 the overflow guard has always divided by. */
export const GUARD_MARGIN = 0.75

/** Bytes per token when crediting a saving: the measured rate, unmodified. */
export function creditDivisor(cls: ContentClass = 'text'): number {
  return BYTES_PER_TOKEN[cls]
}

/** Bytes per token when guarding a buffer: {@link GUARD_MARGIN} of the measured rate, so the estimate is high. */
export function guardDivisor(cls: ContentClass = 'text'): number {
  return BYTES_PER_TOKEN[cls] * GUARD_MARGIN
}

/** Characters that carry a base64url or hex payload. `+/=` covers standard base64, `-_` its url-safe spelling. */
const DENSE_ALPHABET = /^[A-Za-z0-9+/=_-]$/

/** Below this many sampled characters there is not enough evidence to call anything dense: a short hex word inside a sentence is still a sentence. */
const MIN_DENSE_SAMPLE = 200

/** A dense payload is dense because it is high-entropy, and the alphabet test alone does not measure that: a run of one repeated letter passes it while tokenizing better than prose, since a tokenizer merges the repeat. Hex draws on 16 characters and base64 on 64, so requiring at least this many distinct ones separates a real payload from a long uniform run without needing a real entropy calculation. */
const MIN_DENSE_DISTINCT = 16

/** How much of the text to look at. A payload is uniform by nature, so a prefix answers the question and a megabyte of it costs the same as a kilobyte. */
const CLASSIFY_SAMPLE_CHARS = 4096

/**
 * Classify a run of text for {@link creditDivisor} / {@link guardDivisor}.
 *
 * Three conditions, all required: almost no whitespace, almost every character drawn from the dense alphabet, and at least {@link MIN_DENSE_DISTINCT} distinct characters. Prose and source fail the first on word breaks alone; minified JavaScript and JSON fail the second on their punctuation, and are priced as text -- under-priced, which is this classifier's safe direction and the behavior that already ships.
 */
export function classifyContent(text: string): ContentClass {
  const sample = text.slice(0, CLASSIFY_SAMPLE_CHARS)
  if (sample.length < MIN_DENSE_SAMPLE) return 'text'
  let whitespace = 0
  let dense = 0
  const distinct = new Set<string>()
  for (const ch of sample) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') whitespace++
    else if (DENSE_ALPHABET.test(ch)) {
      dense++
      distinct.add(ch)
    }
  }
  if (whitespace / sample.length >= 0.05) return 'text'
  if (distinct.size < MIN_DENSE_DISTINCT) return 'text'
  return dense / sample.length >= 0.95 ? 'dense' : 'text'
}
