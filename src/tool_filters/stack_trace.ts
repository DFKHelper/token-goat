const STACK_FRAME_PREFIX_RE = /^\s*(?:at\s+|❯\s+|File\s+["'])/
const EXTERNAL_FRAME_RE =
  /(?:node_modules[\\/]|node:internal[\\/]|site-packages[\\/]|dist-packages[\\/]|System\.)/i

export function isExternalStackTraceFrame(line: string): boolean {
  return STACK_FRAME_PREFIX_RE.test(line) && EXTERNAL_FRAME_RE.test(line)
}

export function externalStackFrameNote(count: number): string {
  return `  [token-goat: collapsed ${count} external stack frame${count === 1 ? '' : 's'}]`
}
