/** html-to-text v10 ships no bundled types and @types/html-to-text is stuck
 * on v9 (a real, drifting mismatch risk); this is a narrow ambient
 * declaration covering only the options this project actually passes. */
declare module 'html-to-text' {
  export interface HtmlToTextOptions {
    wordwrap?: number | false
    selectors?: Array<{
      selector: string
      format?: string
      options?: Record<string, unknown>
    }>
  }

  export function htmlToText(html: string, options?: HtmlToTextOptions): string
}
