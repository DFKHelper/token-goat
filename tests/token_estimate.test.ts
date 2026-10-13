/** Content-class token estimation. Provenance: HAND-DERIVED for the arithmetic -- every expected number below is computed from the input and the published ratio, never read back out of the function under test. The two class ratios themselves are CAPTURE (tiktoken over 120 repository files, recorded in src/token_estimate.ts) and their ranges are already pinned by tests/compress_text_token_accounting.test.ts, so they are not re-asserted here. The wide class (CJK) rate is CAPTURE: tiktoken 0.13.0 run over JAPANESE_TEXT, CHINESE_TEXT and KOREAN_TEXT below (counts beside each constant; the paragraphs were written for this test, so they show the rate on technical prose, not a corpus). */
import { describe, expect, it } from 'vitest'

import { BYTES_PER_TOKEN, GUARD_MARGIN, classifyContent, creditDivisor, guardDivisor } from '../src/token_estimate.js'
import { estimateTokensFromLength } from '../src/overflow_guard.js'
import { savedTokensFromBytes } from '../src/stats.js'

/** A real base64url payload: 64 distinct characters, no whitespace. Built from the alphabet rather than pasted so the shape is visible, and repeated so the sample clears the classifier's minimum. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.repeat(16)

/** Japanese prose, 178 UTF-16 units, 534 UTF-8 bytes. CAPTURE: tiktoken 0.13.0 counts 185 tokens (cl100k_base) and 131 (o200k_base). */
const JAPANESE_TEXT = 'このコマンドは、プロジェクト内の指定されたシンボルの定義を検索し、該当するファイルの一部だけを返します。ファイル全体を読み込む代わりに、必要な関数の本体だけを取り出すことで、モデルに送られるトークンの量を大幅に減らすことができます。インデックスが古い場合は、バックグラウンドで再構築が行われます。設定ファイルでは、出力の上限や警告のしきい値を変更できます。'

/** Chinese prose, 135 UTF-16 units, 405 UTF-8 bytes. CAPTURE: tiktoken 0.13.0 counts 123 tokens (cl100k_base) and 95 (o200k_base). */
const CHINESE_TEXT = '此命令会在项目中查找指定符号的定义，并只返回相关文件的一部分内容。与读取整个文件相比，只提取所需函数的主体可以大幅减少发送给模型的令牌数量。如果索引已经过期，系统会在后台重新构建索引。在配置文件中，可以修改输出的上限以及发出警告的阈值，从而适应不同的项目规模和使用习惯。'

/** Korean prose, 172 UTF-16 units, 426 UTF-8 bytes. CAPTURE: tiktoken 0.13.0 counts 134 tokens (cl100k_base) and 88 (o200k_base). */
const KOREAN_TEXT = '이 명령은 프로젝트에서 지정한 심볼의 정의를 찾아 해당 파일의 일부만 반환합니다. 파일 전체를 읽는 대신 필요한 함수의 본문만 가져오면 모델에 전달되는 토큰의 양을 크게 줄일 수 있습니다. 색인이 오래된 경우에는 백그라운드에서 다시 만들어집니다. 설정 파일에서 출력의 상한과 경고 기준값을 바꿀 수 있습니다.'

/** [text, UTF-8 bytes, cl100k_base tokens, o200k_base tokens] per sample, from the CAPTURE lines above. */
const WIDE_SAMPLES: ReadonlyArray<readonly [string, number, number, number]> = [
  [JAPANESE_TEXT, 534, 185, 131],
  [CHINESE_TEXT, 405, 123, 95],
  [KOREAN_TEXT, 426, 134, 88],
]

describe('content class divisors', () => {
  it('reproduces the two divisors this repository has always used, so nothing is re-priced by the class split', () => {
    // 4.0 for a credit and 3.0 for a guard are the numbers savedTokensFromBytes and estimateTokensFromLength divided by before content classes existed. GUARD_MARGIN is what keeps them related instead of independently editable.
    expect(creditDivisor()).toBe(4.0)
    expect(guardDivisor()).toBe(3.0)
    expect(guardDivisor()).toBe(creditDivisor() * GUARD_MARGIN)
  })

  it('keeps a guard above its own credit inside every class, which is the whole point of the margin', () => {
    for (const cls of ['text', 'dense'] as const) {
      for (const bytes of [200, 1200, 98765]) {
        expect(savedTokensFromBytes(bytes, cls), `${cls} at ${bytes} bytes`).toBeLessThan(estimateTokensFromLength(bytes, cls))
      }
    }
  })

  it('prices a dense payload roughly 2.8x a text one, which is the spread the flat divisor was losing', () => {
    // 1200 / 1.45 = 827.6 -> 828 by hand, against 1200 / 4 = 300.
    expect(savedTokensFromBytes(1200, 'dense')).toBe(828)
    expect(savedTokensFromBytes(1200, 'text')).toBe(300)
    expect(BYTES_PER_TOKEN.text / BYTES_PER_TOKEN.dense).toBeCloseTo(2.76, 2)
  })
})

