/** `text` with the nonce taken out of every fence tag, so a test can compare a fenced output with tags written as `<untrusted-tool-output>`: each fence draws its nonce at random when it is built, so no expected string can hold it. Only a tag the builders write is rewritten, `<untrusted-...` then ` nonce=` and twelve hex digits, so a forged tag in the fenced bytes, escaped or not, is left as it was. */
export function withoutFenceNonces(text: string): string {
  return text.replace(/(<\/?untrusted-[a-z]+(?:-[a-z]+)*) nonce=[0-9a-f]{12}>/g, '$1>')
}

/** The nonce of the first fence tag in `text`, or undefined when it has none. */
export function fenceNonce(text: string): string | undefined {
  return /<untrusted-[a-z]+(?:-[a-z]+)* nonce=([0-9a-f]{12})>/.exec(text)?.[1]
}
