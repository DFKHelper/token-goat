/** pre_tool_use hook for the Bash tool. When a build tool command (cargo, go, mvn, make, etc.) is about to run and its output is already cached in the session bash-output store, inject a recall hint so the model can inspect cached output instead of re-running the command. The post_tool_use half is hooks_bash_post.ts. */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { leadWithCommand, docSectionHint, quotedArg, quotedArgs, stripUnsafeSuggestions } from './hint_suggestion_guard.js'
import { contextOutput, denyOutput, passOutput, getCwd } from './hooks_common.js'
import { applyHintTracking, classifyBashHint, meetsSavingsFloor, logSuppressedDetection } from './hint_stats.js'
import type { HookOutput } from './types.js'
import { getBashOutputId, getCurlDownloadPath, clearCurlDownload, dropFileLineRangesIfChanged, getFileLineRanges, recordBashStartCwd, recordFileLineRange, wasHintShown, markHintShown, wasCliReadThisSession, wasFileReadThisSession } from './session.js'
import { resolveIndexPath, displaySafePath, hostPathOfTypedPath, isFileAtIndexKey } from './paths.js'
import { shortFingerprint } from './fingerprint.js'
import { isBuildCommand, getMonitoringRecallHint, isTestRunnerCommand } from './hints/lang_patterns.js'
import { getBashOutput, isBashEntryStale, isScopedGitStatusOrDiffStatCommand } from './bash_output_cache.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { loadConfig } from './config.js'
import { detectHarness } from './bridges/registry.js'
import { detectFromCommand, hasBareBackground } from './tool_filters/index.js'
import { canRunWrappedShell, canRunPowerShell } from './shell.js'
import { detectStructuralIndexRewrite } from './bash_structural_index.js'
import { agentTypeOf, loadCodexRules, loadingHiddenRuleCheck, permissionNeutralRewrite, readHintCrossesRule, shellPathWords } from './rewrite_permission.js'
import { rangeSubstituteFor } from './bash_range_savings.js'
import { hintTarget, sliceCommand, sliceForPath, type HintSlice, type HintTarget } from './hint_target.js'
import { statSync, existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  stripCdPrefix,
  stripCommandPrefix,
  stripSubshellGroup,
  stripTrailingStderrRedirect,
  hasTestRunScopeOrBudget,
  isDirectTestRunnerCommand,
  resolveCdHintPath,
  cdPrefixCwd,
  commandRunDir,
  bashRecallKey,
  pipelineDivergenceNote,
  cachedRunCoversCommand,
  extractCommand,
  detectUnbalancedShellSyntax,
} from './hooks_bash_commands.js'

import {
  surgicalHintFor,
  surgicalHintForConfigDoc,
  sqlTableHint,
  extractCatSourceFile,
  extractCatFile,
  extractCatFilesMulti,
  commandPathIsTouchable,
  extractPowerShellWrappedGetContent,
  extractPowerShellFileMethodRead,
  extractTerminalXmlParsing,
  extractRgSymbolSearch,
  extractCatJsonPipe,
  extractPowerShellJsonPipeline,
  extractWslCatFile,
  extractPythonFileRead,
  extractHeadFile,
  extractLineRangeRead,
  extractLineRangeReadsCompound,
  sedRangeHint,
  type RangeSubstituteFigures,
  leadingLinesHint,
  findRangeOverlap,
  sedOverlapHint,
  extractNodeFileRead,
  extractTailFile,
  extractGetContentTail,
  extractGetContentSelectFirst,
  extractGetContentHead,
  taskOutputIsJsonlTranscript,
  extractTasksOutput,
  extractToolResultsFile,
  extractDirectoryListing,
  extractForLoopWcL,
  extractFindCommand,
  extractMarkdownHeadingGrep,
  extractRgStructuralSearch,
  extractGrepPipeChain,
  extractCurlUrl,
  extractTgSurgicalRead,
  isCurlGetCommand,
  isReadOnlyGhApi,
  extractCurlDownload,
  buildRecallHint,
  shellQuoteSingle,
  isCompressibleSingleCommand,
  classifyCatPath,
  compressionOptedOut,
} from './bash_extractors.js'
import { countTextLines, SLICE_ESTIMATE_SCAN_CAP_BYTES } from './hooks_read_slice.js'

/** Token budget for an inline interpreter file read run under the wrapper: room for one registry entry or config block printed whole, well under a whole-file dump. */
const INTERPRETER_READ_TOKEN_CAP = 2000

// Runs an inline interpreter file read under a token cap instead of refusing it. Many are projections, `json.load(open('r.json'))['118615']`, that print a few lines no token-goat command beats by a second round trip; refused, each cost the agent a retry and often a second refusal before it found a spelling the hook let through. A projection now passes whole, and a whole-file dump comes back capped with its recall id and the same surgical command the refusal named. The refusal stays wherever the wrapper cannot run: compression off, a pipeline or chain, a background `&`, a script past the command-line ceiling, VS Code. The hint passes the suggestion guard here because the relay only guards a refusal: printed after the capped output, a path that broke its quoting would reach the model unguarded.
function cappedInterpreterRead(event: HookEvent, rawCmd: string, cmd: string, hint: string, denial: string): HookOutput {
  return maybeCompressRewrite(event, rawCmd, cmd, { maxTokens: INTERPRETER_READ_TOKEN_CAP, hint: stripUnsafeSuggestions(hint) }) ?? denyOutput(denial)
}

/** A rewrite of this Bash call's command, or null when rewrite_permission.ts finds it could change the permission outcome of the command the model wrote. */
function shellRewrite(event: HookEvent, kind: 'shell-wrap' | 'shell-query', original: string, command: string): HookOutput | null {
  return permissionNeutralRewrite({ ...event.toolInput, command }, { kind, harness: detectHarness(), mode: event.raw['permission_mode'], cwd: getCwd(event) ?? process.cwd(), original, rewritten: command, agentType: agentTypeOf(event.raw) })
}

