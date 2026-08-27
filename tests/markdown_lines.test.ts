import { describe, expect, it } from 'vitest'

import { eachUnfencedLine } from '../src/markdown_lines.js'

function collect(lines: string[]): Array<[number, string]> {
  return Array.from(eachUnfencedLine(lines))
}

describe('eachUnfencedLine', () => {
  it('yields every line unchanged when there are no fences', () => {
    const lines = ['# Heading', '', 'body text']
    expect(collect(lines)).toEqual([
      [0, '# Heading'],
      [1, ''],
      [2, 'body text'],
    ])
  })

  it('skips a fenced block and the fence delimiter lines themselves', () => {
    const lines = ['before', '```', '# not a real heading', '```', 'after']
    expect(collect(lines)).toEqual([
      [0, 'before'],
      [4, 'after'],
    ])
  })

  it('a ``` fence is not closed by a ~~~ line (mutation-testing gap: the char match is load-bearing per the doc comment)', () => {
    const lines = ['```', 'still inside', '~~~', 'still inside too', '```', 'after']
    expect(collect(lines)).toEqual([
      [5, 'after'],
    ])
  })

  it('a fence only closes on a run of the same length or longer (mutation-testing gap: a shorter same-char run must not close it)', () => {
    // Opening run is 4 backticks; a line consisting only of 3 backticks looks like a closing
    // fence delimiter (matches the same regex branch) but is too short to actually close it,
    // so everything up to the real (4-backtick) closing line stays swallowed as fenced content.
    const lines = ['````', 'inside', '```', 'still inside', '````', 'after']
    expect(collect(lines)).toEqual([
      [5, 'after'],
    ])
  })

  it('a longer same-char run does close the fence', () => {
    const lines = ['```', 'inside', '````', 'after']
    expect(collect(lines)).toEqual([
      [3, 'after'],
    ])
  })

  it('a marker-looking line with trailing content does not close the fence (mutation-testing gap: rest.trim() === "" is load-bearing, e.g. an info-string-bearing ``` line inside an already-open fence)', () => {
    const lines = ['```', '```js', 'still inside', '```', 'after']
    expect(collect(lines)).toEqual([
      [4, 'after'],
    ])
  })

  it('allows leading whitespace before the fence marker', () => {
    const lines = ['  ```', 'inside', '  ```', 'after']
    expect(collect(lines)).toEqual([
      [3, 'after'],
    ])
  })

  it('an opening fence may carry an info string', () => {
    const lines = ['```typescript', 'const x = 1', '```', 'after']
    expect(collect(lines)).toEqual([
      [3, 'after'],
    ])
  })

  it('an unclosed fence at EOF swallows all remaining lines', () => {
    const lines = ['before', '```', 'never closes']
    expect(collect(lines)).toEqual([
      [0, 'before'],
    ])
  })

  it('handles multiple separate fenced blocks', () => {
    const lines = ['a', '```', 'x', '```', 'b', '~~~', 'y', '~~~', 'c']
    expect(collect(lines)).toEqual([
      [0, 'a'],
      [4, 'b'],
      [8, 'c'],
    ])
  })

  it('returns nothing for an empty input', () => {
    expect(collect([])).toEqual([])
  })

  // A CRLF document split on '\n' leaves a trailing '\r' on every line. A JS regex `.` excludes `\r` (it is a line terminator), so a `(.*)$` info-string tail could never reach `$` and no fence line matched at all: every fence went invisible and a `#` comment inside a fenced block was scanned as a real heading. Both line endings are built explicitly here so the assertion is identical on ubuntu, windows and macOS.
  const FENCED_DOC = ['# Title', '', '## Sub', '```sh', '# not a heading', '```', 'after']

  it('skips a fenced block on a CRLF document, exactly as on LF', () => {
    const lf = FENCED_DOC.join('\n').split('\n')
    const crlf = FENCED_DOC.join('\r\n').split('\n')

    expect(collect(lf)).toEqual([
      [0, '# Title'],
      [1, ''],
      [2, '## Sub'],
      [6, 'after'],
    ])
    expect(collect(crlf)).toEqual([
      [0, '# Title\r'],
      [1, '\r'],
      [2, '## Sub\r'],
      [6, 'after'],
    ])
    // The same structural shape on both line endings: same indices, same text once the CR is removed.
    expect(collect(crlf).map(([i, l]) => [i, l.replace(/\r$/, '')])).toEqual(collect(lf))
  })

  it('a CRLF fence still only closes on a same-char run of at least the opening length', () => {
    const doc = ['a', '````', '```', '~~~~', '````', 'b']
    const crlf = doc.join('\r\n').split('\n')
    const lf = doc.join('\n').split('\n')
    // Control for an over-fix that merely made every marker-looking line toggle the fence: the inner ``` and ~~~~ lines are literal content, so only 'a' and 'b' survive.
    expect(collect(lf)).toEqual([
      [0, 'a'],
      [5, 'b'],
    ])
    expect(collect(crlf)).toEqual([
      [0, 'a\r'],
      [5, 'b'],
    ])
  })

  it('a CRLF marker line carrying an info string does not close an open fence', () => {
    const doc = ['a', '```', '```js', '```', 'b']
    const crlf = doc.join('\r\n').split('\n')
    // Control for an over-fix that dropped the rest.trim() === '' check: the '```js' line is content, so the block closes on the third marker and only 'a' and 'b' are yielded.
    expect(collect(crlf)).toEqual([
      [0, 'a\r'],
      [4, 'b'],
    ])
  })
})
