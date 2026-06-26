import { describe, expect, it } from 'vitest'

import {
  dispatchFileTypeHandler,
  handleCsv,
  handleGenericLarge,
  handleHtml,
  handleOfficeBinary,
  handlePdf,
  handleTxt,
  FILE_TYPE_THRESHOLDS,
} from '../src/hints/file_type_handler.js'

// Helper to generate a string of given byte length
function makeStr(bytes: number, char = 'x'): string {
  return char.repeat(bytes)
}

describe('handlePdf', () => {
  it('always blocks regardless of size', () => {
    const result = handlePdf('/tmp/doc.pdf', 0)
    expect(result.shouldBlock).toBe(true)
  })

  it('message contains pages parameter hint', () => {
    const result = handlePdf('/path/to/doc.pdf', 1024)
    expect(result.message).toContain('pages')
    expect(result.message).toContain('/path/to/doc.pdf')
  })

  it('message contains pdfinfo command', () => {
    const result = handlePdf('/path/to/doc.pdf', 500000)
    expect(result.message).toContain('pdfinfo')
  })
})

describe('handleHtml', () => {
  it('returns shouldBlock false below threshold', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.html - 1)
    const result = handleHtml('/path/to/page.html', content)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks large HTML and includes headings', () => {
    // Create enough lines so it doesn't trigger minified detection
    const lines = [
      '<html><head><title>My Page</title></head><body>',
      '<h1>Main Title</h1>',
      '<h2>Section One</h2>',
      '<h3>Subsection</h3>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Paragraph ${i}</p>`),
      '</body></html>',
    ]
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html)
    const result = handleHtml('/path/to/page.html', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('h1')
    expect(result.message).toContain('Main Title')
  })

  it('blocks minified HTML with minified notice', () => {
    // Minified: very long single line
    const content = makeStr(FILE_TYPE_THRESHOLDS.html + 1, 'a')
    const result = handleHtml('/path/to/min.html', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('minified')
  })

  it('includes title in message when present', () => {
    const title = 'My Document Title'
    // Create enough lines so it doesn't trigger minified detection
    const lines = [
      `<html><head><title>${title}</title></head><body>`,
      ...Array.from({ length: 100 }, (_, i) => `<p>Content ${i}</p>`),
      '</body></html>',
    ]
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html)
    const result = handleHtml('/path/to/page.html', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain(title)
  })
})

describe('handleTxt', () => {
  it('returns shouldBlock false below threshold', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt - 1)
    const result = handleTxt('/path/to/file.txt', content)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks large txt and includes line count and preview', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
    const content = lines.join('\n')
    // Make it large enough
    const bigContent = content + makeStr(FILE_TYPE_THRESHOLDS.txt)
    const result = handleTxt('/path/to/big.txt', bigContent)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('lines')
    expect(result.message).toContain('first 5 lines')
    expect(result.message).toContain('last 5 lines')
  })

  it('log file message contains --tail hint', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = handleTxt('/var/log/app.log', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('--tail')
  })

  it('non-log txt file message contains offset/limit hint', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = handleTxt('/path/to/notes.txt', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('offset')
  })
})

