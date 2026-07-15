import { describe, expect, it } from 'vitest'

import {
  dispatchFileTypeHandler,
  handleCsv,
  handleDocx,
  handleGenericLarge,
  handleHtml,
  handleOfficeBinary,
  handlePdf,
  handlePptx,
  handleTranscript,
  handleTxt,
  handleXlsx,
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

  it('does not advertise a pages-parameter Read retry — PDFs are always blocked regardless of args, so that remedy can never work; points to a real extraction command instead', () => {
    const result = handlePdf('/path/to/doc.pdf', 1024)
    expect(result.message).not.toContain('pages')
    expect(result.message).not.toContain('Read({')
    expect(result.message).toContain('pdf-extract')
    expect(result.message).toContain('/path/to/doc.pdf')
  })

  it('message points at pdf-extract for a large PDF too', () => {
    const result = handlePdf('/path/to/doc.pdf', 500000)
    expect(result.message).toContain('pdf-extract')
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

  it('does not report a heading that is inside an HTML comment (regression: the hand-rolled heading regex scanned raw unmasked content instead of going through the shared findHtmlHeadingMatches/maskHtmlNoise helper, so a commented-out <h1> was reported as a live heading)', () => {
    const lines = [
      '<html><head><title>My Page</title></head><body>',
      '<!-- <h1>Commented Out Secret Heading</h1> -->',
      '<h2>Real Heading</h2>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Paragraph ${i}</p>`),
      '</body></html>',
    ]
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html)
    const result = handleHtml('/path/to/page.html', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).not.toContain('Commented Out Secret Heading')
    expect(result.message).toContain('Real Heading')
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

  it('a small contentLengthHint overrides a large content.length and allows the read through', () => {
    const lines = [
      '<html><head><title>My Page</title></head><body>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Paragraph ${i}</p>`),
      '</body></html>',
    ]
    // Real content is well above the HTML threshold, but the hint (a narrowed offset/limit
    // slice) is tiny — the hint must drive the block decision, not content.length.
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html * 2)
    const result = handleHtml('/path/to/page.html', content, 100)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks based on the hint while still extracting title/headings from the real full content, not something truncated to the hint', () => {
    const title = 'Real Title'
    const lines = [
      `<html><head><title>${title}</title></head><body>`,
      '<h1>Real Heading</h1>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Paragraph ${i}</p>`),
      '</body></html>',
    ]
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html * 2)
    // Hint is just barely above threshold — far smaller than the real content — but still blocks.
    const result = handleHtml('/path/to/page.html', content, FILE_TYPE_THRESHOLDS.html + 1)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain(title)
    expect(result.message).toContain('Real Heading')
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

  // Regression: the log-file recall hint suggested `bash-output <id>` with a literal,
  // unsubstituted `<id>` placeholder. A file read directly off disk never went through the
  // bash-output cache, so there is no id -- `bash-output <id>` errors ("no cached bash output
  // for id: <id>"). The working form (mirroring hooks_read.ts's sessionArtifactRecall for the
  // same on-disk-but-uncached situation) is `bash-output --file "<path>"`.
  it('log file recall hint uses --file with the real path, not a literal unsubstituted <id>', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = handleTxt('/var/log/app.log', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('bash-output --file "/var/log/app.log"')
    expect(result.message).not.toContain('bash-output <id>')
  })

  // Regression: isLog's directory-based fallback only matched a forward-slash '/logs/'
  // substring, so a Windows-native backslash-separated path (e.g. C:\...\logs\service.txt)
  // with a non-log extension silently fell back to the generic offset/limit hint instead
  // of the log-specific --tail/--grep recall.
  it('log file message contains --tail hint for a Windows-style backslash path under a logs directory', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = handleTxt('C:\\Projects\\myapp\\logs\\service.txt', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('--tail')
  })

  it('non-log txt file message contains offset/limit hint', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt + 1)
    const result = handleTxt('/path/to/notes.txt', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('offset')
  })

  it('a small contentLengthHint overrides a large content.length and allows the read through', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt * 2)
    const result = handleTxt('/path/to/file.txt', content, 100)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks based on the hint while still showing the real full content preview and line count, not something truncated to the hint', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`)
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.txt * 2)
    // Hint is just barely above threshold — far smaller than the real content — but still blocks.
    const result = handleTxt('/path/to/notes.txt', content, FILE_TYPE_THRESHOLDS.txt + 1)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('500')
    expect(result.message).toContain('Line 1')
  })

  it('large .txt file with HTML DOCTYPE is treated as HTML and includes headings', () => {
    // Create HTML content with DOCTYPE and headings
    const lines = [
      '<!DOCTYPE html>',
      '<html><head><title>API Documentation</title></head><body>',
      '<h1>Getting Started</h1>',
      '<h2>Installation</h2>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Paragraph ${i}</p>`),
      '</body></html>',
    ]
    // Need to exceed both txt and html thresholds to trigger handleHtml blocking
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html)
    const result = handleTxt('/var/log/export.txt', content)
    expect(result.shouldBlock).toBe(true)
    // Should include heading-aware content like handleHtml does
    expect(result.message).toContain('h1')
    expect(result.message).toContain('Getting Started')
    expect(result.message).toContain('h2')
    expect(result.message).toContain('Installation')
  })

  it('large .log file with HTML <html> tag is treated as HTML', () => {
    // HTML content starting with <html tag instead of DOCTYPE
    const lines = [
      '<html>',
      '<head><title>Event Log</title></head>',
      '<body>',
      '<h1>Log Entry</h1>',
      ...Array.from({ length: 100 }, (_, i) => `<p>Event ${i}</p>`),
      '</body></html>',
    ]
    // Need to exceed both txt and html thresholds to trigger handleHtml blocking
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.html)
    const result = handleTxt('/var/log/app.log', content)
    expect(result.shouldBlock).toBe(true)
    // Should be delegated to handleHtml and show headings, not the log-file first/last lines message
    expect(result.message).toContain('h1')
    expect(result.message).toContain('Log Entry')
    expect(result.message).not.toContain('--tail')
  })

  it('large plain text .txt file still gets first/last lines treatment', () => {
    // Genuine plain text, not HTML
    const lines = Array.from({ length: 100 }, (_, i) => `Plain line ${i + 1}`)
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.txt)
    const result = handleTxt('/path/to/notes.txt', content)
    expect(result.shouldBlock).toBe(true)
    // Should use the original handleTxt logic, not delegate to handleHtml
    expect(result.message).toContain('first 5 lines')
    expect(result.message).toContain('last 5 lines')
    expect(result.message).toContain('offset')
  })

  // Regression: handleTxt delegated wholesale to handleHtml (which re-gates on the higher
  // 50 KB html threshold) once content sniffed as HTML. A file between the 20 KB txt
  // threshold and the 50 KB html threshold got handleHtml's non-blocking {shouldBlock:false}
  // verbatim, so it silently read through with zero hint -- worse than an equivalent
  // non-HTML-sniffed .txt of the same size, which still got the standard preview hint.
  it('HTML-sniffed .txt file sized between the txt and html thresholds still gets a hint instead of reading through silently', () => {
    const lines = [
      '<!DOCTYPE html>',
      '<html><head><title>Saved Export</title></head><body>',
      '<h1>Report</h1>',
      '<p>exported content</p>',
      '</body></html>',
    ]
    // Sized well above FILE_TYPE_THRESHOLDS.txt (20,000) but well below FILE_TYPE_THRESHOLDS.html
    // (50,000), landing squarely in the gap band the delegation bug missed.
    const content = lines.join('\n') + makeStr(FILE_TYPE_THRESHOLDS.txt)
    const result = handleTxt('/path/to/export.txt', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message.length).toBeGreaterThan(0)
    // Falls back to the standard plain-text preview since it's below handleHtml's own threshold.
    expect(result.message).toContain('first 5 lines')
    expect(result.message).toContain('last 5 lines')
  })
})

