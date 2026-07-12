import { describe, expect, it } from 'vitest'
import { extractMarkdownHeadings } from '../src/hints/markdown_hints.js'

describe('extractMarkdownHeadings - fenced code blocks', () => {
  it('should ignore headings inside fenced code blocks', () => {
    const content = `# Real Heading

Here is some code:

\`\`\`bash
# Install dependencies
npm install
\`\`\`

## Another Real Heading`
    const headings = extractMarkdownHeadings(content)

    // Should only find the 2 real headings, not the "# Install" inside the code fence
    expect(headings).toHaveLength(2)
    expect(headings[0].text).toBe('Real Heading')
    expect(headings[0].level).toBe(1)
    expect(headings[1].text).toBe('Another Real Heading')
    expect(headings[1].level).toBe(2)
  })

  it('should handle multiple code blocks', () => {
    const content = `# Header 1

\`\`\`python
# TODO: fix this
# NOTE: important
\`\`\`

## Header 2

~~~
# Another commented header
~~~

### Header 3`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(3)
    expect(headings.map(h => h.text)).toEqual(['Header 1', 'Header 2', 'Header 3'])
  })

  it('should handle code blocks with triple tildes', () => {
    const content = `# Real

~~~bash
# Fake in tilde fence
~~~

# Another Real`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(2)
    expect(headings[0].text).toBe('Real')
    expect(headings[1].text).toBe('Another Real')
  })

  it('should not close a fence on a line with a trailing info string', () => {
    const content = `# Real Heading

\`\`\`
# Not a heading
\`\`\`json
# Actually inside the code block
\`\`\`

## Truly Next Heading`
    const headings = extractMarkdownHeadings(content)

    // The fence opened by the first ``` stays open through the ```json line
    // (it has a trailing info string, so per CommonMark it cannot close the
    // fence) and only closes on the second bare ``` line. Both # lines inside
    // are code content, not headings.
    expect(headings).toHaveLength(2)
    expect(headings[0].text).toBe('Real Heading')
    expect(headings[1].text).toBe('Truly Next Heading')
  })
})
