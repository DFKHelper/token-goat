/** JSONC (JSON with line and block comments and trailing commas) support shared by the MCP bridge writers and the JSON read commands. tsconfig.json, jsconfig.json, VS Code settings and devcontainer.json are JSONC in practice: `tsc --init` writes comments and a trailing comma into every tsconfig it creates. */
import { createRequire } from 'node:module'
import type { ParseError } from 'jsonc-parser'
import type * as JsoncParser from 'jsonc-parser'

// Loaded on first use, not at module scope: cli.ts statically imports the bridge modules, so a top-level require here would run on every invocation of the binary, including every hook and every `--version`.
let jsoncParser: typeof JsoncParser | undefined
export function jsonc(): typeof JsoncParser {
  jsoncParser ??= createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser
  return jsoncParser
}

// jsonc-parser's SyntaxKind is a `const enum`, which verbatimModuleSyntax cannot read through a type-only import; these are its published values.
const CLOSE_BRACE = 2
const CLOSE_BRACKET = 4
const COMMA = 5
const LINE_COMMENT = 12
const BLOCK_COMMENT = 13
const LINE_BREAK = 14
const WHITESPACE = 15
const EOF = 17

/** Rewrites valid JSONC as strict JSON by dropping comments and trailing commas. Tokens are copied as raw source slices, never through the scanner's decoded token value, so string literals and their escapes survive byte-for-byte. */
function jsoncToJson(text: string): string {
  const scanner = jsonc().createScanner(text, false)
  const out: string[] = []
  let heldComma = false
  let heldTrivia: string[] = []
  for (let kind = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    if (kind === LINE_COMMENT || kind === BLOCK_COMMENT) continue
    const raw = text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength())
    if (heldComma) {
      if (kind === LINE_BREAK || kind === WHITESPACE) {
        heldTrivia.push(raw)
        continue
      }
      if (kind !== CLOSE_BRACE && kind !== CLOSE_BRACKET) out.push(',')
      out.push(...heldTrivia)
      heldComma = false
      heldTrivia = []
    }
    if (kind === COMMA) heldComma = true
    else out.push(raw)
  }
  if (heldComma) out.push(',', ...heldTrivia)
  return out.join('')
}

/** Drops one leading U+FEFF. Windows editors (Notepad, PowerShell 5 `Set-Content -Encoding UTF8`, Visual Studio's "UTF-8 with signature") save JSON with a byte-order mark that `JSON.parse` and jsonc-parser both reject, while the hosts that own these files read them fine. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Recognizes tool output overflow/preview preambles (e.g. Copilot CLI "Output too large to read at once... Preview (first 500 chars):"). */
const TOOL_PREAMBLE_RE = /(?:output too large|preview \(first|\bpreview:|\bcontent preview:)/i

/** Extracts embedded JSON/JSONC when tool outputs wrap content in text preambles (e.g. Copilot CLI "Output too large to read at once... Preview (first 500 chars):"). */
function extractEmbeddedJson(text: string): string | null {
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  let startIdx = -1
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket)
  } else if (firstBrace !== -1) {
    startIdx = firstBrace
  } else if (firstBracket !== -1) {
    startIdx = firstBracket
  }
  if (startIdx <= 0) return null

  // Ensure the preamble looks like tool output or preview text, not arbitrary broken source or commented files
  const preamble = text.slice(0, startIdx)
  if (!TOOL_PREAMBLE_RE.test(preamble) && !preamble.includes('---') && !preamble.includes('===')) {
    return null
  }

  const candidate = text.slice(startIdx).trim()
  if ((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']'))) {
    return candidate
  }
  return null
}

/** Parses strict JSON with `JSON.parse`, falling back to JSONC only when the strict parse fails and the text is otherwise well-formed JSONC. The fallback still ends in `JSON.parse`, so a `__proto__` key stays an own property and a duplicate key keeps its last value, exactly as for strict JSON. Text that is not valid JSONC rethrows the strict parser's error, so a broken file reports the same message it always did. Pass `allowTrailingComma: false` for a consumer that strips comments but still parses with strict `JSON.parse` (Gemini CLI, Qwen Code), so a trailing comma is refused just as that consumer refuses it. */
export function parseJsonOrJsonc(raw: string, opts: { allowTrailingComma?: boolean } = {}): unknown {
  const text = stripBom(raw)
  try {
    return JSON.parse(text) as unknown
  } catch (strictError) {
    // 1. Try full JSONC parse on text first, so leading block comments with braces/brackets don't fool embedded extraction.
    const fullErrors: ParseError[] = []
    jsonc().parse(text, fullErrors, { allowTrailingComma: opts.allowTrailingComma !== false, disallowComments: false, allowEmptyContent: false })
    if (fullErrors.length === 0) {
      try {
        return JSON.parse(jsoncToJson(text)) as unknown
      } catch {
        // Fall through to embedded extraction if full JSONC parse failed during JSON conversion
      }
    }

    // 2. Fall back to embedded JSON/JSONC extraction for tool previews with preambles
    const embedded = extractEmbeddedJson(text)
    if (embedded !== null) {
      try {
        return JSON.parse(embedded) as unknown
      } catch {
        const embeddedErrors: ParseError[] = []
        jsonc().parse(embedded, embeddedErrors, { allowTrailingComma: opts.allowTrailingComma !== false, disallowComments: false, allowEmptyContent: false })
        if (embeddedErrors.length === 0) {
          try {
            return JSON.parse(jsoncToJson(embedded)) as unknown
          } catch {
            // Fall through to throwing strictError
          }
        }
      }
    }

    throw strictError
  }
}