describe('classifyContent', () => {
  it('calls a base64url payload dense', () => {
    expect(classifyContent(BASE64URL)).toBe('dense')
  })

  it('calls a hex dump dense', () => {
    expect(classifyContent('deadbeef0123456789abcdef'.repeat(20))).toBe('dense')
  })

  it('calls source text text, however long', () => {
    expect(classifyContent('export function widget(): number {\n  return 42\n}\n'.repeat(40))).toBe('text')
  })

  it('does not call a long uniform run dense, since a tokenizer merges a repeat rather than splitting it', () => {
    // The alphabet and whitespace tests alone both pass here. Without the distinct-character floor this priced 300 bytes of one letter at 276 tokens.
    expect(classifyContent('a'.repeat(3000))).toBe('text')
  })

  it('does not call minified punctuation-heavy source dense, and under-prices it rather than guessing', () => {
    expect(classifyContent('{"a":1,"b":[2,3],"c":{"d":"e"}},'.repeat(30))).toBe('text')
  })

  it('needs enough of a sample to call anything dense, so a hash inside a sentence stays a sentence', () => {
    expect(classifyContent('the commit is 9f2a4c1e8b7d6f3a and it landed yesterday')).toBe('text')
  })

  it('reaches the guard estimator through the text-holding overload, which is the only caller that can see the class', async () => {
    const { estimateTokens } = await import('../src/overflow_guard.js')
    // Same length, different class: the dense one must cost materially more than the source one.
    const source = 'export const widget = 42;\n'.repeat(20)
    const payload = BASE64URL.slice(0, source.length)
    expect(payload.length).toBe(source.length)
    expect(estimateTokens(payload)).toBeGreaterThan(estimateTokens(source) * 2)
  })

  it('calls Japanese, Chinese and Korean prose wide', () => {
    for (const [text] of WIDE_SAMPLES) expect(classifyContent(text)).toBe('wide')
  })

  it('calls a single short CJK line wide, since a CJK line is far shorter than the dense classifier needs', () => {
    expect(classifyContent('これは日本語です。')).toBe('wide')
  })

  it('keeps English with a little CJK in it text', () => {
    // HAND-DERIVED: 180 ASCII letters against 7 kana is about 4% wide, under the 30% line.
    expect(classifyContent('The quick brown fox jumps over the lazy dog. '.repeat(4) + 'これは日本語です。')).toBe('text')
  })

  it('does not call a base64 payload with a CJK word on the end wide', () => {
    expect(classifyContent(BASE64URL + '日本語')).toBe('dense')
  })

  it('guards a wide sample above what tiktoken counted and credits it inside the range tiktoken counted', async () => {
    const { estimateTokens } = await import('../src/overflow_guard.js')
    // The guard divides string length and must guess high; the credit divides bytes and must not exceed the densest tokenizer's count nor fall under the sparsest.
    for (const [text, bytes, cl100k, o200k] of WIDE_SAMPLES) {
      expect(estimateTokens(text), text.slice(0, 8)).toBeGreaterThanOrEqual(cl100k)
      expect(savedTokensFromBytes(bytes, 'wide'), text.slice(0, 8)).toBeLessThanOrEqual(cl100k)
      expect(savedTokensFromBytes(bytes, 'wide'), text.slice(0, 8)).toBeGreaterThanOrEqual(o200k)
    }
  })

  it('prices 300 wide characters at 334 tokens by hand, against 101 for 300 ASCII ones', () => {
    // HAND-DERIVED: guard divisor 3.6 * 0.75 / 3 = 0.9 units per token, so floor(300 / 0.9) + 1 = 334; text is floor(300 / 3) + 1 = 101.
    expect(guardDivisor('wide')).toBeCloseTo(0.9, 10)
    expect(estimateTokensFromLength(300, 'wide')).toBe(334)
    expect(estimateTokensFromLength(300, 'text')).toBe(101)
  })
})
