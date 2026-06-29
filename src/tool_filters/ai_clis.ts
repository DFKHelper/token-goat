// AI-CLI streaming assistant filter family (Batch I): AiderFilter,
// GhCopilotFilter, CopilotFilter, GeminiCliFilter, ClaudeCliFilter,
// CursorFilter, WindsurfFilter, OpenCodeFilter, ContinueFilter,
// ClineFilter, CodexExecFilter.
//
// Faithfully ported from the Python bash_compress.py AI-CLI family
// (git ref 2098981^).  All filters use the makeAiCliFilter factory except
// CodexExecFilter, which has a completely different structural algorithm
// (two-separator header extraction + role-label transcript parsing) and
// is therefore a bespoke ToolFilter subclass.
//
// DISPATCH ORDERING: GhCopilotFilter must precede GhRunLogFilter and
// GhFilter (all three match the `gh` binary, but GhCopilotFilter only fires
// for `gh copilot explain/suggest`).  AI_CLI_FILTERS is therefore spread
// BEFORE CI_FILTERS in dispatch.ts, overriding the naive "append at end"
// placement.

import { ToolFilter } from './base.js'
import { makeAiCliFilter } from './families.js'
import { ERROR_SIGNAL_RE, pathStem, pathName, positionalArgs } from './helpers.js'

// ---------------------------------------------------------------------------
// Shared regex constants — GhCopilot / Copilot (standalone)
// ---------------------------------------------------------------------------
const _GH_COPILOT_SPINNER_RE = /^\s*(?:Asking GitHub Copilot|Generating|Thinking|Fetching)\s*\.{0,3}\s*$/i
const _GH_COPILOT_BANNER_RE = /^\s*(?:Welcome to GitHub Copilot|Using GitHub Copilot|Authenticated as|GitHub Copilot\s+v\d+)/i
const _GH_COPILOT_DISCLAIMER_RE = /^\s*(?:Disclaimer:|This response was|GitHub Copilot|The commands?\s+(?:above|below)|Please review|Always review|Remember to|Note:|Tip:)/i

// ---------------------------------------------------------------------------
// Aider
// ---------------------------------------------------------------------------
const _AIDER_APPLYING_RE = /^\s*(?:Applying\s+edit(?:s)?(?:\s+to\s+\S+)?|Applied\s+edit\s+to\s+\S+)\s*\.{0,3}\s*$/i
const _AIDER_TOKENS_RE = /^\s*Tokens:\s+\d[\d,]*\s+sent,\s+\d[\d,]*\s+received/i
const _AIDER_COST_RE = /^\s*Cost:\s+\$[\d.]+\s+message,\s+\$[\d.]+\s+session/i
const _AIDER_REPOMAP_RE = /^\s*(?:Repo-map:|Added\s+\S+\s+to\s+the\s+chat|Removed\s+\S+\s+from\s+the\s+chat|Loading\s+repo\s+map|Updating\s+repo\s+map|Scanning\s+repo\s+contents|Using\s+\d+\s+tokens\s+of\s+repo\s+map)/i
const _AIDER_BANNER_RE = /^\s*aider\s+v\d+\.\d+/i
const _AIDER_FOOTER_NOISE_RE = /^\s*(?:Use\s+ctrl-c|Run\s+with\s+--help|You\s+can\s+skip\s+this|Tip:|Note:)/i

// ---------------------------------------------------------------------------
// Copilot (standalone binary)
// ---------------------------------------------------------------------------
const _COPILOT_WORKSPACE_NOISE_RE = /^\s*(?:Starting\s+Copilot\s+workspace|Loading\s+model:|Copilot\s+workspace\s+(?:starting|loaded|ready)|Streaming\.\.\.|▌\s*$|Turn\s+\d+\s*:)/i
const _COPILOT_COMPLETION_STATS_RE = /^\s*(?:Completion\s+tokens:|Prompt\s+tokens:|Total\s+tokens:|Input\s+tokens:|Output\s+tokens:)\s*\d/i

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------
const _GEMINI_STARTUP_RE = /^\s*(?:[✓✗►]|>)\s*(?:Model:|Theme:|Tools:|Sandbox:|Checkpointing:|Context(?:\s+limit)?:|Version:|Authenticated(?:\s+as)?:|Connecting)/i
const _GEMINI_BANNER_RE = /^\s*Gemini\s+CLI\s+v\d+/i
const _GEMINI_TOKEN_METER_RE = /^\s*(?:Token\s+usage|Context|Tokens):\s+[\d,]+\s*\/\s*[\d,]+/i
const _GEMINI_TOOL_SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗►✦]\s+(?:Call(?:ing|ed)|Execut(?:ing|ed)|Running)\s+\S+/
const _GEMINI_FOOTER_RE = /^\s*(?:Type\s+\/help|Press\s+Ctrl|Use\s+Ctrl|Tip:|Note:)/i
const _GEMINI_THINKING_RE = /^\s*(?:Thinking|Generating|Processing)\s*\.{0,3}\s*$/i

