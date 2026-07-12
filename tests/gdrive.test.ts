import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

import * as webCache from '../src/web_cache.js'

vi.mock('../src/web_cache.js', () => ({
  storeWebOutput: vi.fn().mockResolvedValue(undefined),
  getWebOutputByUrlFromDisk: vi.fn().mockReturnValue(null),
}))

import * as gdrive from '../src/gdrive.js'

describe('gdrive', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    vi.mocked(webCache.getWebOutputByUrlFromDisk).mockReset().mockReturnValue(null)
    vi.mocked(webCache.storeWebOutput).mockClear()
  })

  describe('fetchDoc', () => {
    it('returns cached text on hit', async () => {
      const fileId = 'abc123def456'
      const docText = '# **Header** {#header}\nContent'

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const result1 = await gdrive.fetchDoc(fileId)
      expect(result1).toBe(docText)
      expect(mockFetch).toHaveBeenCalledOnce()

      vi.mocked(webCache.getWebOutputByUrlFromDisk).mockReturnValueOnce({ cacheId: 'test', content: docText })

      const result2 = await gdrive.fetchDoc(fileId)
      expect(result2).toBe(docText)
      expect(mockFetch).toHaveBeenCalledOnce()
    })

    it('fetches on cache miss', async () => {
      const fileId = 'xyz789abc'
      const docText = '# **New Doc** {#new-doc}\nNew content'

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const result = await gdrive.fetchDoc(fileId)
      expect(result).toBe(docText)
      expect(mockFetch).toHaveBeenCalledOnce()

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain(fileId)
      expect(url).toContain('export?format=markdown')
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response)

      await expect(gdrive.fetchDoc('missing')).rejects.toThrow('Failed to fetch Google Doc: HTTP 404')
    })

    it('validates file_id', async () => {
      await expect(gdrive.fetchDoc('')).rejects.toThrow('file_id cannot be empty')
      await expect(gdrive.fetchDoc('path/to/file')).rejects.toThrow('invalid characters')
      await expect(gdrive.fetchDoc('a'.repeat(200))).rejects.toThrow('too long')
    })

    it('rejects a private-doc sign-in redirect instead of caching it as content', async () => {
      const signInHtml = '<html><body>Sign in to continue</body></html>'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null) },
        text: async () => signInHtml,
      } as unknown as Response)

      await expect(gdrive.fetchDoc('private-doc-id')).rejects.toThrow(/private or not shared/)
      expect(webCache.storeWebOutput).not.toHaveBeenCalled()
    })

    it('caches real (non-HTML) doc content normally', async () => {
      const docText = '# Real content\nBody text.'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name === 'content-type' ? 'text/plain; charset=utf-8' : null) },
        text: async () => docText,
      } as unknown as Response)

      const result = await gdrive.fetchDoc('public-doc-id')
      expect(result).toBe(docText)
      expect(webCache.storeWebOutput).toHaveBeenCalledOnce()
    })

    it('bypasses the disk cache and forces a live fetch when fresh is true', async () => {
      const fileId = 'fresh-flag-id'
      const staleText = 'stale cached content'
      const freshText = 'fresh live content'

      vi.mocked(webCache.getWebOutputByUrlFromDisk).mockReturnValueOnce({ cacheId: 'test', content: staleText })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/plain' },
        text: async () => freshText,
      } as unknown as Response)

      const result = await gdrive.fetchDoc(fileId, { fresh: true })
      expect(result).toBe(freshText)
      expect(mockFetch).toHaveBeenCalledOnce()
      expect(webCache.storeWebOutput).toHaveBeenCalledWith(expect.any(String), freshText)
    })
  })

  describe('getDocSections', () => {
    it('parses headings from a real markdown export (bold markers + anchor suffix)', async () => {
      // This is the actual shape Google Docs' format=markdown export produces for styled
      // headings: bold-wrapped text followed by a " {#anchor-slug}" suffix. The old
      // format=txt export (and the old test fixture of bare "# Heading" lines) never
      // matched real doc output, since txt export renders no "#" characters at all for
      // native styled headings.
      const docText = `# **Introduction** {#introduction}
This is the intro.

## **Getting Started** {#getting-started}
Instructions here.

### **Installation** {#installation}
Install steps.

## **Advanced** {#advanced}
More info.
`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const sections = await gdrive.getDocSections('test-id')
      expect(sections.length).toBe(4)

      expect(sections[0].heading).toBe('Introduction')
      expect(sections[0].level).toBe(1)
      expect(sections[0].content).toBe('This is the intro.')

      expect(sections[1].heading).toBe('Getting Started')
      expect(sections[1].level).toBe(2)
      expect(sections[1].content).toBe('Instructions here.')

      expect(sections[2].heading).toBe('Installation')
      expect(sections[2].level).toBe(3)
      expect(sections[2].content).toBe('Install steps.')

      expect(sections[3].heading).toBe('Advanced')
      expect(sections[3].level).toBe(2)
      expect(sections[3].content).toBe('More info.')
    })

    it('strips bold markers and the anchor suffix from a real markdown-export heading', async () => {
      // Regression test: a heading fixture shaped like the old (wrong) oracle -- a bare
      // "# Heading" line with no bold markers or anchor suffix -- would pass under the old
      // regex-only parsing but never occurs in a real Google Docs export. This fixture uses
      // the real export shape and would have failed under the old parseDocSections, which
      // left "**Introduction**" and the "{#introduction}" suffix embedded in the heading text.
      const docText = '# **Introduction** {#introduction}\nBody text.\n'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const sections = await gdrive.getDocSections('markdown-shape-id')
      expect(sections.length).toBe(1)
      expect(sections[0].heading).toBe('Introduction')
      expect(sections[0].heading).not.toContain('**')
      expect(sections[0].heading).not.toContain('{#')
      expect(sections[0].content).toBe('Body text.')
    })

    it('handles docs with no headings', async () => {
      const docText = 'Just plain text.\nNo headings here.'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const sections = await gdrive.getDocSections('plain-id')
      expect(sections.length).toBe(0)
    })

    it('handles empty content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
      } as Response)

      const sections = await gdrive.getDocSections('empty-id')
      expect(sections.length).toBe(0)
    })

    it('calculates byteStart correctly with Windows line endings (CRLF)', async () => {
      const docText = '# **First** {#first}\r\nContent\r\n\r\n# **Second** {#second}\r\nMore content'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const sections = await gdrive.getDocSections('crlf-id')
      expect(sections.length).toBe(2)

      expect(sections[0].heading).toBe('First')
      expect(sections[0].content).toBe('Content')
      expect(sections[0].byteStart).toBe(0)

      expect(sections[1].heading).toBe('Second')
      expect(sections[1].content).toBe('More content')
      const expected2ndStart = Buffer.byteLength('# **First** {#first}\r\nContent\r\n\r\n', 'utf8')
      expect(sections[1].byteStart).toBe(expected2ndStart)
    })
  })

  describe('formatSections', () => {
    it('returns non-empty string for sections', () => {
      const sections = [
        {
          heading: 'Introduction',
          level: 1 as const,
          content: 'This is intro text that is reasonably long.',
          byteStart: 0,
        },
        {
          heading: 'Getting Started',
          level: 2 as const,
          content: 'Step 1: Install.',
          byteStart: 100,
        },
      ]

      const result = gdrive.formatSections(sections)
      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(0)
      expect(result).toContain('Introduction')
      expect(result).toContain('Getting Started')
      expect(result).toContain('tokens')
      expect(result).toContain('level')
    })

    it('returns message for empty sections', () => {
      const result = gdrive.formatSections([])
      expect(result).toBe('No sections found.')
    })

    it('indents nested sections correctly', () => {
      const sections = [
        {
          heading: 'H1',
          level: 1 as const,
          content: 'content',
          byteStart: 0,
        },
        {
          heading: 'H2',
          level: 2 as const,
          content: 'content',
          byteStart: 10,
        },
        {
          heading: 'H3',
          level: 3 as const,
          content: 'content',
          byteStart: 20,
        },
      ]

      const result = gdrive.formatSections(sections)
      const lines = result.split('\n')
      expect(lines[0]).not.toMatch(/^\s+/)
      expect(lines[1]).toMatch(/^\s{2}/)
      expect(lines[2]).toMatch(/^\s{4}/)
    })
  })

  describe('getSectionContent', () => {
    it('returns content of named section', async () => {
      const docText = `# **Intro** {#intro}
Intro text.

# **Main** {#main}
Main content here.

# **End** {#end}
Final stuff.
`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const content = await gdrive.getSectionContent('doc-id', 'Main')
      expect(content).toBe('Main content here.')
    })

    it('is case-insensitive', async () => {
      const docText = `# **Getting Started** {#getting-started}
Installation steps.
`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const content = await gdrive.getSectionContent('case-id', 'getting started')
      expect(content).toBe('Installation steps.')
    })

    it('returns null for missing section', async () => {
      const docText = `# **One** {#one}
Content.
`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => docText,
      } as Response)

      const content = await gdrive.getSectionContent('missing-id', 'Missing')
      expect(content).toBeNull()
    })
  })
})
