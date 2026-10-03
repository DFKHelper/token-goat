/** extractDockerfileSymbols: a continued instruction spans every physical line, and a heredoc body is script text, not directives. Fixture provenance: HAND-DERIVED from the Dockerfile reference. "Escape" says a trailing backslash continues an instruction and that comment lines inside a continued instruction are removed without ending it; "Here-Documents" says RUN, COPY and ADD accept `<<WORD`, `<<-WORD` (leading tabs stripped from the body and the terminator) and quoted `<<"WORD"` forms, with the body running to a line holding only WORD. The first fixture is the CAPTURE shape from `token-goat outline Dockerfile` on a scratch project (continued RUN reported as 4-4, phantom `FROM fake` at 9-9), with expected spans counted by hand from the line numbers. */
import { describe, expect, it } from 'vitest'

import { extractDockerfileSymbols } from '../src/parser_structured.js'

function spans(lines: string[]): Array<[string, number, number]> {
  return extractDockerfileSymbols(lines.join('\n'), 'Dockerfile').map((s) => [s.name, s.lineStart, s.lineEnd])
}

describe('Dockerfile continued instructions', () => {
  it('spans a backslash-continued RUN and a heredoc RUN, with no phantom FROM from the heredoc body', () => {
    const seen = spans([
      'FROM node:20', // 1
      '', // 2
      '# build', // 3
      'RUN apt-get update \\', // 4
      '    && apt-get install -y curl \\', // 5
      '    && rm -rf /var/lib/apt/lists/*', // 6
      'RUN <<EOT', // 7
      'echo hello', // 8
      'FROM fake', // 9
      'EOT', // 10
      'CMD ["node"]', // 11
    ])
    expect(seen).toEqual([
      ['FROM node:20', 1, 1],
      ['RUN apt-get update \\', 4, 6],
      ['RUN <<EOT', 7, 10],
      ['CMD ["node"]', 11, 11],
    ])
  })

  it('stores the whole instruction as the body', () => {
    const [sym] = extractDockerfileSymbols(['RUN a \\', '  && b'].join('\n'), 'Dockerfile')
    expect(sym?.body).toBe('RUN a \\\n  && b')
  })

  it('keeps a comment line inside a continued instruction in its span', () => {
    expect(spans(['RUN a \\', '# note', '  && b', 'USER app'])).toEqual([
      ['RUN a \\', 1, 3],
      ['USER app', 4, 4],
    ])
  })

  it('does not read a continuation line that starts with a keyword as a directive', () => {
    expect(spans(['RUN a \\', 'env X=1 b', 'USER app'])).toEqual([
      ['RUN a \\', 1, 2],
      ['USER app', 3, 3],
    ])
  })
})

describe('Dockerfile heredocs', () => {
  it('handles `<<-` (tab-stripped terminator), quoted words, and COPY with two heredocs', () => {
    expect(spans(['RUN <<-EOT', '\techo a', '\tEOT', 'USER app'])).toEqual([
      ['RUN <<-EOT', 1, 3],
      ['USER app', 4, 4],
    ])
    expect(spans(['RUN <<"EOT"', 'FROM x', 'EOT', 'USER app'])).toEqual([
      ['RUN <<"EOT"', 1, 3],
      ['USER app', 4, 4],
    ])
    expect(spans(['COPY <<A /a <<B /b', 'one', 'A', 'two', 'B', 'USER app'])).toEqual([
      ['COPY <<A /a <<B /b', 1, 5],
      ['USER app', 6, 6],
    ])
  })

  it('does not let a stray `<<word` or a here-string swallow the rest of the file', () => {
    expect(spans(['RUN echo "a<<b"', 'USER app'])).toEqual([
      ['RUN echo "a<<b"', 1, 1],
      ['USER app', 2, 2],
    ])
    expect(spans(['RUN cat <<< "x"', 'USER app'])).toEqual([
      ['RUN cat <<< "x"', 1, 1],
      ['USER app', 2, 2],
    ])
  })

  it('does not treat a heredoc operand on a non-RUN/COPY/ADD instruction as a heredoc', () => {
    expect(spans(['CMD echo <<EOT', 'USER app', 'EOT'])).toEqual([
      ['CMD echo <<EOT', 1, 1],
      ['USER app', 2, 2],
    ])
  })
})