describe('handleXlsx', () => {
  it('blocks .xlsx and redirects to xlsx-sheets', () => {
    const result = handleXlsx('/path/to/sheet.xlsx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('xlsx-sheets')
    expect(result.message).toContain('xlsx-query')
  })
})

describe('handlePptx', () => {
  it('blocks .pptx and redirects to pptx-outline', () => {
    const result = handlePptx('/path/to/slides.pptx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('pptx-outline')
    expect(result.message).toContain('pptx-slide')
  })
})

describe('handleDocx', () => {
  it('blocks .docx and redirects to docx-outline/docx-text', () => {
    const result = handleDocx('/path/to/doc.docx')
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('docx-outline')
    expect(result.message).toContain('docx-text')
  })
})

describe('handleOfficeBinary', () => {
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
    expect(result.message).toContain('csv-query')
  })

  it('blocks large TSV', () => {
    const content = `col1\tcol2\n${makeStr(FILE_TYPE_THRESHOLDS.tsv + 1)}`
    const result = handleCsv('/path/to/data.tsv', content)
    expect(result.shouldBlock).toBe(true)
  })

  // Regression: FILE_TYPE_THRESHOLDS.csv and .tsv are independently configurable, but
  // handleCsv always compared content length against .csv regardless of extension, so a
  // .tsv-specific threshold had zero effect. csv and tsv default to the same numeric value,
  // which hides the bug from the tests above -- mutate .tsv to a distinct value here to prove
  // handleCsv actually reads the tsv-specific threshold rather than always falling back to csv.
  it('honors a .tsv-specific threshold independently of .csv (mutation-verified, not masked by equal defaults)', () => {
    const thresholds = FILE_TYPE_THRESHOLDS as unknown as Record<string, number>
    const originalTsv = thresholds.tsv
    try {
      thresholds.tsv = thresholds.csv + 5000
      const content = `col1\tcol2\n${makeStr(thresholds.csv + 1)}`
      // Above the .csv threshold but still below the diverged .tsv threshold: must NOT block.
      const result = handleCsv('/path/to/data.tsv', content)
      expect(result.shouldBlock).toBe(false)
    } finally {
      thresholds.tsv = originalTsv
    }
  })

  // Regression: dispatchFileTypeHandler routes .csv/.tsv by a lowercased extension
  // but passes the original-case filePath through — handleCsv used to re-derive the
  // separator via a case-sensitive endsWith('.tsv'), so an uppercase .TSV file was
  // routed correctly but then split its tab-delimited header on commas instead.
  it('uses the tab separator for an uppercase .TSV extension, not the comma fallback', () => {
    const header = 'name\tage\tcity'
    const dataRows = Array.from({ length: 500 }, (_, i) => `Person${i}\t${i + 20}\tCity${i}`)
    const content = [header, ...dataRows].join('\n') + makeStr(FILE_TYPE_THRESHOLDS.tsv)
    const result = handleCsv('/path/to/data.TSV', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('3 columns')
  })

  // Regression: colCount was computed via a naive headers.split(sep), which miscounts whenever
  // a quoted field legitimately contains the delimiter (e.g. "Full Name, Preferred") — every
  // embedded comma was wrongly counted as a field boundary, inflating the reported column count.
  it('reports the correct column count when a quoted header field contains the delimiter', () => {
    const header = '"Full Name, Preferred","Email Address","Notes, Extra"'
    const content = header + '\n' + makeStr(FILE_TYPE_THRESHOLDS.csv)
    const result = handleCsv('/path/to/data.csv', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('3 columns')
  })

  it('a small contentLengthHint overrides a large content.length and allows the read through', () => {
    const header = 'name,age,city'
    const dataRows = Array.from({ length: 500 }, (_, i) => `Person${i},${i + 20},City${i}`)
    const content = [header, ...dataRows].join('\n') + makeStr(FILE_TYPE_THRESHOLDS.csv * 2)
    const result = handleCsv('/path/to/data.csv', content, 50)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks based on the hint while still showing the real column headers and sample rows, not something truncated to the hint', () => {
    const header = 'name,age,city'
    const dataRows = Array.from({ length: 500 }, (_, i) => `Person${i},${i + 20},City${i}`)
    const content = [header, ...dataRows].join('\n') + makeStr(FILE_TYPE_THRESHOLDS.csv * 2)
    // Hint is just barely above threshold — far smaller than the real content — but still blocks.
    const result = handleCsv('/path/to/data.csv', content, FILE_TYPE_THRESHOLDS.csv + 1)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('name,age,city')
    expect(result.message).toContain('Person0')
  })
})

describe('handleTranscript', () => {
  it('returns shouldBlock false below threshold', () => {
    const content = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n'
    const result = handleTranscript('/path/to/short.vtt', content)
    expect(result.shouldBlock).toBe(false)
  })

  it('blocks a large transcript and lists detected speakers', () => {
    const cues = Array.from(
      { length: 500 },
      (_, i) => `${i + 1}\n00:${String(i % 60).padStart(2, '0')}:00.000 --> 00:${String(i % 60).padStart(2, '0')}:01.000\n<v Speaker${i % 3}>Line ${i}`,
    ).join('\n\n')
    const content = `WEBVTT\n\n${cues}` + makeStr(FILE_TYPE_THRESHOLDS.transcript)
    const result = handleTranscript('/path/to/long.vtt', content)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('Speaker0')
    expect(result.message).toContain('transcript-outline')
    expect(result.message).toContain('transcript ')
  })

  it('a small contentLengthHint overrides a large content.length and allows the read through', () => {
    const content = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n' + makeStr(FILE_TYPE_THRESHOLDS.transcript * 2)
    const result = handleTranscript('/path/to/short.vtt', content, 50)
    expect(result.shouldBlock).toBe(false)
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
    expect(result?.message).toContain('pdf-extract')
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

  it('dispatches .docx to the docx handler', () => {
    const result = dispatchFileTypeHandler('/path/to/doc.docx', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('docx-outline')
  })

  it('dispatches .xlsx to the xlsx handler', () => {
    const result = dispatchFileTypeHandler('/path/to/sheet.xlsx', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('xlsx-sheets')
  })

  it('dispatches .pptx to the pptx handler', () => {
    const result = dispatchFileTypeHandler('/path/to/slides.pptx', '')
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('pptx-outline')
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

  it('dispatches large VTT transcript', () => {
    const content = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n` + makeStr(FILE_TYPE_THRESHOLDS.transcript)
    const result = dispatchFileTypeHandler('/path/to/meeting.vtt', content)
    expect(result?.shouldBlock).toBe(true)
    expect(result?.message).toContain('transcript-outline')
  })

  it('dispatches large SRT transcript', () => {
    const content = `1\n00:00:01,000 --> 00:00:02,000\nHi\n` + makeStr(FILE_TYPE_THRESHOLDS.transcript)
    const result = dispatchFileTypeHandler('/path/to/captions.srt', content)
    expect(result?.shouldBlock).toBe(true)
  })

  it('small VTT passes through', () => {
    const result = dispatchFileTypeHandler('/path/to/meeting.vtt', 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi')
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

  it('honors a narrowed contentLengthHint for HTML — passes through even though the real content is large', () => {
    const content = `<html><body>${makeStr(FILE_TYPE_THRESHOLDS.html * 2)}</body></html>`
    const result = dispatchFileTypeHandler('/path/to/page.html', content, 100)
    expect(result?.shouldBlock).toBe(false)
  })

  it('honors a narrowed contentLengthHint for TXT — passes through even though the real content is large', () => {
    const content = makeStr(FILE_TYPE_THRESHOLDS.txt * 2)
    const result = dispatchFileTypeHandler('/path/to/notes.txt', content, 100)
    expect(result?.shouldBlock).toBe(false)
  })

  it('honors a narrowed contentLengthHint for CSV — passes through even though the real content is large', () => {
    const content = `col1,col2\n${makeStr(FILE_TYPE_THRESHOLDS.csv * 2)}`
    const result = dispatchFileTypeHandler('/path/to/data.csv', content, 100)
    expect(result?.shouldBlock).toBe(false)
  })
})