/** Wrap a recognized command in `token-goat compress` so its output is structurally compressed on this run. Returns a `rewriteInput` HookOutput that replaces the Bash tool input wholesale (preserving description/timeout), or null when compression is disabled (`TOKEN_GOAT_BASH_COMPRESS=0` or config), the command is unsuitable, or the chosen filter is disabled. @param event  hook event; its toolInput is preserved verbatim except `command` @param rawCmd original command INCLUDING any `cd … &&` prefix and leading assignments (run by compress) @param cmd    the command with both stripped, used only to pick the filter */
// `cap`, when given, runs the command through the passthrough filter under a token cap and names the narrower command to print if the cap cuts: set for an inline interpreter file read, whose output is a file's contents rather than tool output.
function maybeCompressRewrite(event: HookEvent, rawCmd: string, cmd: string, cap?: { maxTokens: number; hint: string }): HookOutput | null {
  if (/^(?:token-goat|tg|npx\s+token-goat)(?:\s|$)/.test(cmd.trimStart())) return null
  // The capped interpreter read declines too, and its caller then refuses the read: the cap is compression, so an inline prefix gets what the environment's opt-out already got.
  if (compressionOptedOut(rawCmd)) return null
  // VS Code's run_in_terminal runs the command in whatever shell the user's terminal uses, and its payload does not say which one, so no quoting of the wrapped command is safe in every one of them: the command is never rewritten there.
  if (event.raw['_tg_harness'] === 'vscode') return null

  const isPwshHarness =
    process.platform === 'win32' &&
    (event.raw['_tg_harness'] === 'codex' ||
      event.raw['_tg_harness'] === 'copilot_cli' ||
      event.raw['tool_name'] === 'powershell')

  if (isPwshHarness) {
    if (!canRunPowerShell()) return null
  } else {
    // No usable shell to run the wrapper under (Windows with no Git-Bash): leave the command to run normally in the harness bash, uncompressed, rather than wrapping it into a cmd.exe execution.
    if (!canRunWrappedShell()) return null
  }

  let cfg: { enabled: boolean; disabled_filters: string[]; timeout_seconds: number }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled) return null

  // A specific filter (once the framework recognizes the command) wins over the generic catch-all. Either way the command must be a single pipe/redirect-free invocation: detectFromCommand enforces that for specific filters; the generic path requires it explicitly. The capped path is the exception: its output goes through untouched, so there is no filter to feed one command's output, and a multi-line `-c` script or a heredoc, the shape 198 of 217 measured interpreter reads arrived in, runs under it like any other. Only a detached job is declined, since the wrapper would wait on it.
  let filterName: string
  if (cap !== undefined) {
    if (hasBareBackground(cmd)) return null
    filterName = 'passthrough'
  } else {
    const gateCmd = stripTrailingStderrRedirect(cmd)
    // A package-manager script is looked up in the directory the command runs in, where preBashHandlerInner keys its cached output, not the hook's cwd a cd prefix leaves behind: a workspace's packages can name different runners for one `npm test`.
    const detected = detectFromCommand(gateCmd, commandRunDir(rawCmd, getCwd(event) ?? null) ?? undefined)
    if (detected !== null) {
      filterName = detected.filter.name
    } else if (isCompressibleSingleCommand(gateCmd)) {
      filterName = 'generic'
    } else {
      return null
    }
  }
  if (cfg.disabled_filters.includes(filterName)) return null
  const capArgs = cap === undefined ? '' : ` --max-tokens ${cap.maxTokens} --cap-hint-b64 ${Buffer.from(cap.hint, 'utf8').toString('base64')}`

  if (isPwshHarness) {
    // For PowerShell harnesses on Windows (Codex, Copilot CLI), avoid shell quoting pitfalls (backslashes, quotes, operators) by using base64. Skip wrapping if the base64 representation does not round-trip exactly.
    const b64 = Buffer.from(rawCmd, 'utf8').toString('base64')
    if (Buffer.from(b64, 'base64').toString('utf8') !== rawCmd) return null

    const wrapped = `token-goat compress -f ${filterName} --timeout ${cfg.timeout_seconds}${capArgs} --shell pwsh --cmd-b64 ${b64}`
    // Guard against Windows CreateProcess 32,767 character command-line limit
    if (wrapped.length > 24000) return null

    return shellRewrite(event, 'shell-wrap', rawCmd, wrapped)
  }

  const wrapped = `token-goat compress -f ${filterName} --timeout ${cfg.timeout_seconds}${capArgs} -c ${shellQuoteSingle(rawCmd)}`
  // A heredoc script can run to kilobytes, and single-quoting spends four characters on each quote it holds; past the same ceiling the pwsh branch keeps, the refusal is the safer answer than a command line Windows may cut.
  if (cap !== undefined && wrapped.length > 24000) return null
  return shellRewrite(event, 'shell-wrap', rawCmd, wrapped)
}

/** The single range of a `sed`/`awk` line-range read when it runs from line 1 to the file's last line, on a file `cat` would be refused for, with the reason to give. Null for any other range, and for a file past SLICE_ESTIMATE_SCAN_CAP_BYTES or unreadable, since counting its lines means reading it. */
function wholeFileRange(
  filePath: string,
  hintPath: string,
  cwd: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  tool: 'sed' | 'awk',
): { start: number; end: number; cat: NonNullable<ReturnType<typeof classifyCatPath>>; reason: string } | null {
  const [range] = ranges
  if (ranges.length !== 1 || range === undefined || range[0] > 1) return null
  const cat = classifyCatPath(filePath, tool)
  if (cat === null) return null
  try {
    const onDisk = hostPathOfTypedPath(hintPath, cwd)
    const st = statSync(onDisk)
    if (!st.isFile() || st.size > SLICE_ESTIMATE_SCAN_CAP_BYTES) return null
    const total = countTextLines(readFileSync(onDisk, 'utf8'))
    if (total === 0 || range[1] < total) return null
    return { start: range[0], end: range[1], cat, reason: '`' + tool + '` over lines ' + range[0] + '-' + range[1] + ' is the whole file (' + total + ' lines), and loads all of it into context.' }
  } catch {
    return null
  }
}

/** pre_tool_use handler for the Bash tool. Emits a recall hint when the command is a known build tool and its output was already captured this session. Passes through for all other commands. */
/** The answers about how a command is written rather than a file it reads, which preBashHandler's Read-rule gate leaves standing. */
const SYNTAX_OUTPUTS = new WeakSet<HookOutput>()
function syntaxOutput(output: HookOutput): HookOutput {
  SYNTAX_OUTPUTS.add(output)
  return output
}

