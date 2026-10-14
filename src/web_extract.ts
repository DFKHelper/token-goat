/** HTML -> clean text extraction for fetched web content, so a `WebFetch` body never lands in context as raw markup. Mirrors {@link ./image_shrink.js}'s "shrink before it reaches the model" contract, applied to text instead of pixels. */

import { htmlToText } from 'html-to-text'

import { MAX_CAPTURE_BYTES } from './bash_runner.js'

const SNIFF_BYTES = 512
const HTML_SNIFF_RE = /<html[\s>]|<!doctype\s+html|<body[\s>]/i

/** No content-type header is available at the hook layer (only the raw body text) so sniffing the head of the body is the only signal available. */
export function looksLikeHtml(body: string): boolean {
  return HTML_SNIFF_RE.test(body.slice(0, SNIFF_BYTES))
}

/** `maxInputLength` is html-to-text's own input cap, which it enforces by cutting the input short with no marker. Its default of 1 << 24 sat below what a Bash capture can hold, so a larger page was cut before any caller could redact the text, and a cut through a credential leaves a fragment shorter than its pattern recognizes. The default here is never below {@link MAX_CAPTURE_BYTES} and never below the input's own length: a capture bounds the characters of what a command printed, since a string never has more UTF-16 code units than its UTF-8 encoding has bytes, but a caller redacts before it extracts, and a placeholder can be longer than the credential it replaced (`[REDACTED:aws_access_key]` is 25 characters for a 20-character key), so the input can outgrow the capture. A test passes a smaller one to reach the cut without a 16 MB page. */
export function extractCleanText(html: string, maxInputLength = Math.max(MAX_CAPTURE_BYTES, html.length)): string {
  return htmlToText(html, {
    wordwrap: false,
    limits: { maxInputLength },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  }).trim()
}
