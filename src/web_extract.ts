/**
 * HTML -> clean text extraction for fetched web content, so a `WebFetch` body
 * never lands in context as raw markup. Mirrors {@link ./image_shrink.js}'s
 * "shrink before it reaches the model" contract, applied to text instead of
 * pixels.
 */

import { htmlToText } from 'html-to-text'

const SNIFF_BYTES = 512
const HTML_SNIFF_RE = /<html[\s>]|<!doctype\s+html|<body[\s>]/i

/** No content-type header is available at the hook layer (only the raw body
 * text) so sniffing the head of the body is the only signal available. */
export function looksLikeHtml(body: string): boolean {
  return HTML_SNIFF_RE.test(body.slice(0, SNIFF_BYTES))
}

export function extractCleanText(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  }).trim()
}