function preBashHandlerInner(event: HookEvent): HookOutput {
  const rawCmd = extractCommand(event)
  if (rawCmd === undefined) return passOutput()
  const cmd = stripCommandPrefix(rawCmd)
  // Only a stripped `cd` moves the directory a relative path resolves against; a stripped assignment or subshell group does not, though a `cd` inside the group does.
  const grouped = stripSubshellGroup(rawCmd)
  const cdStripped = stripCdPrefix(grouped) !== grouped
  // The bash event's cwd, used to resolve any relative file path the same way the CLI/shell itself would — hoisted here (rather than computed right before its first use) so every path-keyed dedup check below (sed line-ranges, CLI surgical reads) shares one resolution.
  const preHookCwd = getCwd(event) ?? null
  // Held for this call's post hook, which resolves the command's cd against the directory the call started in rather than the one Claude Code's main thread reports after it: see session.ts::_bashStartCwds.
  const toolUseId = event.raw['tool_use_id']
  if (typeof toolUseId === 'string' && toolUseId !== '' && preHookCwd !== null) recordBashStartCwd(toolUseId, preHookCwd)
  // When a cd prefix was stripped, path-based hints below resolve their filePath against the directory that cd would actually leave the shell in, not this hook's own cwd.
  const hintCwd = preHookCwd ?? process.cwd()
  // The directory the command runs in, which a cached output is recorded against and checked for staleness in, and which a `token-goat read` path resolves against: the post hook derives the same one from the same command and cwd.
  const runDir = commandRunDir(rawCmd, preHookCwd)
  // Every hint below that names a file returns through this instead of a bare contextOutput, so the efficacy ledger is handed the path the hint was built from rather than regex-scraping one back out of the rendered sentence (see extractPathCorrelator's doc comment for what that scrape actually recorded). Measurement only -- relay.ts drops the field before the harness sees the output, so the hint text is byte-identical either way. The `token-goat bash-output <id>` recall branches near the end deliberately do NOT use this: their correlator is a cache id, which classifyBashHint already reads straight out of the command it printed, not a path.
  const pathHint = (paths: string | readonly string[], text: string): HookOutput =>
    contextOutput(text, typeof paths === 'string' ? [paths] : paths)
  // The name a surgical-read suggestion below carries, resolved against the directory the command would run in: a heading, key, table or symbol the file holds, or hint_target.ts's placeholder.
  const targetFor = (hintPath: string, slice: HintSlice = sliceForPath(hintPath)): HintTarget => hintTarget(hintPath, slice, { cwd: hintCwd, event })
  // A task `.output` path as the shell would open it, against the directory the command runs in rather than this hook's own cwd, and as a recall command should name it: a relative one comes back absolute, so the suggested command runs as printed from any directory.
  const taskOutputPath = (typed: string): { probe: string; shown: string } | null => {
    // Gated before resolveIndexPath, which is itself an fs call on Windows (an 8.3 segment expands through realpathSync.native).
    if (!commandPathIsTouchable(typed, event)) return null
    if (path.isAbsolute(typed) || path.win32.isAbsolute(typed)) return { probe: typed, shown: displaySafePath(typed) }
    const probe = resolveIndexPath(typed, cdPrefixCwd(rawCmd, hintCwd))
    return { probe, shown: displaySafePath(probe) }
  }
  // A leading-lines read's substitute, priced, or null when it could not be priced or was not cheaper -- the same gate the sed/awk branch applies, reached through one expression because two branches need it identically.
  const pricedSubstitute = (hintPath: string, start: number, end: number): RangeSubstituteFigures | null => {
    // Pricing stats and reads the file before the command is approved: `head -n 300 //10.255.255.1/share/x.ts` spent the 21 s SMB connect timeout here on Windows.
    if (!commandPathIsTouchable(hintPath, event)) return null
    const sub = rangeSubstituteFor(hintPath, hintCwd, [[start, end]])
    return sub !== null && meetsSavingsFloor(sub.requestedBytes - sub.replacementBytes) ? sub : null
  }
  // Falling silent because the substitute was not cheaper is a decision, and it has to leave a trace or it is invisible to every surface: the hook returns the same empty object it returns for a command it never recognized, so without this a gate that declines on every file in the project and a gate that never fires read identically. Zero-byte and never scored -- nothing was shown, so there is nothing to score -- but the correlator records which file kept losing the comparison, which is what tells a reader whether to widen the gate or retire the hint.
  const declineUnpriced = (paths: string | readonly string[]): HookOutput => {
    for (const p of typeof paths === 'string' ? [paths] : paths) logSuppressedDetection('bash_redirect', event.sessionId, p)
    return passOutput()
  }
  // The size half of the condition each of the five `token-goat bash-output <id>` recall branches below repeated, plus the decline record none of them kept: a candidate that clears the dedup minimum but fails the savings floor was refused on price, which is a decision and has to leave a trace for the same reason declineUnpriced does. Callers still test their own id and entry for null, both to keep TypeScript's narrowing inside the branch and because neither absence is this gate declining anything -- no cached output, or an entry too stale to offer, never reached a price comparison, and recording it would credit the gate with refusing work it never had. The correlator is the cache id, which is what classifyBashHint reads back out of a recall hint that did get shown, so the declined and shown rows key alike.
  const recallWorthShowing = (outputId: string, entry: { sizeBytes: number }): boolean => {
    if (entry.sizeBytes < loadConfig().hints.bash_dedup_min_bytes) return false
    if (meetsSavingsFloor(entry.sizeBytes)) return true
    logSuppressedDetection('bash_recall', event.sessionId, outputId)
    return false
  }

  const cfg = loadConfig()
  // Claude Code's Bash tool on Windows passes the command to Git Bash as a `-c` argument, and the argv quoting plus the MSYS2 runtime's decoding halve every run of two or more backslashes, so the command that runs is not the one written and nothing reports the difference (anthropics/claude-code#85856). Denied rather than rewritten: a rewrite goes out as updatedInput, which permission rules evaluate again. `_tg_harness` is 'claude' for every harness relay.ts does not map, so detectHarness() is what pins this to Claude Code; the hook server answers under the caller's own environment, so it sees the same variables here.
  if (cfg.hints.deny_bash_double_backslash && process.platform === 'win32' && event.raw['_tg_harness'] === 'claude' && rawCmd.includes('\\\\') && detectHarness() === 'claudecode') {
    recordStat('session_hint', 0, 0)
    return syntaxOutput(denyOutput(
      'This command has two backslashes in a row. Claude Code\'s Bash tool on Windows halves every run of two or more backslashes before Git Bash sees the command, so it would run with different text than you wrote, with no error (anthropics/claude-code#85856). Write text containing backslashes to a file with the Write tool and run it by path, or use the PowerShell tool, which passes the command unchanged. For paths, use forward slashes: C:/Users/me works in Git Bash. To turn this check off, set hints.deny_bash_double_backslash = false or TOKEN_GOAT_DENY_BASH_DOUBLE_BACKSLASH=0.',
    ))
  }
  // Check for unbalanced shell quoting or unterminated heredocs
  if (cfg.hints.warn_unbalanced_shell_quoting) {
    const quoteError = detectUnbalancedShellSyntax(cmd)
    if (quoteError !== null) {
      recordStat('session_hint', 0, 0)
      return syntaxOutput(contextOutput(
        'This command has ' + quoteError + '. If you\'re writing a multi-line string with embedded quotes or special characters, consider using the Write tool instead — it avoids shell quoting issues entirely.',
      ))
    }
  }

  // Item 3: task output file — already cached, recall with bash-output
  const taskOutput = extractTasksOutput(cmd)
  if (taskOutput !== null) {
    const { id, n } = taskOutput
    const outPaths = taskOutputPath(taskOutput.path)
    recordStat('session_hint', 0, 0)
    // Only deny a genuine JSONL transcript; a background command's stdout is meant to be read and falls through to normal handling.
    if (outPaths !== null && taskOutputIsJsonlTranscript(outPaths.probe)) {
      const outPath = outPaths.shown
      const tail = n ?? 50
      return denyOutput(
        'Task output ' + id + ' is a JSONL agent transcript on disk. Use `token-goat bash-output --file ' + quotedArg(outPath) + ' --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail ' + tail + '`, or read a specific line range (the only way to reach the MIDDLE of a large artifact) with `token-goat read ' + quotedArg(outPath + '@START-END') + '`, instead of reading the whole file.',
      )
    }
  }

  // Item 3b: tool-results plain-text file — cached tool output, recall with bash-output
  const toolResults = extractToolResultsFile(cmd)
  if (toolResults !== null) {
    // extractToolResultsFile only validates the trailing `tool-results/<safe-id>.txt` suffix, so everything before it is arbitrary and repository-shaped; displaySafePath at derivation matches every other path this handler puts on the context channel.
    const outPath = displaySafePath(toolResults.path)
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Tool output ' + outPath + ' is a plain-text artifact. Use `token-goat bash-output --file ' + quotedArg(outPath) + '` to read it with surgical narrowing via `--grep PATTERN` or `--tail N`, instead of reading the whole file.',
    )
  }

  // find interception — fd is faster and .gitignore-aware; xargs grep -l is a symbol-search anti-pattern
  const findResult = extractFindCommand(cmd)
  if (findResult !== null) {
    const { extGlob, isXargsGrepL } = findResult
    recordStat('session_hint', 0, 0)
    if (isXargsGrepL) {
      return denyOutput(
        '`find | xargs grep -l` is a slow symbol search. ' +
        'Use `token-goat refs <symbol>` or `rg -l <symbol>` for faster symbol-file discovery.',
      )
    }
    const fdHint = extGlob
      ? 'Use `fd \'' + extGlob + '\'` for faster file discovery (respects .gitignore).'
      : 'Use `fd` for faster file discovery (respects .gitignore).'
    return contextOutput(
      '`find` is slow and ignores .gitignore. ' + fdHint +
      ' For symbol definitions, use `token-goat symbol <Name>`.',
    )
  }

  // Item 7: directory listing — token-goat map is cheaper
  if (extractDirectoryListing(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat map --compact` (~300 tokens) for a repo overview, or `token-goat map <dir>` for a subdirectory.',
    )
  }

  // for-loop wc -l size probe — suggest outline instead
  if (extractForLoopWcL(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat outline <file>` to see symbol names and line counts without loading files.',
    )
  }

  // Terminal XML parsing interception (Select-Xml, [xml], PowerShell XML inspect scripts, Python xml.etree, xmlstarlet)
  const terminalXml = extractTerminalXmlParsing(cmd)
  if (terminalXml !== null) {
    const { filePath, toolOrScript } = terminalXml
    recordStat('session_hint', 0, 0)
    const target = filePath ? displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath) : '<file>'
    return pathHint(filePath ? [target] : [],
      `token-goat available for this file type, consider \`token-goat xml-query ${quotedArgs(target, '<xpath>').join(' ')}\` or \`token-goat xml-outline ${quotedArg(target)}\` first instead of terminal XML parsing (${toolOrScript}).`,
    )
  }

  // Item 4b: sed line-range extraction — replaced with extractSedRange to provide specific line range A single-command read is preferred; failing that, the compound spellings (echo-separated multi-span reads, formatting-only pipes) are the same read class and get the same per-file treatment.
  const singleLineRangeRead = extractLineRangeRead(cmd)
  const sedReads = singleLineRangeRead !== null ? [singleLineRangeRead] : extractLineRangeReadsCompound(cmd)
  if (sedReads !== null) {
    const hints: string[] = []
    // One emission can cover several files here (the per-file hints are joined into one context output), so every file named gets into the correlator set rather than just the first -- see joinCorrelators in hint_stats.ts for why the set, not a primary path, is the right representation.
    const hintPaths: string[] = []
    for (const { filePath, ranges, tool } of sedReads) {
      // When a cd prefix was stripped, both the dedup key and the displayed hint path must resolve against the directory cd would actually leave the shell in, matching every other path-carrying hint block above/below — otherwise a cd-prefixed sed read resolves against this hook's own cwd instead of the shell's real one, both mislabeling the hint and missing dedup against a non-cd-prefixed reference to the same file.
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
      // Everything below stats or reads the file, and this hook runs before the command is approved: `sed -n '1,5p' //10.255.255.1/share/x.txt` spent the whole 21 s SMB connect timeout here on Windows, and on WSL a drive-letter path now opens at its mount.
      if (!commandPathIsTouchable(hintPath, event)) continue
      // Dedup on the resolved/normalized path (relative-to-absolute, cwd-anchored, drive-letter-cased) — a relative and an absolute reference to the same file must collide under one key, matching how the CLI surgical-read dedup above already resolves paths. Multi-range `sed -n 'A,Bp;C,Dp'` commands are checked and recorded per-range (not as one combined min-max span) so a gap between ranges that was already read separately doesn't get misreported as newly-overlapping, and so each range's own history is tracked.
      hintPaths.push(hintPath)
      const sedDedupKey = resolveIndexPath(hintPath, preHookCwd ?? process.cwd())
      // Ranges served before the file changed on disk describe text that is no longer there, so they go before anything is measured against them, as the Read path drops them.
      dropFileLineRangesIfChanged(sedDedupKey)
      // A range from line 1 to the last line is `cat` spelled another way, and gets `cat`'s answer: pricing it against a surgical read of the same lines finds no saving, since that read is the whole file too, so `awk 'NR>=1 && NR<=324'` over a 324-line, 54KB skill passed with no word while `cat` of it was refused. Checked before the range is recorded, so a refusal does not count the lines as served.
      const whole = singleLineRangeRead === null ? null : wholeFileRange(filePath, hintPath, hintCwd, ranges, tool)
      if (whole !== null && findRangeOverlap(getFileLineRanges(sedDedupKey), whole.start, whole.end) === null) {
        recordStat('session_hint', 0, 0)
        if (whole.cat.isSql) return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), whole.reason))
        const hint = surgicalHintFor(hintPath, whole.cat.isEnv, whole.cat.isConfig, whole.cat.isDoc, whole.cat.isXml, targetFor(hintPath, whole.cat.isEnv ? 'key' : undefined), whole.reason)
        return cdStripped ? pathHint(hintPath, hint) : denyOutput(hint)
      }
      const overlapHints: string[] = []
      const freshRanges: Array<readonly [number, number]> = []
      // Recorded before the command runs, so only for a file that is there to be read: a range read of an absent file shows nothing, and Claude Code reports that failure to PostToolUseFailure alone, where nothing takes the range back, so once the file appeared a read of those lines was told they were already served.
      const onDisk = isFileAtIndexKey(sedDedupKey)
      for (const [start, end] of ranges) {
        const priorOverlap = findRangeOverlap(getFileLineRanges(sedDedupKey), start, end)
        if (onDisk) recordFileLineRange(sedDedupKey, start, end)
        if (priorOverlap !== null) {
          overlapHints.push(sedOverlapHint(hintPath, priorOverlap, start, end))
        } else {
          freshRanges.push([start, end])
        }
      }
      hints.push(...overlapHints)
      // Priced, not assumed: the hint is pushed only when the regions a surgical read would have to return are measurably cheaper than the lines the command asked for. See bash_range_savings.ts for the comparison and for what it measures over a real corpus.
      const sub = freshRanges.length > 0 ? rangeSubstituteFor(hintPath, hintCwd, freshRanges) : null
      if (sub !== null && meetsSavingsFloor(sub.requestedBytes - sub.replacementBytes)) {
        hints.push(sedRangeHint(hintPath, freshRanges, tool, sub))
      }
    }
    if (hints.length === 0) return declineUnpriced(hintPaths)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPaths, hints.join(' '))
  }

  // These two must run before extractCatFile: a `-Tail`/`Select-Object -First`-flagged Get-Content command is a single path with a flag VALUE in the argument list (e.g. `Get-Content -Tail 50 src/auth.ts`, where `50` reads as a bare positional token), and extractCatFile's own trailing-flag catch-all matches that same shape. Left in its original position below, extractCatFile denied a `-Tail 50` read outright as a whole-file dump -- "loads the entire file into context" -- when only 50 lines were ever going to be read, exactly the ordering hazard extractCatFilesMulti's own out.length >= 2 guard was written to avoid, and recordBashFileReadsForSessionCache (hooks_bash_post.ts) already orders its own gcTail/tail/gcSelect/head checks ahead of extractCatFile for this identical reason.
  const gcTailResult = extractGetContentTail(cmd)
  if (gcTailResult !== null) {
    const { filePath, isDoc, isConfig, isSql, isXml } = gcTailResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, surgicalHintForConfigDoc(hintPath, isConfig, isDoc, isSql, isXml, targetFor(hintPath), '`Get-Content -Tail` bypasses read hooks.'))
  }

  const gcSelectResult = extractGetContentSelectFirst(cmd)
  if (gcSelectResult !== null) {
    const { filePath, n } = gcSelectResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const gcSelectHint = leadingLinesHint('`Select-Object -First` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n), event)
    if (gcSelectHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, gcSelectHint)
  }

  const gcHeadResult = extractGetContentHead(cmd)
  if (gcHeadResult !== null) {
    const { filePath, n } = gcHeadResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const gcHeadHint = leadingLinesHint('`Get-Content -TotalCount` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n), event)
    if (gcHeadHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, gcHeadHint)
  }

  const catJsonPipe = extractCatJsonPipe(cmd)
  if (catJsonPipe !== null) {
    const { filePath, isDirectJq } = catJsonPipe
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const label = isDirectJq ? '`jq`' : '`cat | jq`'
    return pathHint(hintPath, surgicalHintFor(hintPath, false, true, false, false, targetFor(hintPath, 'key'), label + ' loads the whole file.'))
  }

  const psJsonPipe = extractPowerShellJsonPipeline(cmd)
  if (psJsonPipe !== null) {
    recordStat('session_hint', 0, 0)
    if (psJsonPipe.filePath) {
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, psJsonPipe.filePath, hintCwd) : psJsonPipe.filePath)
      return pathHint(hintPath,
        'PowerShell `ConvertFrom-Json` pipeline detected. Use `token-goat json-query ' + quotedArgs(hintPath, '<selector>').join(' ') + '` to extract fields directly without shell conversion scripts.',
      )
    }
    return contextOutput(
      'PowerShell `ConvertFrom-Json` pipeline detected. Use `token-goat json-query <file> "<selector>"` or `token-goat web-output` to extract fields directly.',
    )
  }

  const catResult = extractCatFile(cmd)
  if (catResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml, cmd0, advisoryOnly } = catResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const reason = '`' + cmd0 + '` loads the entire file into context.'
    if (isSql) return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), reason))
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, targetFor(hintPath, isEnv ? 'key' : undefined), reason)
    // advisoryOnly: a `2>/dev/null`-suffixed read tolerates the file being absent, so it gets guidance rather than a deny (a deny would redirect the agent at a file that may not exist).
    return cdStripped || advisoryOnly ? pathHint(hintPath, hint) : denyOutput(hint)
  }

  const catMulti = extractCatFilesMulti(cmd)
  if (catMulti !== null) {
    recordStat('session_hint', 0, 0)
    const cmd0 = catMulti[0]!.cmd0
    // One command-led line per file, each carrying its own path, so the first thing in the message is a command that runs.
    const perPath = catMulti.map(({ filePath, isDoc, isEnv, isConfig, isSql, isXml }) => {
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
      return isSql
        ? sqlTableHint(hintPath, targetFor(hintPath, 'table'))
        : surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, targetFor(hintPath, isEnv ? 'key' : undefined))
    })
    const msg = perPath.join('\n') + '\n`' + cmd0 + '` on multiple files loads them all into context; read each surgically instead.'
    return cdStripped ? pathHint(catMulti.map((m) => displaySafePath(resolveCdHintPath(rawCmd, m.filePath, hintCwd))), msg) : denyOutput(msg)
  }

  const psGetContentResult = extractPowerShellWrappedGetContent(cmd, event)
  if (psGetContentResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = psGetContentResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const lead = '`Get-Content` via a `powershell -Command` wrapper bypasses read hooks and loads the entire file into context.'
    if (isSql) {
      // SQL reads are always advisory-only (never denied), matching extractCatFile/extractWslCatFile's deliberate SQL-never-deny design (see the "Item 4 (nestpilot mining)" regression test) -- a schema/migration file is routinely read in full for review, and `token-goat read "file::table_name"` only extracts one block at a time, so denying the whole-file read here (as the cd-unprefixed branch below does for every other file type) would block a legitimate workflow this hint category was never meant to gate that hard.
      return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), lead))
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, targetFor(hintPath, isEnv ? 'key' : undefined), lead)
    return cdStripped ? pathHint(hintPath, hint) : denyOutput(hint)
  }

  const wslCatResult = extractWslCatFile(cmd)
  if (wslCatResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = wslCatResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const reason = '`cat` loads the entire file into context.'
    if (isSql) return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), reason))
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, targetFor(hintPath, isEnv ? 'key' : undefined), reason)
    return cdStripped ? pathHint(hintPath, hint) : denyOutput(hint)
  }

  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null) {
    const { filePath, isDoc, isConfig, isEnv, isSql, isXml, isOutputFile } = pyRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    if (isOutputFile) {
      // Same two kinds the cat/tail guard above tells apart, decided the same way. An agent transcript is JSONL worth hundreds of kilobytes and reading it whole is the mistake worth blocking; a background command's stdout is plain text the harness expects to be read, so that only gets advice about narrowing it, never a refusal.
      const outPaths = taskOutputPath(filePath)
      if (outPaths !== null && taskOutputIsJsonlTranscript(outPaths.probe)) {
        const tHint = 'This `.output` file is a JSONL agent transcript. Use `token-goat bash-output --file ' + quotedArg(outPaths.shown) + ' --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail N`, instead of hand-parsing the JSONL.'
        return cdStripped ? pathHint(hintPath, tHint) : denyOutput(tHint)
      }
      return pathHint(hintPath,
        'This `.output` file is a background command\'s stdout. Use `token-goat bash-output --file ' + quotedArg(hintPath) + '` to narrow it with `--grep PATTERN`, `--tail N` or `--head N`, instead of reading the whole file.',
      )
    }
    const reason = 'Python `open()` file reads bypass read hooks.'
    if (isSql) return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), reason))
    const target = targetFor(hintPath, isEnv ? 'key' : undefined)
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml ?? false, target)
    const denial = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml ?? false, target, reason)
    return cdStripped ? pathHint(hintPath, denial) : cappedInterpreterRead(event, rawCmd, cmd, hint, denial)
  }

  const tailResult = extractTailFile(cmd)
  if (tailResult !== null) {
    const { filePath, isDoc, isConfig, isSql, isXml } = tailResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, surgicalHintForConfigDoc(hintPath, isConfig, isDoc, isSql, isXml, targetFor(hintPath), '`tail` bypasses read hooks.'))
  }

  const headResult = extractHeadFile(cmd)
  if (headResult !== null) {
    const { filePath, n } = headResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const headHint = leadingLinesHint('`head` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n), event)
    if (headHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, headHint)
  }

  const nodeRead = extractNodeFileRead(cmd)
  if (nodeRead !== null) {
    const { filePath, isDoc, isConfig, isSql } = nodeRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const lead = 'Node.js `fs.readFileSync()` bypasses read hooks.'
    if (isSql) {
      // SQL reads are always advisory-only (never denied), matching extractCatFile/extractWslCatFile/extractPowerShellWrappedGetContent's deliberate SQL-never-deny design (see the "Item 4 (nestpilot mining)" regression test) -- a schema/migration file is routinely read in full for review, and `token-goat read "file::table_name"` only extracts one block at a time, so denying the whole-file read here (as this handler did for every other file type, unconditionally, before this fix) would block a legitimate workflow this hint category was never meant to gate that hard. This branch previously fell through to the same cdStripped ? contextOutput : denyOutput as every non-SQL case below, so a non-cd-prefixed `node -e "readFileSync('x.sql')"` was hard-denied while the equivalent `cat x.sql` was always advisory -- the exact SQL-hint-classifier divergence already fixed for cat/head/tail/Get-Content.
      recordStat('session_hint', 0, 0)
      return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), lead))
    }
    // Folded onto the shared ladder every other whole-file-dump branch already uses. It was an inlined near-copy with the same placeholders, plus one this codebase warns against everywhere else: `read "path::SymbolName"` claims a specific symbol that file may not have, which is exactly the fabricated name surgicalHintFor in bash_extractors.ts never prints for an unresolved symbol. extractNodeFileRead reports no isEnv/isXml, so both pass false, which is what the inlined ladder assumed anyway.
    const target = targetFor(hintPath)
    const hint = surgicalHintFor(hintPath, false, isConfig, isDoc, false, target)
    const denial = surgicalHintFor(hintPath, false, isConfig, isDoc, false, target, lead)
    recordStat('session_hint', 0, 0)
    return cdStripped ? pathHint(hintPath, denial) : cappedInterpreterRead(event, rawCmd, cmd, hint, denial)
  }

  const psMethodRead = extractPowerShellFileMethodRead(cmd, event)
  if (psMethodRead !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = psMethodRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const lead = 'PowerShell `[IO.File]::ReadAllText()` bypasses read hooks.'
    if (isSql) {
      recordStat('session_hint', 0, 0)
      return pathHint(hintPath, sqlTableHint(hintPath, targetFor(hintPath, 'table'), lead))
    }
    const target = targetFor(hintPath, isEnv ? 'key' : undefined)
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, target)
    const denial = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, target, lead)
    recordStat('session_hint', 0, 0)
    return cdStripped ? pathHint(hintPath, denial) : cappedInterpreterRead(event, rawCmd, cmd, hint, denial)
  }

  // A plain-enumeration rg/grep structural search (whole-file symbols, headings, imports) has an exact index answer -- rewrite the command to it instead of just hinting, so the model gets the answer in this one tool result. Checked on rawCmd (not the cd-stripped cmd) ahead of the hint-only checks below: detectStructuralIndexRewrite's own detectFromCommand call rejects any `cd DIR &&` prefix as a compound command, which is the correct pass-through for that shape rather than something this call needs to special-case.
  const structuralRewrite = detectStructuralIndexRewrite(rawCmd, hintCwd, event)
  if (structuralRewrite !== null) {
    const rewrite = shellRewrite(event, 'shell-query', rawCmd, structuralRewrite.command)
    if (rewrite !== null) return rewrite
  }

  if (extractGrepPipeChain(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass). ' +
      'For symbol discovery: `token-goat refs <symbol>` or `token-goat semantic`.',
    )
  }

  // Markdown heading grep: `grep -n "^#" SKILL.md` → outline hint (before structural search so .md heading patterns don't get misrouted to the symbol-search advice)
  const mdHeadingGrep = extractMarkdownHeadingGrep(cmd)
  if (mdHeadingGrep !== null) {
    const { filePath } = mdHeadingGrep
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, docSectionHint(hintPath, targetFor(hintPath, 'section').name))
  }

  // Bare identifier search on a single source file — symbol lookup is cheaper
  const rgSymbol = extractRgSymbolSearch(cmd)
  if (rgSymbol !== null) {
    const { identifier } = rgSymbol
    recordStat('session_hint', 0, 0)
    // `symbol` takes one name and would look `A|B` up as a literal name, so each alternative of an `rg "A|B"` search gets its own quoted command. The correlators are those names, not a path: this hint names no file, and the exact token a follow-through would have to carry is a symbol name. Left to extractPathCorrelator it scraped nothing at all, so the row went in permanently uncreditable.
    const names = [...new Set(identifier.split('|'))]
    return contextOutput(
      'Use ' + names.map((name) => '`token-goat symbol ' + quotedArg(name) + '`').join(' or ') + ' to jump directly to the definition without scanning the file.',
      names,
    )
  }

  const rgStructural = extractRgStructuralSearch(cmd)
  if (rgStructural !== null) {
    const { filePath } = rgStructural
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath,
      'Searching for code definitions with `rg`/`grep` is slower than surgical reads. ' +
      'Use `token-goat skeleton ' + quotedArg(hintPath) + '` to see all symbols with line numbers, ' +
      'or `token-goat outline ' + quotedArg(hintPath) + '` for symbols with docstrings and line ranges.'
    )
  }

  // Monitoring commands: always suggest recall if cached, even on a single prior run.
  const monitoringHint = getMonitoringRecallHint(cmd)
  if (monitoringHint !== null) {
    const monCmdHash = bashRecallKey(cmd, runDir)
    const monOutputId = getBashOutputId(monCmdHash)
    // Only emit the recall hint if the content entry is actually present (the session index may name an id whose blob was pruned) and not stale — a matching id whose stored git/dir/lockfile fingerprint no longer matches the current state means the source changed since it was cached, so it must not be recalled as fresh.
    const monEntryRaw = monOutputId !== null ? getBashOutput(monOutputId) : null
    const monEntry = monEntryRaw !== null && !isBashEntryStale(monEntryRaw, cmd, runDir) ? monEntryRaw : null
    if (monOutputId !== null && monEntry !== null && cachedRunCoversCommand(monEntry.command, cmd) && recallWorthShowing(monOutputId, monEntry)) {
      const monBytes = monEntry.sizeBytes
      const catFile = extractCatSourceFile(cmd)
      if (catFile !== null) {
        recordStat('bash_compress:recall', monBytes, savedTokensFromBytes(monBytes))
        return contextOutput(
          'Prior output from `' + cmd + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached. ' +
          'Use `token-goat bash-output ' + monOutputId + '` to recall the full file, or ' +
          '`' + sliceCommand(displaySafePath(catFile), targetFor(displaySafePath(catFile))) + '` to extract only the part you need.'
        )
      }
      const cmdSummary = cmd.length > 60 ? cmd.slice(0, 57).trimEnd() + '...' : cmd
      recordStat('bash_compress:recall', monBytes, savedTokensFromBytes(monBytes))
      return contextOutput(
        'Prior output from `' + cmdSummary + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached.\n' +
        'Use `token-goat bash-output ' + monOutputId + ' ' + monitoringHint + '` to re-inspect without re-running.'
      )
    }
  }

  // Item 2: curl -o download recall — keyed by URL so a re-download to a different temp path still gets a recall hint pointing to the previously saved file.
  const curlDl = extractCurlDownload(cmd)
  if (curlDl !== null) {
    const prevPath = getCurlDownloadPath(curlDl.url)
    const prevOnDisk = prevPath !== null && commandPathIsTouchable(prevPath, event)
      ? hostPathOfTypedPath(prevPath, preHookCwd ?? process.cwd())
      : null
    if (prevPath !== null && prevOnDisk !== null && !existsSync(prevOnDisk)) {
      // The previously downloaded file is gone (deleted/moved since). Forget the stale session record and let the re-download proceed instead of denying.
      clearCurlDownload(curlDl.url)
    } else if (prevPath !== null && prevOnDisk !== null && statSync(prevOnDisk).size >= loadConfig().hints.bash_dedup_min_bytes) {
      recordStat('session_hint', 0, 0)
      return denyOutput(leadWithCommand(sliceCommand(prevPath, targetFor(prevPath)), 'to read a part of it, or `rg \'<pattern>\' ' + quotedArg(displaySafePath(prevPath)) + '` to search it', 'Already downloaded to ' + prevPath + ' earlier this session.'))
    }
  }

  // curl GET recall — emit a hint when the same URL was already fetched this session. Key on URL only (not the full command) so `curl <url> | jq …` and `curl <url> | python3 …` share the same cache entry.
  if (isCurlGetCommand(cmd)) {
    const curlCacheKey = extractCurlUrl(cmd) ?? cmd
    const curlHash = shortFingerprint(curlCacheKey)
    const curlOutputId = getBashOutputId(curlHash)
    // Guard on the content entry and its freshness, not just the index (see the monitoring case above).
    const curlEntryRaw = curlOutputId !== null ? getBashOutput(curlOutputId) : null
    const curlEntry = curlEntryRaw !== null && !isBashEntryStale(curlEntryRaw, cmd, runDir) ? curlEntryRaw : null
    if (curlOutputId !== null && curlEntry !== null && recallWorthShowing(curlOutputId, curlEntry)) {
      const curlBytes = curlEntry.sizeBytes
      recordStat('bash_compress:recall', curlBytes, savedTokensFromBytes(curlBytes))
      const curlPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      const curlHeading = hintTarget('', 'section', { content: curlEntry.output })
      return contextOutput(
        'curl response cached (`' + curlPreview + '`).' + pipelineDivergenceNote(cmd, curlEntry.command) + ' ' +
        (curlHeading.real
          ? leadWithCommand('token-goat bash-output ' + curlOutputId + ' --section ' + quotedArg(curlHeading.name), 'to read one markdown section, or `token-goat bash-output ' + curlOutputId + '` to recall it all (`--grep PATTERN` filters)')
          : 'Use `token-goat bash-output ' + curlOutputId + '` to recall it. Append `--grep PATTERN` to filter or `--section HeadingName` for a markdown section.'),
      )
    }
  }

  // gh api recall — emit a hint when the same read-only `gh api` GET was already run this session. Key on the command minus output pipes/redirects (endpoint + flags), matching the post-side cache key.
  if (isReadOnlyGhApi(cmd)) {
    const ghHash = bashRecallKey(cmd, runDir)
    const ghOutputId = getBashOutputId(ghHash)
    const ghEntryRaw = ghOutputId !== null ? getBashOutput(ghOutputId) : null
    const ghEntry = ghEntryRaw !== null && !isBashEntryStale(ghEntryRaw, cmd, runDir) ? ghEntryRaw : null
    if (ghOutputId !== null && ghEntry !== null && recallWorthShowing(ghOutputId, ghEntry)) {
      const ghBytes = ghEntry.sizeBytes
      recordStat('bash_compress:recall', ghBytes, savedTokensFromBytes(ghBytes))
      const ghPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'gh api response cached (`' + ghPreview + '`).' + pipelineDivergenceNote(cmd, ghEntry.command) + ' ' +
        'Use `token-goat bash-output ' + ghOutputId + '` to recall it. ' +
        "Append `--jq '.field'` on the original call, or `--grep PATTERN` / `--max-matches N` here, to narrow it.",
      )
    }
  }

  // Scoped git status / git diff --stat recall — `git status --porcelain -- <path>` or `git diff --stat -- <path>` is byte-identical on every rerun until HEAD moves or the working tree changes. The `gitMutable` fingerprint already attached in computeBashFingerprints (HEAD sha + `git status --porcelain` hash) invalidates the instant either happens — including an edit to the scoped path recorded through the normal postEditHandler/dirty-queue flow, since that edit shows up in `git status --porcelain` regardless of whether the reindex queue has drained yet — so this reuses the same staleness check as monitoring/curl/gh-api recall above rather than a bespoke one.
  if (isScopedGitStatusOrDiffStatCommand(cmd)) {
    const gitScopedHash = bashRecallKey(cmd, runDir)
    const gitScopedOutputId = getBashOutputId(gitScopedHash)
    const gitScopedEntryRaw = gitScopedOutputId !== null ? getBashOutput(gitScopedOutputId) : null
    const gitScopedEntry = gitScopedEntryRaw !== null && !isBashEntryStale(gitScopedEntryRaw, cmd, runDir) ? gitScopedEntryRaw : null
    if (gitScopedOutputId !== null && gitScopedEntry !== null && recallWorthShowing(gitScopedOutputId, gitScopedEntry)) {
      const gitScopedBytes = gitScopedEntry.sizeBytes
      recordStat('bash_compress:recall', gitScopedBytes, savedTokensFromBytes(gitScopedBytes))
      const gitScopedPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'Output from `' + gitScopedPreview + '`' + pipelineDivergenceNote(cmd, gitScopedEntry.command) + ' is cached and unchanged (no edits to that path or HEAD since). ' +
        'Use `token-goat bash-output ' + gitScopedOutputId + '` to recall it instead of re-running.',
      )
    }
  }

  // CLI surgical-read dedup: warn on an exact repeat `token-goat symbol|read|section` invocation, and cross-check against the Read-tool ledger (a file already fully Read this session may already cover the same content).
  const tgRead = extractTgSurgicalRead(cmd, runDir)
  if (tgRead !== null) {
    const cliKey = tgRead.sub + '::' + tgRead.spec
    const notes = []
    if (wasCliReadThisSession(cliKey)) {
      notes.push('You already ran this exact `token-goat ' + tgRead.sub + '` query earlier this session — check your context above before re-running it.')
    }
    if (tgRead.filePath !== null && wasFileReadThisSession(tgRead.filePath)) {
      notes.push('`' + tgRead.filePath + '` was already fully read via the Read tool this session — that content may already cover this.')
    }
    if (notes.length > 0) {
      recordStat('session_hint', 0, 0)
      return pathHint(tgRead.filePath !== null ? [tgRead.filePath] : [], notes.join(' '))
    }
    return passOutput()
  }

  if (isTestRunnerCommand(cmd) && isDirectTestRunnerCommand(cmd) && !hasTestRunScopeOrBudget(cmd)) {
    // The compressor supplies a timeout itself. Preserve that stronger existing safeguard instead of replacing its rewrite with an advisory that would leave the test unbounded.
    const compression = maybeCompressRewrite(event, rawCmd, cmd)
    if (compression !== null) return compression

    const key = `test-run-budget:${event.sessionId}:${shortFingerprint(cmd)}`
    if (!wasHintShown(key)) {
      markHintShown(key)
      recordStat('session_hint', 0, 0)
      return contextOutput(
        'This test command has no targeted selector or explicit timeout. Prefer a focused test path/name or the runner’s supported timeout before starting a potentially unbounded suite; run the full suite deliberately when it is needed.',
      )
    }
  }

  // Recognized command: recall a cached prior run, else compress this run. detectFromCommand matches a specific filter (none until the filters land); isBuildCommand is the generic-filter gate for build/test tools. isBuildCommand's patterns are prefix-anchored so a trailing `2>&1` never breaks them, but detectFromCommand rejects any redirect outright (hasRedirect) — so a command recognized only via detectFromCommand (e.g. `npm test`, resolved through its package-manager-script dispatch, not a BUILD_COMMAND_PATTERNS entry) needs the same trailing-`2>&1` allowance maybeCompressRewrite applies below, or it never reaches that function at all.
  if (!isBuildCommand(cmd) && detectFromCommand(stripTrailingStderrRedirect(cmd), runDir ?? undefined) === null) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = bashRecallKey(cmd, runDir)
  const outputId = getBashOutputId(cmdHash)
  // A cached prior run wins: recall it instead of re-running (and re-compressing). Guard on the content blob and its freshness — a pruned id would make `bash-output <id>` error, and a stale fingerprint means the source changed since the output was cached.
  const entryRaw = outputId !== null ? getBashOutput(outputId) : null
  const entry = entryRaw !== null && !isBashEntryStale(entryRaw, cmd, runDir) ? entryRaw : null
  if (outputId !== null && entry !== null && recallWorthShowing(outputId, entry)) {
    const bytes = entry.sizeBytes
    recordStat('bash_compress:recall', bytes, savedTokensFromBytes(bytes))
    return contextOutput(buildRecallHint(cmd, outputId))
  }

  // First run of a recognized command → transparently wrap it in the compressor so its output is structurally compressed before it reaches the model.
  return maybeCompressRewrite(event, rawCmd, cmd) ?? passOutput()
}

