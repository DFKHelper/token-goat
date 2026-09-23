// GenericFilter: the catch-all fallback used when no per-tool filter matches but the hook layer still decided to wrap a command. With no tool-specific structure to exploit, it removes the universal noise sources (ANSI / progress strip already done by `apply`, plus consecutive-line dedupe) and caps the result to ~2000 tokens.

import { ToolFilter } from './base.js'
import { capTokens, dedupeConsecutive } from './helpers.js'

// Leaves the output exactly as the command printed it, for a caller that wants `--max-tokens` and nothing else. The runner falls back to it when no filter matches, and the Bash hook names it for an inline interpreter file read, whose output is a file's contents: the Python filter folds repeated lines, which is right for a traceback and silently drops rows of a data file.
export class PassthroughFilter extends ToolFilter {
  readonly name = 'passthrough'
}

export class GenericFilter extends ToolFilter {
  readonly name = 'generic'

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const outLines = dedupeConsecutive(stdout.split('\n'), { entropyBypass: true })
    const errLines = dedupeConsecutive(stderr.split('\n'), { entropyBypass: true })
    let result: string
    if (stderr.trim()) {
      const outPart = outLines.join('\n').replace(/\s+$/, '')
      const errPart = errLines.join('\n').replace(/\s+$/, '')
      result = outPart ? `${outPart}\n---\n${errPart}` : errPart
    } else {
      result = outLines.join('\n')
    }
    // Cap token-aware output to ~2000 tokens (~7 KB).
    return capTokens(result, 2000)
  }
}