// ---------------------------------------------------------------------------
// Claude CLI
// ---------------------------------------------------------------------------
const _CLAUDE_CLI_MODEL_HDR_RE = /^\s*[◆◇►✦]\s+claude-/i
const _CLAUDE_CLI_STATS_RE = /^\s*[↑↓⇑⇓]\s*\d[\d,]*\s*[↑↓⇑⇓]?\s*\d[\d,]*\s*tokens/i
const _CLAUDE_CLI_CONTEXT_RE = /^\s*(?:Context(?:\s+window)?|Token\s+limit):\s+[\d,]+\s*\/\s*[\d,]+/i
const _CLAUDE_CLI_FOOTER_RE = /^\s*(?:Press\s+Ctrl|Enter\s+\/|Type\s+\/|Use\s+Ctrl|Tip:|Note:)/i
const _CLAUDE_CLI_SPINNER_RE = /^\s*[◎⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(?:Thinking|Generating|Processing|Running)\s*\.{0,3}\s*$/
const _CLAUDE_CLI_TOOL_LOG_RE = /^\s*(?:>\s+Using\s+tool:|✓\s+Tool\s+result:|◎\s+Tool:)/i
const _CLAUDE_CLI_SKIP_SUBCMDS = new Set(['install', 'update', 'doctor', 'config', 'login', 'logout'])

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
const _CURSOR_STARTUP_RE = /^\s*(?:Extension\s+host\s+(?:started|starting)|Extension\s+'cursor[^']*'\s+activated|Starting\s+debug\s+adapter|Opening\s+folder\s*\.*\s*$|Restoring\s+(?:windows?|session)|Reusing\s+existing\s+extension\s+host|Connection\s+(?:established|to\s+remote)|Tunnel\s+(?:connected|connecting|status))/i
const _CURSOR_TELEMETRY_RE = /^\s*(?:Telemetry\s+is\s+(?:disabled|enabled)|Crash\s+reporter|Sending\s+telemetry|Analytics:)/i
const _CURSOR_BANNER_RE = /^\s*Cursor\s+v?\d+\.\d+/i

// ---------------------------------------------------------------------------
// Windsurf
// ---------------------------------------------------------------------------
const _WINDSURF_STARTUP_RE = /^\s*(?:Extension\s+host\s+(?:started|starting)|Extension\s+'\S+'\s+activated|Starting\s+debug\s+adapter|Opening\s+folder\s*\.*\s*$|Restoring\s+(?:windows?|session)|Reusing\s+existing\s+extension\s+host)/i
const _WINDSURF_CODEIUM_NOISE_RE = /^\s*(?:Codeium\s*(?::\s*)?(?:Activating|Activated|index(?:ing)?:?\s*loading|index\s+(?:loaded|ready)|Extension\s+loaded)|Connecting\s+to\s+Codeium\s+server|Authentication\s+status\s*:|Model\s+status\s*:|Codeium\s+(?:ready|connected|disconnected))/i
const _WINDSURF_BANNER_RE = /^\s*Windsurf\s+v?\d+\.\d+/i
const _WINDSURF_TELEMETRY_RE = /^\s*(?:Telemetry\s+is\s+(?:disabled|enabled)|Crash\s+reporter)/i
const _WINDSURF_CASCADE_STATUS_RE = /^\s*(?:Cascade\s*(?::\s*)?(?:connected|disconnected|ready|connecting|starting|model\s+loaded|indexing\s+workspace|context\s+limit|[a-z]+\.{3})|Cascade\s+v?\d+|AI\s+assistant\s+(?:ready|loaded|connecting))/i
const _WINDSURF_CASCADE_TOOL_RE = /^\s*Cascade\s+(?:is\s+)?(?:reading|writing|running|executed|modified|created|deleted)\s+/i
const _WINDSURF_CASCADE_SPINNER_RE = /^\s*(?:Thinking|Generating|Cascade\s+is\s+thinking|Processing\s+request)\s*\.{0,3}\s*$/i
const _WINDSURF_CONTEXT_RE = /^\s*(?:Context(?:\s+window)?|Token\s+(?:usage|count))\s*:\s*[\d,]+\s*\/\s*[\d,]+/i
const _WINDSURF_WORKSPACE_RE = /^\s*(?:Loading\s+workspace|Indexing\s+workspace|Workspace\s+(?:indexed|ready|loading)|Scanning\s+files|File\s+watcher)/i

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------
const _OPENCODE_BANNER_RE = /^\s*(?:Open[Cc]ode|opencode)\s+v?\d+\.\d+/i
const _OPENCODE_PROVIDER_RE = /^\s*Provider\s*:\s*\S/i
const _OPENCODE_MODEL_RE_KL = /^\s*Model\s*:\s*\S/i
const _OPENCODE_MODE_RE = /^\s*Mode\s*:\s*\S/i
const _OPENCODE_CONTEXT_RE = /^\s*Context\s*:\s*[\d,]+\s*\/\s*[\d,]+/i
const _OPENCODE_TOOL_CALL_RE = /^\s*(?:→|->)\s+\w+\s*\(/
const _OPENCODE_TOOL_RESULT_RE = /^\s*(?:←|<-)\s+\S.*\(\d+\s+chars?\)/
const _OPENCODE_SPINNER_RE = /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\.{2,})\s*$/
const _OPENCODE_SESSION_SAVE_RE = /^\s*Session\s+saved\s+to\s+\S+/i

// ---------------------------------------------------------------------------
// Continue
// ---------------------------------------------------------------------------
const _CONTINUE_INDEXING_RE = /^\s*Indexing\s*:\s*\d+\s*\/\s*\d+\s*files?/i
const _CONTINUE_MODEL_LOAD_RE = /^\s*Loading\s+model\s*:\s*\S/i
const _CONTINUE_CONFIG_RE = /^\s*Config\s+(?:loaded\s+from|reloaded|initializ)/i
const _CONTINUE_TOKENS_RE = /^\s*Tokens\s*:\s*\d[\d,]*\s+prompt,\s+\d[\d,]*\s+completion/i
const _CONTINUE_BANNER_RE = /^\s*Continue(?:\.dev)?\s+v?\d+\.\d+/i

// ---------------------------------------------------------------------------
// Cline
// ---------------------------------------------------------------------------
const _CLINE_BANNER_RE = /^\s*(?:Cline|claude-dev)\s+v\d+\.\d+/i
const _CLINE_TOKENS_RE = /^\s*Tokens\s*:\s*[\d,]+\s*\(/i
const _CLINE_COST_RE = /^\s*API\s+Cost\s*:\s*\$[\d.]+/i
const _CLINE_CONTEXT_RE = /^\s*Context\s+Window\s*:\s*[\d,]+\s*\/\s*[\d,]+\s+tokens/i
const _CLINE_SPINNER_RE = /^\s*(?:Thinking|Processing|Streaming\s+response)\s*\.{0,3}\s*$/i
const _CLINE_STARTUP_RE = /^\s*(?:Loading\s+workspace|Initializing\s+Cline|Starting\s+Cline)\s*\.{0,3}\s*$/i
const _CLINE_MCP_STATUS_RE = /^\s*MCP\s+Server\s+['"]?\w/i
const _CLINE_FILE_READ_RE = /^\s*Reading\s+file\s*:\s*\S+\s*\.{0,3}\s*$/i
const _CLINE_WANTS_EXECUTE_RE = /^\s*Cline\s+wants\s+to\s+(?:execute|run|write|read|create|delete|use)\s*:/i

// ---------------------------------------------------------------------------
// Codex (bespoke — structural algorithm; see CodexExecFilter below)
// ---------------------------------------------------------------------------
const _CODEX_SEPARATOR_RE = /^-{4,}$/
const _CODEX_MODEL_RE = /^model\s*:\s*(?<model>\S+)/i
const _CODEX_TOKENS_USED_RE = /^tokens used$/i

// ===========================================================================
// Filter instances
// ===========================================================================

export const ghCopilotFilter = makeAiCliFilter({
  name: 'gh-copilot',
  binaries: ['gh'],
  dropRules: [_GH_COPILOT_SPINNER_RE, _GH_COPILOT_BANNER_RE, _GH_COPILOT_DISCLAIMER_RE],
  droppedNoiseNote: (n) => `dropped ${n} boilerplate/disclaimer line(s)`,
  // GhCopilotFilter only fires for `gh copilot explain/suggest`; the broader
  // GhFilter in CI_FILTERS claims all other `gh` commands.
  customMatches: (argv: string[]): boolean => {
    if (!argv.length) return false
    const first = argv[0]!
    const stem = pathStem(first).toLowerCase()
    const name = pathName(first).toLowerCase()
    if (stem !== 'gh' && name !== 'gh') return false
    const pos = positionalArgs(argv.slice(1))
    return pos.length >= 2 && pos[0] === 'copilot' && (pos[1] === 'explain' || pos[1] === 'suggest')
  },
})

export const copilotFilter = makeAiCliFilter({
  name: 'copilot',
  binaries: ['copilot'],
  dropRules: [_COPILOT_WORKSPACE_NOISE_RE, _GH_COPILOT_SPINNER_RE, _GH_COPILOT_BANNER_RE, _GH_COPILOT_DISCLAIMER_RE],
  keepLastRules: [{ re: _COPILOT_COMPLETION_STATS_RE, note: (v) => `stats: ${v}` }],
  droppedNoiseNote: (n) => `dropped ${n} boilerplate/disclaimer line(s)`,
})

export const aiderFilter = makeAiCliFilter({
  name: 'aider',
  binaries: ['aider'],
  dropRules: [_AIDER_REPOMAP_RE, _AIDER_BANNER_RE, _AIDER_FOOTER_NOISE_RE],
  countedRules: [
    {
      re: _AIDER_APPLYING_RE,
      position: 'prepend',
      note: (n) =>
        `[token-goat: ${n} 'applying edits' progress line(s) collapsed; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
    },
  ],
  keepLastRules: [
    { re: _AIDER_TOKENS_RE, note: (v) => `token usage: ${v}` },
    { re: _AIDER_COST_RE, note: (v) => `cost: ${v}` },
  ],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
})

export const geminiCliFilter = makeAiCliFilter({
  name: 'gemini-cli',
  binaries: ['gemini'],
  dropRules: [_GEMINI_BANNER_RE, _GEMINI_THINKING_RE, _GEMINI_FOOTER_RE],
  countedRules: [
    {
      re: _GEMINI_STARTUP_RE,
      position: 'prepend',
      note: (n) =>
        `[token-goat: ${n} Gemini CLI startup status line(s) collapsed; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
    },
    {
      re: _GEMINI_TOOL_SPINNER_RE,
      position: 'prepend',
      note: (n) => `[token-goat: ${n} tool-call spinner line(s) collapsed]`,
    },
  ],
  keepLastRules: [{ re: _GEMINI_TOKEN_METER_RE, note: (v) => `context: ${v}` }],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
})

export const claudeCliFilter = makeAiCliFilter({
  name: 'claude-cli',
  binaries: ['claude'],
  dropRules: [_CLAUDE_CLI_MODEL_HDR_RE, _CLAUDE_CLI_SPINNER_RE, _CLAUDE_CLI_FOOTER_RE],
  countedRules: [
    {
      re: _CLAUDE_CLI_TOOL_LOG_RE,
      position: 'note',
      note: (n) => `collapsed ${n} tool-call log line(s)`,
    },
  ],
  keepLastRules: [
    { re: _CLAUDE_CLI_STATS_RE, note: (v) => `stats: ${v}` },
    { re: _CLAUDE_CLI_CONTEXT_RE, note: (v) => `context: ${v}` },
  ],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
  // Exact 'claude' stem only; skip management subcommands (install, update, etc.)
  customMatches: (argv: string[]): boolean => {
    if (!argv.length) return false
    if (pathStem(argv[0]!).toLowerCase() !== 'claude') return false
    const pos = positionalArgs(argv.slice(1))
    return !(pos.length > 0 && _CLAUDE_CLI_SKIP_SUBCMDS.has(pos[0]!))
  },
})

export const cursorFilter = makeAiCliFilter({
  name: 'cursor',
  binaries: ['cursor'],
  dropRules: [_CURSOR_BANNER_RE, _CURSOR_STARTUP_RE, _CURSOR_TELEMETRY_RE],
  droppedNoiseNote: (n) => `dropped ${n} startup/telemetry noise line(s)`,
})

export const windsurfFilter = makeAiCliFilter({
  name: 'windsurf',
  binaries: ['windsurf'],
  dropRules: [
    _WINDSURF_BANNER_RE,
    _WINDSURF_STARTUP_RE,
    _WINDSURF_CODEIUM_NOISE_RE,
    _WINDSURF_TELEMETRY_RE,
    _WINDSURF_CASCADE_STATUS_RE,
    _WINDSURF_CASCADE_SPINNER_RE,
    _WINDSURF_WORKSPACE_RE,
  ],
  countedRules: [
    {
      re: _WINDSURF_CASCADE_TOOL_RE,
      position: 'note',
      note: (n) =>
        `collapsed ${n} Cascade tool-call line(s); disable via TOKEN_GOAT_BASH_COMPRESS for full output`,
    },
  ],
  keepLastRules: [{ re: _WINDSURF_CONTEXT_RE, note: (v) => `context: ${v}` }],
  droppedNoiseNote: (n) => `dropped ${n} startup/activation noise line(s)`,
})

export const openCodeFilter = makeAiCliFilter({
  name: 'opencode',
  binaries: ['opencode'],
  dropRules: [_OPENCODE_BANNER_RE, _OPENCODE_MODE_RE, _OPENCODE_SPINNER_RE, _OPENCODE_SESSION_SAVE_RE],
  countedRules: [
    {
      // Tool calls and tool results share a single counter.
      res: [_OPENCODE_TOOL_CALL_RE, _OPENCODE_TOOL_RESULT_RE],
      position: 'append',
      note: (n) =>
        `[token-goat: ${n} tool call/result line(s) collapsed; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
    },
  ],
  keepLastRules: [
    { re: _OPENCODE_PROVIDER_RE, note: (v) => `provider: ${v}` },
    { re: _OPENCODE_MODEL_RE_KL, note: (v) => `model: ${v}` },
    { re: _OPENCODE_CONTEXT_RE, note: (v) => `context: ${v}` },
  ],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
})

export const continueFilter = makeAiCliFilter({
  name: 'continue',
  binaries: ['continue'],
  dropRules: [_CONTINUE_BANNER_RE, _CONTINUE_MODEL_LOAD_RE, _CONTINUE_CONFIG_RE],
  countedRules: [
    {
      re: _CONTINUE_INDEXING_RE,
      position: 'append',
      keepLast: true,
      note: (n, last) => {
        const summary = last ?? `${n} indexing progress line(s)`
        return `[token-goat: ${n} indexing progress line(s) collapsed; last: ${summary}; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`
      },
    },
  ],
  keepLastRules: [{ re: _CONTINUE_TOKENS_RE, note: (v) => `tokens: ${v}` }],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
})

export const clineFilter = makeAiCliFilter({
  name: 'cline',
  binaries: ['cline', 'claude-dev'],
  alwaysKeepRe: _CLINE_WANTS_EXECUTE_RE,
  dropRules: [_CLINE_BANNER_RE, _CLINE_SPINNER_RE, _CLINE_STARTUP_RE, _CLINE_MCP_STATUS_RE],
  countedRules: [
    {
      re: _CLINE_FILE_READ_RE,
      position: 'append',
      note: (n) =>
        `[token-goat: ${n} file-read progress line(s) collapsed; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
    },
  ],
  keepLastRules: [
    { re: _CLINE_TOKENS_RE, note: (v) => `tokens: ${v}` },
    { re: _CLINE_COST_RE, note: (v) => `cost: ${v}` },
    { re: _CLINE_CONTEXT_RE, note: (v) => `context: ${v}` },
  ],
  droppedNoiseNote: (n) => `dropped ${n} noise line(s)`,
})

// ---------------------------------------------------------------------------
// CodexExecFilter — bespoke structural algorithm
//
// Codex output has a distinctive two-separator header block followed by a
// role-labelled transcript. The algorithm:
//   1. Scan the first 20 lines for two `--------` separators.
//   2. Bail (passthrough) if fewer than two separators are found.
//   3. Extract the model name from the config block between the separators.
//   4. Find the last "codex" role label after the second separator.
//   5. Scan backward (last 6 lines from the last codex label) for a
//      "tokens used" footer and capture the count on the next non-blank line.
//   6. Extract the answer body between the last codex label and the footer.
//   7. Emit `[codex: model=X, tokens=Y]` followed by the answer body.
// ---------------------------------------------------------------------------

export class CodexExecFilter extends ToolFilter {
  readonly name = 'codex-exec'
  override readonly binaries = new Set(['codex'])
  override readonly errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    if (!combined.trim()) return combined

    const lines = combined.split('\n')

    // Find two separator lines in the first 20 lines
    let firstSepIdx: number | null = null
    let secondSepIdx: number | null = null
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      if (_CODEX_SEPARATOR_RE.test((lines[i] ?? '').trim())) {
        if (firstSepIdx === null) firstSepIdx = i
        else {
          secondSepIdx = i
          break
        }
      }
    }
    if (firstSepIdx === null || secondSepIdx === null) return combined // unrecognised format

    // Extract model from config block between the two separators
    let model = 'unknown'
    for (const ln of lines.slice(firstSepIdx + 1, secondSepIdx)) {
      const m = ln.trim().match(_CODEX_MODEL_RE)
      if (m?.groups?.['model']) {
        model = m.groups['model']!
        break
      }
    }

    // Find the last 'codex' role label after the second separator
    let lastCodexIdx: number | null = null
    for (let i = secondSepIdx + 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim().toLowerCase() === 'codex') lastCodexIdx = i
    }
    if (lastCodexIdx === null) return combined // no role label found

    // Scan backward for 'tokens used' footer (last 6 lines from end of transcript)
    let tokensLineIdx: number | null = null
    let tokensCount = '?'
    const searchFloor = Math.max(lastCodexIdx + 1, lines.length - 6)
    for (let i = lines.length - 1; i >= searchFloor; i--) {
      if (_CODEX_TOKENS_USED_RE.test((lines[i] ?? '').trim())) {
        tokensLineIdx = i
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const candidate = (lines[j] ?? '').trim()
          if (candidate) {
            tokensCount = candidate
            break
          }
        }
        break
      }
    }

    // Extract answer: from last codex label to the tokens footer (or end)
    const answerEnd = tokensLineIdx !== null ? tokensLineIdx : lines.length
    let answerLines = lines.slice(lastCodexIdx + 1, answerEnd)
    while (answerLines.length && !(answerLines[0] ?? '').trim()) answerLines = answerLines.slice(1)
    while (answerLines.length && !(answerLines[answerLines.length - 1] ?? '').trim()) {
      answerLines = answerLines.slice(0, -1)
    }

    const summary = `[codex: model=${model}, tokens=${tokensCount}]`
    return this.finalize([summary, ...answerLines])
  }
}

export const codexExecFilter = new CodexExecFilter()

// ===========================================================================
// Ordered registry for this batch
// ===========================================================================

/**
 * AI-CLI filter batch. Must be spread BEFORE CI_FILTERS in TOOL_FILTERS so
 * that GhCopilotFilter (matching `gh copilot explain/suggest`) takes
 * precedence over the broader GhFilter that claims all `gh` commands.
 */
export const AI_CLI_FILTERS: ToolFilter[] = [
  // GhCopilotFilter and CopilotFilter co-located; GhCopilotFilter MUST precede
  // GhRunLogFilter and GhFilter in TOOL_FILTERS (see dispatch.ts comment).
  ghCopilotFilter,
  copilotFilter,
  aiderFilter,
  geminiCliFilter,
  claudeCliFilter,
  cursorFilter,
  windsurfFilter,
  openCodeFilter,
  continueFilter,
  clineFilter,
  codexExecFilter,
]

// Re-export ERROR_SIGNAL_RE so consumers can reference the same constant
// without importing helpers directly.
export { ERROR_SIGNAL_RE }
