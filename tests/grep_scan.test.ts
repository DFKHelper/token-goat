import { describe, expect, it } from 'vitest'
import { scanGrepText } from '../src/grep_scan.js'

describe('scanGrepText', () => {
  it('preserves LF, CRLF, and the final empty line', () => {
    const result = scanGrepText('first\r\nmatch\n', /^$/u, 5, 0)

    expect(result.totalCount).toBe(1)
    expect(result.hits).toEqual([{ line: 3, text: '' }])
  })

  it('counts all matches while retaining only the requested hits', () => {
    const result = scanGrepText('hit\nmiss\nhit\nhit', /hit/u, 1, 0)

    expect(result.totalCount).toBe(3)
    expect(result.hits).toEqual([{ line: 1, text: 'hit' }])
  })

  it('attaches only the requested context lines to retained hits', () => {
    const result = scanGrepText('one\ntwo\nthree\nfour', /two|three/u, 2, 1)

    expect(result.hits).toEqual([
      {
        line: 2,
        text: 'two',
        context: [
          { line: 1, text: 'one' },
          { line: 2, text: 'two' },
          { line: 3, text: 'three' },
        ],
      },
      {
        line: 3,
        text: 'three',
        context: [
          { line: 2, text: 'two' },
          { line: 3, text: 'three' },
          { line: 4, text: 'four' },
        ],
      },
    ])
  })

  it('resets stateful regular expressions between lines', () => {
    const result = scanGrepText('hit\nhit\nhit', /hit/gu, 3, 0)

    expect(result.totalCount).toBe(3)
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2, 3])
  })
})