describe('handleOfficeBinary', () => {
  it('blocks .docx with pandoc hint', () => {
    const result = handleOfficeBinary('/path/to/doc.docx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('pandoc')
    expect(result.message).toContain('.docx')
  })

  it('blocks .xlsx with pandoc hint', () => {
    const result = handleOfficeBinary('/path/to/sheet.xlsx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('pandoc')
    expect(result.message).toContain('.xlsx')
  })

  it('blocks .pptx', () => {
    const result = handleOfficeBinary('/path/to/slides.pptx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('.pptx')
  })

  it('blocks .odt', () => {
    const result = handleOfficeBinary('/path/to/doc.odt')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('.odt')
  })

  it('handles file with no extension gracefully', () => {
    const result = handleOfficeBinary('/path/to/document')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('Binary Office file')
    expect(result.message).toContain('.bin')
  })

  it('handles file with only extension gracefully', () => {
    const result = handleOfficeBinary('/path/to/.docx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('Binary Office file')
  })
})

describe('handleCsv', () => {
  it('returns shouldBlock false below threshold', () => {
    const content = 'col1,col2\nval1,val2\n'
    const result = handleCsv('/path/to/data.csv', content)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks large CSV and shows column headers and sample rows', () => {
    const header = 'name,age,city'
    const dataRows = Array.from({ length: 500 }, (_, i) => `Person${i},${i + 20},City${i}`)
    const content = [header, ...dataRows].join('\n') + makeStr(FILE_TYPE_THRESHOLDS.csv)
    const result = handleCsv('/path/to/data.csv', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('name,age,city')
    expect(result.message).toContain('rows')
    expect(result.message).toContain('DuckDB')
  })

  it('blocks large TSV', () => {
    const content = `col1\tcol2\n${makeStr(FILE_TYPE_THRESHOLDS.tsv + 1)}`
    const result = handleCsv('/path/to/data.tsv', content)
    expect(result.shouldBlock).toBe(true)
  })
})

describe('handleGenericLarge', () => {
  it('blocks files above threshold', () => {
    const result = handleGenericLarge('/path/to/file.bin', FILE_TYPE_THRESHOLDS.generic + 1)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('offset')
  })

  it('passes files below threshold', () => {
    const result = handleGenericLarge('/path/to/file.bin', FILE_TYPE_THRESHOLDS.generic - 1)
    expect(result.shouldBlock).toBe(false)
  })
})

describe('dispatchFileTypeHandler', () => {
  it('returns null for .md files (handled upstream)', () => {
    const result = dispatchFileTypeHandler('/path/to/README.md', makeStr(200_000))
    expect(result).toBeNull()
  })

  it('returns null for .mdx files', () => {
    const result = dispatchFileTypeHandler('/path/to/page.mdx', makeStr(200_000))
    expect(result).toBeNull()
  })

  it('returns null for .markdown files', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.markdown', makeStr(200_000))
    expect(result).toBeNull()
  })

  it('returns null for .rst files', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.rst', makeStr(200_000))
    expect(result).toBeNull()
  })

  it('dispatches PDF — always blocks', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.pdf', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('pages')
  })

  it('uses contentLengthHint for PDF size display', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.pdf', '', 2_097_152)
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('2.0 MB')
  })

  it('dispatches HTML above threshold', () => {
    const content = `<html><body>${makeStr(FILE_TYPE_THRESHOLDS.html)}</body></html>`
    const result = dispatchFileTypeHandler('/path/to/page.html', content)
    expect(result?.shouldBlock).toBe(true)
  })

  it('dispatches large TXT', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = dispatchFileTypeHandler('/path/to/notes.txt', content)
    expect(result?.shouldBlock).toBe(true)
  })

  it('dispatches .log file', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = dispatchFileTypeHandler('/var/log/app.log', content)
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('--tail')
  })

  it('dispatches .docx as office binary', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.docx', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('pandoc')
  })

  it('dispatches .xlsx as office binary', () => {
    const result = dispatchFileTypeHandler('/path/to/sheet.xlsx', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('pandoc')
  })

  it('dispatches .pptx as office binary', () => {
    const result = dispatchFileTypeHandler('/path/to/slides.pptx', '')
    expect(result?.shouldBlock).toBe(true)
  })

  it('dispatches .odt as office binary', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.odt', '')
    expect(result?.shouldBlock).toBe(true)
  })

  it('dispatches large CSV', () => {
    const content = `col1,col2\n${makeStr(FILE_TYPE_THRESHOLDS.csv)}`
    const result = dispatchFileTypeHandler('/path/to/data.csv', content)
    expect(result?.shouldBlock).toBe(true)
  })

  it('small CSV passes through', () => {
    const result = dispatchFileTypeHandler('/path/to/data.csv', 'col1,col2\nval1,val2')
    expect(result?.shouldBlock).toBe(false)
  })

  it('generic large file above 100KB blocks', () => {
    const result = dispatchFileTypeHandler('/path/to/file.bin', '', FILE_TYPE_THRESHOLDS.generic + 1)
    expect(result?.shouldBlock).toBe(true)
  })

  it('generic small file passes through', () => {
    const result = dispatchFileTypeHandler('/path/to/file.bin', '', FILE_TYPE_THRESHOLDS.generic - 1)
    expect(result?.shouldBlock).toBe(false)
  })
})