/** Public wrapper: intercepts every `context` (hint) output from {@link preBashHandlerInner} for efficacy tracking/suppression — see hint_stats.ts's module doc comment for the category list and honesty design. */
export function preBashHandler(event: HookEvent): HookOutput {
  const output = preBashHandlerInner(event)
  const command = event.toolInput['command']
  // A hint naming a token-goat command that reads a file Claude Code's Read rules cover would lead around them, since Claude Code checks those rules against a cat or sed of the file but never against token-goat; a rewrite was already checked.
  if ((output.hookType === 'deny' || output.hookType === 'context') && !SYNTAX_OUTPUTS.has(output) && typeof command === 'string' && readHintCrossesRule(detectHarness(), getCwd(event) ?? process.cwd(), shellPathWords(command), command, (p) => !commandPathIsTouchable(p, event))) return passOutput()
  return applyHintTracking(event, output, classifyBashHint)
}

// A Codex call loads Codex's rules check first, and a bypassPermissions call the hidden rule check, which rewrite_permission.ts needs before it lets a rewrite ship there.
registerHook('pre_tool_use', loadingHiddenRuleCheck((event) => (detectHarness() === 'codex' ? loadCodexRules().then(() => preBashHandler(event)) : preBashHandler(event))), { toolName: 'Bash' })
