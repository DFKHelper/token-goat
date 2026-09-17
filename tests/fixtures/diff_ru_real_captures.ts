// CAPTURE: literal output of `diff -ru a b` and `diff -r a b` run over two synthetic trees built from 10 files copied
// from src/tool_filters/ (base, dispatch, helpers, git, shell_file, linters, pytest, package_managers, go_test, index):
// a/ holds the originals, b/ holds the same files with `sed -i 's/\bstdout\b/standardOut/g; s/\bstderr\b/standardErr/g' *.ts`
// applied. Regenerate under %TEMP%, never in the repo. CAPTURE_DIFF_RU_9_FILES: `diff -ru a b`, 9 `diff -ru` headers, 1432 non-empty raw lines.
// CAPTURE_DIFF_R_NORMAL: `diff -r a b`, 9 `diff -r` headers, 867 non-empty raw lines (normal format, no unified `@@` hunks).
// See tests/tool_filters_shell_file.test.ts, describe('DiffFilter multi-file diffs under the shipping line cap'), for the provenance comment and must-not-drop assertions.

export const CAPTURE_DIFF_RU_9_FILES = `diff -ru a/base.ts b/base.ts
--- a/base.ts	2026-09-17 15:48:40.621961600 -0500
+++ b/base.ts	2026-09-17 15:48:40.923233400 -0500
@@ -98,7 +98,7 @@
  * Result of running a {@link ToolFilter} over a captured command output.
  *
  * \`text\` is the compressed body (no trailing newline — the wrapper adds one).
- * \`originalBytes\` is \`stdout + stderr\` size post-decode / pre-filter, so
+ * \`originalBytes\` is \`standardOut + standardErr\` size post-decode / pre-filter, so
  * \`percentSaved\` reflects the true reduction the model sees.
  */
 /** Token savings for a byte delta credited by a bash-output compression filter: delegates to {@link savedTokensFromBytes} (bytes/4, stats.ts's single pricing constant) rather than defining its own divisor. This used to divide by 3 (the \`estimateTokensFromLength\` overflow-guard estimator's ratio, deliberately conservative-high for a budget check, which is the wrong direction for a credit -- see the comment on \`savedTokensFromBytes\`), which booked every \`bash_compress:*\` kind roughly a third richer than every sibling kind in the same summed column. Exported so a caller that must recompute the figure against a different byte delta -- notably a delta capped at the harness delivery cap, see \`deliveredOutputBytes\` in src/delivery_cap.ts -- prices it by the same rule rather than deriving a second one that can drift. */
@@ -206,7 +206,7 @@
  * and the trailing compression marker.
  *
  * Set {@link errorPassthrough} to \`true\` to short-circuit to the raw combined
- * output when the command exits non-zero with non-empty stderr — replacing the
+ * output when the command exits non-zero with non-empty standardErr — replacing the
  * \`_preserve_stderr_on_error\` preamble many filters used to duplicate.
  */
 export abstract class ToolFilter {
@@ -237,9 +237,9 @@
       .some((tok) => this.subcommands.has(tok))
   }
 
-  /** Combine stdout/stderr with a \`---\` separator when both are present. */
-  protected combineOutput(stdout: string, stderr: string): string {
-    return combineStreams(stdout, stderr)
+  /** Combine standardOut/standardErr with a \`---\` separator when both are present. */
+  protected combineOutput(standardOut: string, standardErr: string): string {
+    return combineStreams(standardOut, standardErr)
   }
 
   /** Append a \`[token-goat: <joined notes>]\` summary line to \`kept\`. */
@@ -267,12 +267,12 @@
    * Filters that handle errors structurally (pytest, cargo) override this
    * directly and leave \`errorPassthrough\` false.
    */
-  compress(stdout: string, stderr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
+  compress(standardOut: string, standardErr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
     if (this.errorPassthrough) {
-      const err = preserveStderrOnError(stdout, stderr, exitCode)
+      const err = preserveStderrOnError(standardOut, standardErr, exitCode)
       if (err !== null) return err
     }
-    return this.compressBody(stdout, stderr, exitCode, argv, ctx)
+    return this.compressBody(standardOut, standardErr, exitCode, argv, ctx)
   }
 
   /**
@@ -280,9 +280,9 @@
    * Default is a passthrough that joins the two streams — useful when the only
    * compression is the ANSI / progress strip \`apply\` already performed.
    */
-  protected compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[], _ctx: CompressContext = {}): string {
-    if (stderr && stdout) return \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\`
-    return stdout || stderr
+  protected compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[], _ctx: CompressContext = {}): string {
+    if (standardErr && standardOut) return \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\`
+    return standardOut || standardErr
   }
 
   /**
@@ -291,14 +291,14 @@
    * \`apply\` 10-step pipeline. Errors from {@link compress} fall back to a
    * truncated view so the agent always sees something.
    */
-  apply(stdout: string, stderr: string, exitCode: number, argv: string[], opts: ApplyOptions = {}): CompressedOutput {
+  apply(standardOut: string, standardErr: string, exitCode: number, argv: string[], opts: ApplyOptions = {}): CompressedOutput {
     const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
     const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
     const skipProgress = opts.skipProgress ?? false
 
     // Step 1: sanitise — strip null bytes.
-    let so = safeDecode(stdout)
-    let se = safeDecode(stderr)
+    let so = safeDecode(standardOut)
+    let se = safeDecode(standardErr)
 
     // Step 1.5: redact BEFORE any truncator/clipper/capper below ever sees the text. Every
     // truncator in this pipeline (clampKeepingEnds, clipWideLines, capLongLines,
@@ -334,7 +334,7 @@
     if (seClamped !== null) {
       se = seClamped
       if (!notes.some((n) => n.includes('kept both ends'))) {
-        notes.push(\`stderr over \${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)\`)
+        notes.push(\`standardErr over \${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)\`)
       }
     }
 
diff -ru a/dispatch.ts b/dispatch.ts
--- a/dispatch.ts	2026-09-17 15:48:40.650413300 -0500
+++ b/dispatch.ts	2026-09-17 15:48:40.924233300 -0500
@@ -200,8 +200,8 @@
  */
 export function compressOutput(
   filter: ToolFilter,
-  stdout: string,
-  stderr: string,
+  standardOut: string,
+  standardErr: string,
   exitCode: number,
   argv: string[],
   opts: CompressOptions = {},
@@ -213,7 +213,7 @@
   const skipProgress = profile === 'minimal'
   const applyOpts: ApplyOptions = { maxLines: effectiveMaxLines, skipProgress }
   if (opts.maxBytes !== undefined) applyOpts.maxBytes = opts.maxBytes
-  return filter.apply(stdout, stderr, exitCode, argv, applyOpts)
+  return filter.apply(standardOut, standardErr, exitCode, argv, applyOpts)
 }
 
 /**
@@ -239,12 +239,12 @@
  * streams ship untouched (no compression marker) -- exactly as though no filter had
  * matched, EXCEPT redaction: \`compressed\` already ran \`filter.apply()\`, which redacts
  * secret-shaped values before any truncator can cut one below its recognition floor
- * (see base.ts's Step 1.5/9.5 comments). Falling back to the raw \`combineStreams(stdout,
- * stderr)\` here used to throw that redaction away -- a credential in a command whose
+ * (see base.ts's Step 1.5/9.5 comments). Falling back to the raw \`combineStreams(standardOut,
+ * standardErr)\` here used to throw that redaction away -- a credential in a command whose
  * compression didn't clear the net-benefit floor shipped to the model raw, live, on this
  * exact rewrite surface. Re-redacting the raw streams on the fallback path keeps the
  * invariant "the net-benefit gate only ever discards compression, never redaction" true
- * for both branches; it is a no-op whenever nothing in stdout/stderr looked like a secret.
+ * for both branches; it is a no-op whenever nothing in standardOut/standardErr looked like a secret.
  *
  * Callers assemble \`text + marker\` themselves rather than receiving a finished body,
  * because the runner caps tokens BETWEEN the two so the savings marker survives
@@ -253,16 +253,16 @@
  */
 export function deliverCompressed(
   filter: ToolFilter,
-  stdout: string,
-  stderr: string,
+  standardOut: string,
+  standardErr: string,
   exitCode: number,
   argv: string[],
   opts: CompressOptions = {},
 ): DeliveredCompression {
-  const compressed = compressOutput(filter, stdout, stderr, exitCode, argv, opts)
+  const compressed = compressOutput(filter, standardOut, standardErr, exitCode, argv, opts)
   const minNet = resolveMinNetSavingsBytes()
   const applied = compressed.worthApplying(minNet)
-  const text = applied ? compressed.text : redactSecrets(combineStreams(stdout, stderr)).text
+  const text = applied ? compressed.text : redactSecrets(combineStreams(standardOut, standardErr)).text
   const marker = applied ? compressed.withMarker(minNet).slice(compressed.text.length) : ''
   return { applied, text, marker, compressed }
 }
diff -ru a/git.ts b/git.ts
--- a/git.ts	2026-09-17 15:48:40.707476200 -0500
+++ b/git.ts	2026-09-17 15:48:40.926233300 -0500
@@ -4,7 +4,7 @@
 //
 // Dispatch order in GIT_FILTERS: specific subcommand filters first, generic GitFilter last. GitFilter remains the catch-all for every other git subcommand not claimed by a more specific filter.
 //
-// CRLF warning stripping runs via postNormalise on every stream before the per-subcommand compressor sees the text — the base class pipeline calls it after normalise() on both stdout and stderr.
+// CRLF warning stripping runs via postNormalise on every stream before the per-subcommand compressor sees the text — the base class pipeline calls it after normalise() on both standardOut and standardErr.
 
 import { ToolFilter } from './base.js'
 import type { CompressContext } from './base.js'
@@ -196,16 +196,16 @@
 }
 
 /** Collapse commits to one-liner summaries when there are more than 10. */
-function _compressGitLogFull(stdout: string, stderr: string): string {
-  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
-  if (!blocks.length) return stdout
+function _compressGitLogFull(standardOut: string, standardErr: string): string {
+  const blocks = splitBlocks(standardOut, _GIT_LOG_COMMIT_RE)
+  if (!blocks.length) return standardOut
   const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
   const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))
-  if (commits.length <= 10) return stdout
+  if (commits.length <= 10) return standardOut
 
   const collapsed = commits.map((block) => _summariseCommitHeader(block.split('\\n')).join('\\n'))
   let text = (prelude ? prelude + '\\n' : '') + collapsed.join('\\n\\n')
-  if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return text
 }
 
@@ -235,7 +235,7 @@
 }
 
 /** Shared by _compressGitLogPatch/_compressGitLogStat: split into commit blocks, cap each
- *  block via \`capBlock\`, and rejoin with prelude/stderr -- identical shape, only the per-block
+ *  block via \`capBlock\`, and rejoin with prelude/standardErr -- identical shape, only the per-block
  *  truncation differs (patch-line cap vs. stat-file cap). */
 // Git indents a commit message body by exactly four spaces; stat lines start with one space, name-only lines at column 0, numstat/name-status lines with a digit or status letter -- so a four-space-indent test is enough to tell a message-body line from every stat/patch shape this function handles, without needing to know which of those shapes it is looking at.
 const _GIT_LOG_MESSAGE_LINE_RE = /^ {4}/
@@ -253,13 +253,13 @@
 /**
  *  truncation differs (patch-line cap vs. stat-file cap). */
 function _compressGitLogCapped(
-  stdout: string,
-  stderr: string,
+  standardOut: string,
+  standardErr: string,
   capBlock: (block: string) => string,
   maxLines?: number,
 ): string {
-  const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
-  if (!blocks.length) return stdout
+  const blocks = splitBlocks(standardOut, _GIT_LOG_COMMIT_RE)
+  if (!blocks.length) return standardOut
   const prelude = !_GIT_LOG_COMMIT_RE.test(blocks[0]!) ? blocks[0]! : ''
   const commits = blocks.filter((b) => _GIT_LOG_COMMIT_RE.test(b))
 
@@ -272,13 +272,13 @@
   }
 
   let text = (prelude ? prelude + '\\n' : '') + outBlocks.join('\\n')
-  if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return text
 }
 
-function _compressGitLogPatch(stdout: string, stderr: string, maxLines?: number): string {
+function _compressGitLogPatch(standardOut: string, standardErr: string, maxLines?: number): string {
   const MAX_PATCH_LINES = 30
-  return _compressGitLogCapped(stdout, stderr, (block) => _capPatchLinesInBlock(block, MAX_PATCH_LINES), maxLines)
+  return _compressGitLogCapped(standardOut, standardErr, (block) => _capPatchLinesInBlock(block, MAX_PATCH_LINES), maxLines)
 }
 
 /** Compress --stat log: limit file list per commit block. */
@@ -310,15 +310,15 @@
   return newLines.join('\\n')
 }
 
-function _compressGitLogStat(stdout: string, stderr: string, maxLines?: number): string {
+function _compressGitLogStat(standardOut: string, standardErr: string, maxLines?: number): string {
   const MAX_STAT_FILES = 20
-  return _compressGitLogCapped(stdout, stderr, (block) => _capStatLinesInBlock(block, MAX_STAT_FILES), maxLines)
+  return _compressGitLogCapped(standardOut, standardErr, (block) => _capStatLinesInBlock(block, MAX_STAT_FILES), maxLines)
 }
 
 /** Format-aware log compression: dispatch to the right strategy. */
 function _compressGitLogEnhanced(
-  stdout: string,
-  stderr: string,
+  standardOut: string,
+  standardErr: string,
   argv: string[],
   inputTruncated = false,
   maxLines?: number,
@@ -333,7 +333,7 @@
     argv.some((a) => a.startsWith('--format=%h') || a.startsWith('--pretty=%h'))
 
   if (!isOneline) {
-    const nonEmpty = stdout.split('\\n').filter((ln) => ln.trim())
+    const nonEmpty = standardOut.split('\\n').filter((ln) => ln.trim())
     if (nonEmpty.length > 0 && nonEmpty.slice(0, 5).every((ln) => _GIT_LOG_ONELINE_RE.test(ln))) {
       isOneline = true
     }
@@ -361,7 +361,7 @@
       // the non-oneline isStat/isPatch paths already use below.
       const MAX_STAT_FILES = 20
       const MAX_PATCH_LINES = 30
-      blocks = splitBlocks(stdout, _GIT_LOG_ONELINE_RE)
+      blocks = splitBlocks(standardOut, _GIT_LOG_ONELINE_RE)
         .filter((b) => b.trim())
         .map((b) => (isPatch ? _capPatchLinesInBlock(b, MAX_PATCH_LINES) : _capStatLinesInBlock(b, MAX_STAT_FILES)))
     } else {
@@ -370,7 +370,7 @@
       // commit hash at all. Counting every non-empty line as a commit overcounts the
       // elided-commit tally by however many connector-only lines exist, so only count/cap
       // lines that actually carry a commit hash (with or without a graph prefix).
-      blocks = stdout.split('\\n').filter((ln) => ln.trim() && _GIT_LOG_ONELINE_GRAPH_RE.test(ln))
+      blocks = standardOut.split('\\n').filter((ln) => ln.trim() && _GIT_LOG_ONELINE_GRAPH_RE.test(ln))
     }
 
     let keptLines: string[]
@@ -385,22 +385,22 @@
       keptLines = blocks
     }
     let out = keptLines.join('\\n')
-    if (stderr.trim()) out += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+    if (standardErr.trim()) out += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
     return out
   }
 
-  if (isPatch) return _compressGitLogPatch(stdout, stderr, maxLines)
-  if (isStat) return _compressGitLogStat(stdout, stderr, maxLines)
+  if (isPatch) return _compressGitLogPatch(standardOut, standardErr, maxLines)
+  if (isStat) return _compressGitLogStat(standardOut, standardErr, maxLines)
 
-  return _compressGitLogFull(stdout, stderr)
+  return _compressGitLogFull(standardOut, standardErr)
 }
 
 export class GitLogFilter extends GitBaseFilter {
   readonly name = 'git-log'
   override readonly subcommands = new Set(['log'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
-    return _compressGitLogEnhanced(stdout, stderr, argv, ctx.inputTruncated === true, ctx.maxLines)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
+    return _compressGitLogEnhanced(standardOut, standardErr, argv, ctx.inputTruncated === true, ctx.maxLines)
   }
 }
 
@@ -510,8 +510,8 @@
 }
 
 /** Compress --stat diff output: roll up into directory groups when too many files. */
-function _compressGitDiffStat(stdout: string, stderr: string, argv: string[]): string {
-  const lines = stdout.split('\\n')
+function _compressGitDiffStat(standardOut: string, standardErr: string, argv: string[]): string {
+  const lines = standardOut.split('\\n')
   const statLines = lines.filter((ln) => _GIT_DIFF_STAT_FILE_RE.test(ln))
   const summaryLines = lines.filter((ln) => _GIT_DIFF_STAT_SUMMARY_RE.test(ln))
   const otherLines = lines.filter(
@@ -520,7 +520,7 @@
 
   let out: string
   if (statLines.length <= _DIFF_STAT_DIR_ROLLUP_THRESHOLD) {
-    out = stdout
+    out = standardOut
   } else {
     const hasPathspec = argv.includes('--')
     if (hasPathspec) {
@@ -544,7 +544,7 @@
     }
   }
 
-  if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return out
 }
 
@@ -692,13 +692,13 @@
   return result
 }
 
-function _compressGitDiffBody(stdout: string, stderr: string, maxHunksPerFile = 10, maxLines?: number): string {
+function _compressGitDiffBody(standardOut: string, standardErr: string, maxHunksPerFile = 10, maxLines?: number): string {
   const MAX_HUNK_CHANGED = 25
   const HUNK_HEAD_KEEP = 15
   const HUNK_TAIL_KEEP = 5
 
-  const fileBlocks = splitBlocks(stdout, _GIT_DIFF_FILE_RE)
-  if (!fileBlocks.length) return stdout
+  const fileBlocks = splitBlocks(standardOut, _GIT_DIFF_FILE_RE)
+  if (!fileBlocks.length) return standardOut
 
   const outBlocks: string[] = []
   for (const block of fileBlocks) {
@@ -783,15 +783,15 @@
   }
 
   let text = finalBlocks.join('\\n')
-  if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return text
 }
 
 /** Format-aware diff compression. */
-function _compressGitDiffEnhanced(stdout: string, stderr: string, argv: string[], maxLines?: number): string {
+function _compressGitDiffEnhanced(standardOut: string, standardErr: string, argv: string[], maxLines?: number): string {
   const flags = new Set(argv)
   const isStat = flags.has('--stat') || flags.has('--shortstat') || flags.has('--name-only')
-  if (isStat) return _compressGitDiffStat(stdout, stderr, argv)
+  if (isStat) return _compressGitDiffStat(standardOut, standardErr, argv)
   // [bash_diff] max_hunks_per_file (default 10); falls back to _compressGitDiffBody's own
   // built-in default (10) on config load failure.
   let maxHunksPerFile: number | undefined
@@ -801,16 +801,16 @@
     maxHunksPerFile = undefined
   }
   return maxHunksPerFile === undefined
-    ? _compressGitDiffBody(stdout, stderr, undefined, maxLines)
-    : _compressGitDiffBody(stdout, stderr, maxHunksPerFile, maxLines)
+    ? _compressGitDiffBody(standardOut, standardErr, undefined, maxLines)
+    : _compressGitDiffBody(standardOut, standardErr, maxHunksPerFile, maxLines)
 }
 
 export class GitDiffFilter extends GitBaseFilter {
   readonly name = 'git-diff'
   override readonly subcommands = new Set(['diff', 'show'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
-    return _compressGitDiffEnhanced(stdout, stderr, argv, ctx.maxLines)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
+    return _compressGitDiffEnhanced(standardOut, standardErr, argv, ctx.maxLines)
   }
 }
 
@@ -849,16 +849,16 @@
 }
 
 function _compressGitStatusVerbose(
-  stdout: string,
-  stderr: string,
+  standardOut: string,
+  standardErr: string,
   argv: string[] | null = null,
 ): string {
-  const lines = stdout.split('\\n')
-  if (!lines.length) return stdout
+  const lines = standardOut.split('\\n')
+  if (!lines.length) return standardOut
 
   if (_gitStatusIsShort(argv, lines)) {
-    let out = stdout
-    if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
+    let out = standardOut
+    if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
     return out
   }
 
@@ -907,7 +907,7 @@
   flush()
 
   let out = squeezeBlankLines(kept.join('\\n'))
-  if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return out
 }
 
@@ -915,8 +915,8 @@
   readonly name = 'git-status'
   override readonly subcommands = new Set(['status'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    return _compressGitStatusVerbose(stdout, stderr, argv)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    return _compressGitStatusVerbose(standardOut, standardErr, argv)
   }
 }
 
@@ -930,7 +930,7 @@
 const _GIT_BLAME_AUTHOR_LINE_RE = /^author (.+)/
 
 /** Collapse same-commit consecutive runs in annotated blame output. */
-function _compressGitBlameAnnotated(lines: string[], stderr: string): string {
+function _compressGitBlameAnnotated(lines: string[], standardErr: string): string {
   const out: string[] = []
   let currentHash: string | null = null
   let currentAuthor: string | null = null
@@ -972,12 +972,12 @@
   flushRun()
 
   let outText = out.join('\\n')
-  if (stderr.trim()) outText += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) outText += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return outText
 }
 
 /** Collapse same-commit consecutive runs in porcelain blame output. */
-function _compressGitBlamePorcelain(lines: string[], stderr: string): string {
+function _compressGitBlamePorcelain(lines: string[], standardErr: string): string {
   const out: string[] = []
   let currentHash: string | null = null
   let currentAuthor: string | null = null
@@ -1045,24 +1045,24 @@
   flushBlock()
 
   let outText = out.join('\\n')
-  if (stderr.trim()) outText += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) outText += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return outText
 }
 
-function _compressGitBlame(stdout: string, stderr: string): string {
-  const lines = stdout.split('\\n')
-  if (!lines.length) return stdout
+function _compressGitBlame(standardOut: string, standardErr: string): string {
+  const lines = standardOut.split('\\n')
+  if (!lines.length) return standardOut
   const isPorcelain = lines.slice(0, 5).some((ln) => ln.trim() && _GIT_BLAME_PORCELAIN_RE.test(ln))
-  if (isPorcelain) return _compressGitBlamePorcelain(lines, stderr)
-  return _compressGitBlameAnnotated(lines, stderr)
+  if (isPorcelain) return _compressGitBlamePorcelain(lines, standardErr)
+  return _compressGitBlameAnnotated(lines, standardErr)
 }
 
 export class GitBlameFilter extends GitBaseFilter {
   readonly name = 'git-blame'
   override readonly subcommands = new Set(['blame'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    return _compressGitBlame(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    return _compressGitBlame(standardOut, standardErr)
   }
 }
 
@@ -1077,8 +1077,8 @@
 const _GIT_COMMIT_STAT_RE = /^\\s*(\\d+\\s+files?\\s+changed.*)/
 const _DOT_LINE_RE = /^[.\\s]+(?:\\[\\s*\\d+%\\])?$/
 
-function _compressGitCommit(stdout: string, stderr: string): string {
-  const merged = stderr.trim() ? stdout.replace(/\\s+$/, '') + '\\n' + stderr.replace(/\\s+$/, '') : stdout
+function _compressGitCommit(standardOut: string, standardErr: string): string {
+  const merged = standardErr.trim() ? standardOut.replace(/\\s+$/, '') + '\\n' + standardErr.replace(/\\s+$/, '') : standardOut
 
   // Use splitlines behaviour (handles both CRLF and LF)
   const lines = merged.split(/\\r?\\n/)
@@ -1138,8 +1138,8 @@
   readonly name = 'git-commit'
   override readonly subcommands = new Set(['commit'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    return _compressGitCommit(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    return _compressGitCommit(standardOut, standardErr)
   }
 }
 
@@ -1287,8 +1287,8 @@
   return result
 }
 
-function _compressGitPush(stdout: string, stderr: string): string {
-  const merged = stderr.trim() ? stdout.replace(/\\s+$/, '') + '\\n' + stderr.replace(/\\s+$/, '') : stdout
+function _compressGitPush(standardOut: string, standardErr: string): string {
+  const merged = standardErr.trim() ? standardOut.replace(/\\s+$/, '') + '\\n' + standardErr.replace(/\\s+$/, '') : standardOut
   // splitlines() behaviour: handles both CRLF and LF
   let lines = merged.split(/\\r?\\n/)
 
@@ -1386,8 +1386,8 @@
   readonly name = 'git-push'
   override readonly subcommands = new Set(['push'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    return _compressGitPush(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    return _compressGitPush(standardOut, standardErr)
   }
 }
 
@@ -1396,17 +1396,17 @@
 // ---------------------------------------------------------------------------
 
 /** Truncate a listing (ls-files, ls-tree) to first N lines. */
-function _truncateListing(stdout: string, stderr: string, head = 100): string {
-  const lines = stdout.split('\\n')
+function _truncateListing(standardOut: string, standardErr: string, head = 100): string {
+  const lines = standardOut.split('\\n')
   let merged: string
   if (lines.length <= head) {
-    merged = stdout
+    merged = standardOut
   } else {
     merged =
       lines.slice(0, head).join('\\n') +
       \`\\n[token-goat: +\${lines.length - head} more lines elided]\`
   }
-  if (stderr.trim()) merged += '\\n---\\n' + stderr.replace(/\\s+$/, '')
+  if (standardErr.trim()) merged += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
   return merged
 }
 
@@ -1414,10 +1414,10 @@
   /^(?:remote: (?:Counting|Compressing|Total|Enumerating|Receiving|Resolving) objects|Receiving objects:|Resolving deltas:|Unpacking objects:|Updating files:)/
 
 /** Drop remote: counting/compressing progress lines; keep ref updates and errors. */
-function _compressGitRemote(stdout: string, stderr: string): string {
+function _compressGitRemote(standardOut: string, standardErr: string): string {
   const mergedLines = [
-    ...stdout.split('\\n'),
-    ...(stderr.trim() ? ['---', ...stderr.split('\\n')] : []),
+    ...standardOut.split('\\n'),
+    ...(standardErr.trim() ? ['---', ...standardErr.split('\\n')] : []),
   ]
   const kept: string[] = []
   let dropped = 0
@@ -1442,24 +1442,24 @@
     return gitPositionalArgs(argv.slice(1))[0] !== 'grep'
   }
 
-  override compress(stdout: string, stderr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
+  override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
     const positionals = gitPositionalArgs(argv.slice(1))
     const subcommand = positionals[0] ?? ''
     if (subcommand === 'diff' || subcommand === 'show') {
-      // Unreachable today: GitDiffFilter claims both subcommands and is registered ahead of this catch-all, confirmed through selectFilter rather than by reading the registry order. Kept as a fallback against a future registry change, and pointed at the same compressor GitDiffFilter uses. It previously called a second, near-duplicate diff compressor that had drifted from the live one: that copy built its stat-only view by walking only the \`diff --git\` blocks, so every standalone notice between them was dropped without a word, and it returned before appending stderr, so a diff large enough to trigger the stat view discarded whatever git wrote there. Neither defect was reachable, and neither was catchable, which is the argument against keeping a second copy at all.
-      return _compressGitDiffEnhanced(stdout, stderr, argv, ctx.maxLines)
+      // Unreachable today: GitDiffFilter claims both subcommands and is registered ahead of this catch-all, confirmed through selectFilter rather than by reading the registry order. Kept as a fallback against a future registry change, and pointed at the same compressor GitDiffFilter uses. It previously called a second, near-duplicate diff compressor that had drifted from the live one: that copy built its stat-only view by walking only the \`diff --git\` blocks, so every standalone notice between them was dropped without a word, and it returned before appending standardErr, so a diff large enough to trigger the stat view discarded whatever git wrote there. Neither defect was reachable, and neither was catchable, which is the argument against keeping a second copy at all.
+      return _compressGitDiffEnhanced(standardOut, standardErr, argv, ctx.maxLines)
     }
     if (subcommand === 'ls-files' || subcommand === 'ls-tree')
-      return _truncateListing(stdout, stderr, 100)
+      return _truncateListing(standardOut, standardErr, 100)
     if (
       subcommand === 'fetch' ||
       subcommand === 'pull' ||
       subcommand === 'push' ||
       subcommand === 'clone'
     )
-      return _compressGitRemote(stdout, stderr)
+      return _compressGitRemote(standardOut, standardErr)
     // Fallback: ANSI/progress already stripped; dedupe consecutive identical lines.
-    return dedupeCombinedOutput(this.combineOutput(stdout, stderr))
+    return dedupeCombinedOutput(this.combineOutput(standardOut, standardErr))
   }
 }
 
diff -ru a/go_test.ts b/go_test.ts
--- a/go_test.ts	2026-09-17 15:48:40.862999200 -0500
+++ b/go_test.ts	2026-09-17 15:48:40.927266000 -0500
@@ -1,8 +1,8 @@
 // Bespoke \`go test\` output filter — a faithful port of the Python \`GoTestFilter\`.
 //
-// Go test emits a \`=== RUN\` / \`--- PASS:\` pair per testcase plus a final summary; failures interleave stderr blocks. This is its own filter (not the Node test-runner family) because of two Go-specific concerns the family can't model: * \`go test -json\` must pass through UNTOUCHED (compressing it corrupts the machine-readable stream that gotestsum and friends parse). * \`go test -race\` emits \`==========\` / \`WARNING: DATA RACE\` fence blocks that are critical signal — kept verbatim, but with deep goroutine stacks collapsed to the first five frames.
+// Go test emits a \`=== RUN\` / \`--- PASS:\` pair per testcase plus a final summary; failures interleave standardErr blocks. This is its own filter (not the Node test-runner family) because of two Go-specific concerns the family can't model: * \`go test -json\` must pass through UNTOUCHED (compressing it corrupts the machine-readable stream that gotestsum and friends parse). * \`go test -race\` emits \`==========\` / \`WARNING: DATA RACE\` fence blocks that are critical signal — kept verbatim, but with deep goroutine stacks collapsed to the first five frames.
 //
-// Compression model: * Keep — FAIL/ERROR blocks (the stderr captured under the RUN line), the final summary (\`ok …\`, \`FAIL …\`, coverage %), and race blocks. * Drop — \`=== RUN/PAUSE/CONT/NAME\` lines outside FAIL blocks, \`--- PASS:\` lines, and \`go: downloading …\` lines (counted in notes). * Collapse — \`--- SKIP:\` lines (counted separately from PASS).
+// Compression model: * Keep — FAIL/ERROR blocks (the standardErr captured under the RUN line), the final summary (\`ok …\`, \`FAIL …\`, coverage %), and race blocks. * Drop — \`=== RUN/PAUSE/CONT/NAME\` lines outside FAIL blocks, \`--- PASS:\` lines, and \`go: downloading …\` lines (counted in notes). * Collapse — \`--- SKIP:\` lines (counted separately from PASS).
 
 import { ToolFilter } from './base.js'
 import { maybeNote, positionalArgs } from './helpers.js'
@@ -41,11 +41,11 @@
     return positionalArgs(argv.slice(1)).slice(0, 1)[0] === 'test'
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     // \`go test -json\` is already compact and machine-readable; compressing it would corrupt the JSON stream. Pass through.
-    if (argv.includes('-json')) return this.combineOutput(stdout, stderr)
+    if (argv.includes('-json')) return this.combineOutput(standardOut, standardErr)
 
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     let passCount = 0
diff -ru a/helpers.ts b/helpers.ts
--- a/helpers.ts	2026-09-17 15:48:40.679207800 -0500
+++ b/helpers.ts	2026-09-17 15:48:40.929265900 -0500
@@ -116,14 +116,14 @@
 }
 
 /**
- * Combine stdout/stderr with a \`---\` separator when both are present. Shared
+ * Combine standardOut/standardErr with a \`---\` separator when both are present. Shared
  * by {@link ToolFilter.combineOutput} (per-tool compression) and the
  * below-floor original-output fallback in \`bash_runner.ts\`, so "what the
  * agent would have seen with no filter at all" is defined once.
  */
-export function combineStreams(stdout: string, stderr: string): string {
-  if (stderr.trim() && stdout.trim()) return \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\`
-  return stdout.trim() ? stdout.replace(/\\s+$/, '') : stderr.replace(/\\s+$/, '')
+export function combineStreams(standardOut: string, standardErr: string): string {
+  if (standardErr.trim() && standardOut.trim()) return \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\`
+  return standardOut.trim() ? standardOut.replace(/\\s+$/, '') : standardErr.replace(/\\s+$/, '')
 }
 
 // ---------------------------------------------------------------------------
@@ -193,7 +193,7 @@
  * bash-compress single-command wrapper: a backgrounded or newline-separated
  * compound command must never be rewritten into \`token-goat compress -c
  * '<cmd>'\`, since \`spawnSync\`'s piped stdio blocks on the backgrounded
- * grandchild's inherited stdout until it exits or the wrapper times out,
+ * grandchild's inherited standardOut until it exits or the wrapper times out,
  * turning a fire-and-forget dev server into a hang.
  */
 export function hasBareBackgroundOrNewline(cmd: string): boolean {
@@ -662,12 +662,12 @@
 }
 
 /**
- * Combined output when a command failed (non-zero exit) and produced stderr;
+ * Combined output when a command failed (non-zero exit) and produced standardErr;
  * \`null\` otherwise (signalling the caller to continue normal compression).
  */
-export function preserveStderrOnError(stdout: string, stderr: string, exitCode: number): string | null {
-  if (exitCode !== 0 && stderr.trim()) {
-    return stdout.trim() ? \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\` : stderr
+export function preserveStderrOnError(standardOut: string, standardErr: string, exitCode: number): string | null {
+  if (exitCode !== 0 && standardErr.trim()) {
+    return standardOut.trim() ? \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\` : standardErr
   }
   return null
 }
@@ -1178,19 +1178,19 @@
 }
 
 /** Head/tail-truncated dump used when a filter cannot run (over budget / raised). */
-export function fallbackTruncate(stdout: string, stderr: string, maxLines: number): string {
+export function fallbackTruncate(standardOut: string, standardErr: string, maxLines: number): string {
   const half = Math.floor(maxLines / 2)
-  const outLines = truncateMiddle(capLongLines(dedupeConsecutive(stdout.split('\\n'))), half)
-  const errLines = truncateMiddle(capLongLines(dedupeConsecutive(stderr.split('\\n'))), half)
-  if (stderr) return \`\${outLines.join('\\n')}\\n---\\n\${errLines.join('\\n')}\`
+  const outLines = truncateMiddle(capLongLines(dedupeConsecutive(standardOut.split('\\n'))), half)
+  const errLines = truncateMiddle(capLongLines(dedupeConsecutive(standardErr.split('\\n'))), half)
+  if (standardErr) return \`\${outLines.join('\\n')}\\n---\\n\${errLines.join('\\n')}\`
   return outLines.join('\\n')
 }
 
 /** Dedupe consecutive lines in each stream when normalisation alone sufficed. */
-export function compressBashOutput(stdout: string, stderr: string): string {
-  let body = dedupeConsecutive(stdout.split('\\n'), { entropyBypass: true }).join('\\n')
-  if (stderr.trim()) {
-    const err = dedupeConsecutive(stderr.split('\\n'), { entropyBypass: true }).join('\\n')
+export function compressBashOutput(standardOut: string, standardErr: string): string {
+  let body = dedupeConsecutive(standardOut.split('\\n'), { entropyBypass: true }).join('\\n')
+  if (standardErr.trim()) {
+    const err = dedupeConsecutive(standardErr.split('\\n'), { entropyBypass: true }).join('\\n')
     body = \`\${body.replace(/\\s+$/, '')}\\n---\\n\${err.replace(/\\s+$/, '')}\`
   }
   return body
diff -ru a/linters.ts b/linters.ts
--- a/linters.ts	2026-09-17 15:48:40.765568000 -0500
+++ b/linters.ts	2026-09-17 15:48:40.932304800 -0500
@@ -99,8 +99,8 @@
   readonly name = 'ruff'
   override readonly binaries = new Set(['ruff'])
 
-  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const positionals = positionalArgs(argv.slice(1))
     const subcommand = (positionals[0] ?? 'check').toLowerCase()
     if (subcommand === 'format') return this._compressFormat(merged, exitCode)
@@ -324,11 +324,11 @@
     return _isTscCmd(argv)
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const argvFlags = new Set(argv.slice(1).map((a) => a.toLowerCase()))
     const isWatch = argvFlags.has('-w') || argvFlags.has('--watch')
     const isBuild = argvFlags.has('-b') || argvFlags.has('--build')
-    const combined = this.combineOutput(stdout, stderr)
+    const combined = this.combineOutput(standardOut, standardErr)
     if (isWatch) return this._compressWatch(combined)
     if (isBuild) return this._compressBuild(combined)
     return this._compressTypecheck(combined)
@@ -456,8 +456,8 @@
   readonly name = 'eslint'
   override readonly binaries = new Set(['eslint'])
 
-  override compress(stdout: string, stderr: string, exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
 
     // Fast path: truly clean exit -- zero problems, not just zero errors. ESLint exits 0
@@ -568,8 +568,8 @@
   readonly name = 'mypy'
   override readonly binaries = new Set(['mypy', 'dmypy'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     const errorMsgCounts = new Map<string, number>()
@@ -647,8 +647,8 @@
     return (stem === 'npx' || stem === 'pnpx') && argv.length > 1 && argv[1]!.includes('golangci-lint')
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const issueCounts = new Map<string, number>()
     const kept: string[] = []
@@ -755,8 +755,8 @@
   override readonly binaries = new Set(['pylint'])
   private static readonly _KEEP_PER_CODE = 3
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     const codeCounts = new Map<string, number>()
@@ -857,8 +857,8 @@
   override readonly binaries = new Set(['oxlint', 'oxc_linter'])
   private static readonly _KEEP_PER_RULE = 3
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     let deduplicated = 0
@@ -956,8 +956,8 @@
     return stem === 'biome'
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const nonEmpty = lines.filter((ln) => ln.trim())
 
@@ -1045,8 +1045,8 @@
   readonly name = 'linter'
   override readonly binaries = new Set(['pyright', 'pylint', 'stylelint', 'rome'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : ''
 
     if (binary === 'pyright' || binary === 'pylint') {
@@ -1091,8 +1091,8 @@
   override readonly binaries = new Set(['ktlint'])
   private static readonly _KEEP_PER_RULE = 3
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     const ruleCounts = new Map<string, number>()
@@ -1217,11 +1217,11 @@
   readonly name = 'phpstan'
   override readonly binaries = new Set(['phpstan', 'psalm', 'psalm.phar', 'phpstan.phar'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     let binary = argv.length ? pathStem(argv[0]!).toLowerCase() : 'phpstan'
     // psalm.phar → "psalm", phpstan.phar → "phpstan"
     if (binary.endsWith('.phar')) binary = binary.slice(0, -5)
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     if (binary === 'psalm') return this._compressPsalm(lines)
     return this._compressPhpstan(lines)
@@ -1332,14 +1332,14 @@
   override readonly binaries = new Set(['black', 'isort'])
   private static readonly _SAMPLE_SIZE = 5
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : 'black'
-    if (binary === 'isort') return this._compressIsort(stdout, stderr)
-    return this._compressBlack(stdout, stderr)
+    if (binary === 'isort') return this._compressIsort(standardOut, standardErr)
+    return this._compressBlack(standardOut, standardErr)
   }
 
-  private _compressBlack(stdout: string, stderr: string): string {
-    const merged = this.combineOutput(stdout, stderr)
+  private _compressBlack(standardOut: string, standardErr: string): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     const reformatSample: string[] = []
@@ -1364,8 +1364,8 @@
     return this.finalize(out)
   }
 
-  private _compressIsort(stdout: string, stderr: string): string {
-    const merged = this.combineOutput(stdout, stderr)
+  private _compressIsort(standardOut: string, standardErr: string): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     const fixSample: string[] = []
@@ -1412,8 +1412,8 @@
     return (stem === 'npx' || stem === 'pnpx') && argv.length > 1 && argv[1]!.toLowerCase() === 'prettier'
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     const changedSample: string[] = []
@@ -1462,8 +1462,8 @@
   readonly name = 'cppcheck'
   override readonly binaries = new Set(['cppcheck'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     let checkingCount = 0
@@ -1508,8 +1508,8 @@
   readonly name = 'clang-tidy'
   override readonly binaries = new Set(['clang-tidy', 'run-clang-tidy', 'run-clang-tidy.py'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     let warningsGenerated = 0
diff -ru a/package_managers.ts b/package_managers.ts
--- a/package_managers.ts	2026-09-17 15:48:40.822864500 -0500
+++ b/package_managers.ts	2026-09-17 15:48:40.934307100 -0500
@@ -190,9 +190,9 @@
     return false
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const stem = pathStem(argv[0] ?? '').toLowerCase()
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     if (stem === 'npm') return this._compressNpm(merged)
     if (stem === 'yarn') return this._compressYarn(merged)
     if (stem === 'pnpm') return this._compressPnpm(merged)
@@ -306,10 +306,10 @@
     return !DEP_LIST_OWNED_SUBCOMMANDS.has(subcmd)
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const pos = positionalArgs(argv.slice(1))
     const subcmd = pos[0] ?? ''
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     if (subcmd === 'run' && pos.length >= 2) return this._compressRun(merged, pos[1]!)
     if (subcmd === 'exec' || subcmd === 'dlx') return merged
     return this._compressInstall(merged)
@@ -367,8 +367,8 @@
     return !DEP_LIST_OWNED_SUBCOMMANDS.has(subcmd)
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     if (YARN_BERRY_PREFIX_RE.test(merged)) return this._compressBerry(merged)
     return this._compressClassic(merged)
   }
@@ -444,8 +444,8 @@
   readonly name = 'pip'
   override readonly binaries = new Set(['pip', 'pip3', 'pipx'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const pos = positionalArgs(argv.slice(1))
     if (pos[0] === 'list' || pos[0] === 'freeze') return this._compressFreezeList(merged)
     const lines = merged.split('\\n')
@@ -542,11 +542,11 @@
     return false
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const pos = positionalArgs(argv.slice(1))
     const isFreezeOrList =
       pos.length >= 2 && pos[0] === 'pip' && (pos[1] === 'freeze' || pos[1] === 'list')
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     if (isFreezeOrList) return this._compressFreezeList(merged)
     const lines = merged.split('\\n')
     const kept: string[] = []
@@ -590,10 +590,10 @@
     return new Set(['install', 'create', 'update', 'upgrade', 'remove', 'uninstall', 'list', 'env']).has(pos[0]!)
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
     const pos = positionalArgs(argv.slice(1))
     const subcmd = pos[0] ?? ''
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     if (subcmd === 'list') return this._compressPkgList(merged)
     if (subcmd === 'env' && pos.length >= 2 && pos[1] === 'export') return this._compressEnvExport(merged)
     return this._compressInstall(merged)
@@ -692,8 +692,8 @@
   readonly name = 'gem'
   override readonly binaries = new Set(['gem'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const pos = positionalArgs(argv.slice(1))
     const subcommand = (pos[0] ?? '').toLowerCase()
     if (!new Set(['install', 'update', 'upgrade']).has(subcommand)) {
@@ -777,8 +777,8 @@
   override readonly binaries = new Set(['composer', 'composer.phar'])
   override readonly subcommands = new Set(['install', 'update', 'require', 'remove', 'dump-autoload'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     let installCount = 0
@@ -831,8 +831,8 @@
     return stem === 'nuget' || nameLower === 'nuget.exe'
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     let installingCount = 0
@@ -904,13 +904,13 @@
   override readonly binaries = new Set(['conan', 'conan2'])
   override readonly errorPassthrough = true
 
-  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
+  override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
     // errorPassthrough handled by base class — we override compress to also call the body (base calls compressBody via compress when no error).
-    return super.compress(stdout, stderr, exitCode, argv)
+    return super.compress(standardOut, standardErr, exitCode, argv)
   }
 
-  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     let pkgProgressCount = 0
@@ -949,12 +949,12 @@
   override readonly binaries = new Set(['vcpkg'])
   override readonly errorPassthrough = true
 
-  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
-    return super.compress(stdout, stderr, exitCode, argv)
+  override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
+    return super.compress(standardOut, standardErr, exitCode, argv)
   }
 
-  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const combined = this.combineOutput(stdout, stderr)
+  protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     let buildingCount = 0
@@ -1006,8 +1006,8 @@
     return !DEP_LIST_OWNED_SUBCOMMANDS.has(subcmd)
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const pos = positionalArgs(argv.slice(1))
     const isAudit = pos.includes('audit')
     if (isAudit) {
@@ -1166,8 +1166,8 @@
     return super.matches(argv)
   }
 
-  protected override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const merged = this.combineOutput(stdout, stderr)
+  protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     while (lines.length > 0 && !(lines[lines.length - 1]!.trimEnd())) lines.pop()
     if (lines.length <= DEP_LIST_THRESHOLD) return lines.join('\\n')
diff -ru a/pytest.ts b/pytest.ts
--- a/pytest.ts	2026-09-17 15:48:40.794443600 -0500
+++ b/pytest.ts	2026-09-17 15:48:40.935307700 -0500
@@ -49,8 +49,8 @@
   readonly name = 'pytest'
   override readonly binaries: ReadonlySet<string> = new Set(['pytest', 'py.test'])
 
-  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
-    const text = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
+    const text = this.combineOutput(standardOut, standardErr)
     const lines = text.split('\\n')
     let kept: string[] = []
     let passedCount = 0
diff -ru a/shell_file.ts b/shell_file.ts
--- a/shell_file.ts	2026-09-17 15:48:40.735727200 -0500
+++ b/shell_file.ts	2026-09-17 15:48:40.937307100 -0500
@@ -44,8 +44,8 @@
     return false
   }
 
-  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
-    const text = this.combineOutput(stdout, stderr)
+  override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
+    const text = this.combineOutput(standardOut, standardErr)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
     // Under the summarise threshold the raw output ships verbatim, which used to include a 5,000-char hit inside a minified bundle at full length: neither this filter nor apply()'s line/byte caps ever looks at an individual line. Clip those to a window centred on the match instead. The >30-line branch below needs nothing, since it already discards line content entirely.
@@ -206,12 +206,12 @@
   }
 
   // Same per-line clip GrepFilter applies: every branch below can return match lines verbatim, so the cap is applied once here rather than at each of the five return sites.
-  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
-    return clipGrepLines(this._compressBody(stdout, stderr, exitCode, argv), argv)
+  override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
+    return clipGrepLines(this._compressBody(standardOut, standardErr, exitCode, argv), argv)
   }
 
-  private _compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
-    const text = this.combineOutput(stdout, stderr)
+  private _compressBody(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
+    const text = this.combineOutput(standardOut, standardErr)
     if (RgFilter._isFilesOnly(argv) || RgFilter._isCountOnly(argv)) return text
     const lines = text.split('\\n')
     if (lines.length <= _RG_CONTEXT_THRESHOLD) return text
@@ -297,12 +297,12 @@
   override readonly binaries = new Set(['ls', 'll', 'dir'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split(/\\r?\\n/)
     if (lines.length <= _LS_PASSTHROUGH) return merged
     if (LsFilter._isDirExeOutput(lines)) return this._compressDirExe(lines)
@@ -449,12 +449,12 @@
   }
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
@@ -515,12 +515,12 @@
   }
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split(/\\r?\\n/)
     if (lines.length <= _TREE_PASSTHROUGH) return merged
     if (!this._detect(lines)) return merged
@@ -584,12 +584,12 @@
   override readonly binaries = new Set(['fd', 'fdfind', 'find'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
@@ -607,12 +607,12 @@
   override readonly binaries = new Set(['wc'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const stripped = text.split(/\\r?\\n/).map(l => l.trimStart())
     return stripped.join('\\n').trimEnd()
@@ -644,12 +644,12 @@
   override readonly binaries = new Set(['bat', 'batcat'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(stripAnsiCodes(merged))
     const lines = _stripBatBorders(text.split('\\n'))
     const nonEmpty = lines.filter(l => l.trim())
@@ -676,12 +676,12 @@
   override readonly binaries = new Set(['delta'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(stripAnsiCodes(merged))
     const lines = _stripDeltaSeparators(text.split('\\n'))
     const nonEmpty = lines.filter(l => l.trim())
@@ -699,12 +699,12 @@
   override readonly binaries = new Set(['fzf'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
@@ -722,12 +722,12 @@
   override readonly binaries = new Set(['lazygit'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const hasAnsi = merged.includes('\\x1b[') || merged.includes('\\x1b(')
     const isEmpty = !merged.trim()
     if (isEmpty || hasAnsi) {
@@ -746,12 +746,12 @@
   override readonly binaries = new Set(['jq'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
@@ -769,12 +769,12 @@
   override readonly binaries = new Set(['yq'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const text = normalise(merged)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l.trim())
@@ -803,13 +803,13 @@
   override readonly binaries = new Set(['curl', 'wget'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     argv: string[],
   ): string {
     const binary = argv.length ? pathStem(argv[0] ?? '').toLowerCase() : 'curl'
-    const combined = this.combineOutput(stdout, stderr)
+    const combined = this.combineOutput(standardOut, standardErr)
     const lines = combined.split('\\n')
     const kept: string[] = []
     let droppedMeta = 0
@@ -881,12 +881,12 @@
   override readonly binaries = new Set(['rsync'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split('\\n')
     const kept: string[] = []
     let droppedFiles = 0
@@ -1054,13 +1054,13 @@
   override readonly binaries = new Set(['diff', 'diff3', 'sdiff', 'colordiff', 'wdiff'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
     ctx: CompressContext = {},
   ): string {
-    const text = this.combineOutput(stdout, stderr)
+    const text = this.combineOutput(standardOut, standardErr)
     const lines = text.split('\\n')
     const nonEmpty = lines.filter(l => l)
 
@@ -1215,12 +1215,12 @@
   override readonly binaries = new Set(['ffmpeg', 'ffprobe', 'ffplay'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const primary = stderr.trim() ? stderr : stdout
+    const primary = standardErr.trim() ? standardErr : standardOut
     const lines = primary.split('\\n')
 
     const kept: string[] = []
@@ -1356,12 +1356,12 @@
   override readonly binaries = new Set(['xxd', 'hexdump', 'od', 'hd'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split(/\\r?\\n/)
     if (lines.length <= _BIN_INSPECT_PASSTHROUGH) return merged
     const total = lines.length
@@ -1385,12 +1385,12 @@
   override readonly binaries = new Set(['file'])
 
   protected override compressBody(
-    stdout: string,
-    stderr: string,
+    standardOut: string,
+    standardErr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const merged = this.combineOutput(stdout, stderr)
+    const merged = this.combineOutput(standardOut, standardErr)
     const lines = merged.split(/\\r?\\n/)
     if (lines.length <= _FILE_BATCH_LIMIT) return merged
     const remaining = lines.length - _FILE_BATCH_LIMIT
@@ -1449,8 +1449,8 @@
   readonly name = 'ps'
   override readonly binaries = new Set(['ps', 'top', 'pstree', 'tasklist'])
 
-  static detect(stdout: string): boolean {
-    for (const line of stdout.split(/\\r?\\n/)) {
+  static detect(standardOut: string): boolean {
+    for (const line of standardOut.split(/\\r?\\n/)) {
       const stripped = line.trim()
       if (!stripped) continue
       if (stripped.toLowerCase().startsWith('top -')) return true
@@ -1462,13 +1462,13 @@
   }
 
   protected override compressBody(
-    stdout: string,
+    standardOut: string,
     _stderr: string,
     _exitCode: number,
     _argv: string[],
   ): string {
-    const lines = stdout.split(/\\r?\\n/)
-    if (lines.length <= _PS_MIN_LINES) return stdout
+    const lines = standardOut.split(/\\r?\\n/)
+    if (lines.length <= _PS_MIN_LINES) return standardOut
 
     let colHeaderIdx = -1
     for (let i = 0; i < lines.length; i++) {
@@ -1482,7 +1482,7 @@
         break
       }
     }
-    if (colHeaderIdx === -1) return stdout
+    if (colHeaderIdx === -1) return standardOut
 
     const headerUpper = (lines[colHeaderIdx] ?? '').toUpperCase()
     const isTasklist = headerUpper.includes('IMAGE NAME')
@@ -1519,7 +1519,7 @@
       }
     }
 
-    if (suppressedCount === 0) return stdout
+    if (suppressedCount === 0) return standardOut
     while (kept.length && !(kept[kept.length - 1] ?? '').trim()) kept.pop()
     kept.push(\`[suppressed \${suppressedCount} system processes]\`)
     return this.finalize(kept)
`

export const CAPTURE_DIFF_R_NORMAL = `diff -r a/base.ts b/base.ts
101c101
<  * \`originalBytes\` is \`stdout + stderr\` size post-decode / pre-filter, so
---
>  * \`originalBytes\` is \`standardOut + standardErr\` size post-decode / pre-filter, so
209c209
<  * output when the command exits non-zero with non-empty stderr — replacing the
---
>  * output when the command exits non-zero with non-empty standardErr — replacing the
240,242c240,242
<   /** Combine stdout/stderr with a \`---\` separator when both are present. */
<   protected combineOutput(stdout: string, stderr: string): string {
<     return combineStreams(stdout, stderr)
---
>   /** Combine standardOut/standardErr with a \`---\` separator when both are present. */
>   protected combineOutput(standardOut: string, standardErr: string): string {
>     return combineStreams(standardOut, standardErr)
270c270
<   compress(stdout: string, stderr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
---
>   compress(standardOut: string, standardErr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
272c272
<       const err = preserveStderrOnError(stdout, stderr, exitCode)
---
>       const err = preserveStderrOnError(standardOut, standardErr, exitCode)
275c275
<     return this.compressBody(stdout, stderr, exitCode, argv, ctx)
---
>     return this.compressBody(standardOut, standardErr, exitCode, argv, ctx)
283,285c283,285
<   protected compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[], _ctx: CompressContext = {}): string {
<     if (stderr && stdout) return \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\`
<     return stdout || stderr
---
>   protected compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[], _ctx: CompressContext = {}): string {
>     if (standardErr && standardOut) return \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\`
>     return standardOut || standardErr
294c294
<   apply(stdout: string, stderr: string, exitCode: number, argv: string[], opts: ApplyOptions = {}): CompressedOutput {
---
>   apply(standardOut: string, standardErr: string, exitCode: number, argv: string[], opts: ApplyOptions = {}): CompressedOutput {
300,301c300,301
<     let so = safeDecode(stdout)
<     let se = safeDecode(stderr)
---
>     let so = safeDecode(standardOut)
>     let se = safeDecode(standardErr)
337c337
<         notes.push(\`stderr over \${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)\`)
---
>         notes.push(\`standardErr over \${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)\`)
diff -r a/dispatch.ts b/dispatch.ts
203,204c203,204
<   stdout: string,
<   stderr: string,
---
>   standardOut: string,
>   standardErr: string,
216c216
<   return filter.apply(stdout, stderr, exitCode, argv, applyOpts)
---
>   return filter.apply(standardOut, standardErr, exitCode, argv, applyOpts)
242,243c242,243
<  * (see base.ts's Step 1.5/9.5 comments). Falling back to the raw \`combineStreams(stdout,
<  * stderr)\` here used to throw that redaction away -- a credential in a command whose
---
>  * (see base.ts's Step 1.5/9.5 comments). Falling back to the raw \`combineStreams(standardOut,
>  * standardErr)\` here used to throw that redaction away -- a credential in a command whose
247c247
<  * for both branches; it is a no-op whenever nothing in stdout/stderr looked like a secret.
---
>  * for both branches; it is a no-op whenever nothing in standardOut/standardErr looked like a secret.
256,257c256,257
<   stdout: string,
<   stderr: string,
---
>   standardOut: string,
>   standardErr: string,
262c262
<   const compressed = compressOutput(filter, stdout, stderr, exitCode, argv, opts)
---
>   const compressed = compressOutput(filter, standardOut, standardErr, exitCode, argv, opts)
265c265
<   const text = applied ? compressed.text : redactSecrets(combineStreams(stdout, stderr)).text
---
>   const text = applied ? compressed.text : redactSecrets(combineStreams(standardOut, standardErr)).text
diff -r a/git.ts b/git.ts
7c7
< // CRLF warning stripping runs via postNormalise on every stream before the per-subcommand compressor sees the text — the base class pipeline calls it after normalise() on both stdout and stderr.
---
> // CRLF warning stripping runs via postNormalise on every stream before the per-subcommand compressor sees the text — the base class pipeline calls it after normalise() on both standardOut and standardErr.
199,201c199,201
< function _compressGitLogFull(stdout: string, stderr: string): string {
<   const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
<   if (!blocks.length) return stdout
---
> function _compressGitLogFull(standardOut: string, standardErr: string): string {
>   const blocks = splitBlocks(standardOut, _GIT_LOG_COMMIT_RE)
>   if (!blocks.length) return standardOut
204c204
<   if (commits.length <= 10) return stdout
---
>   if (commits.length <= 10) return standardOut
208c208
<   if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
238c238
<  *  block via \`capBlock\`, and rejoin with prelude/stderr -- identical shape, only the per-block
---
>  *  block via \`capBlock\`, and rejoin with prelude/standardErr -- identical shape, only the per-block
256,257c256,257
<   stdout: string,
<   stderr: string,
---
>   standardOut: string,
>   standardErr: string,
261,262c261,262
<   const blocks = splitBlocks(stdout, _GIT_LOG_COMMIT_RE)
<   if (!blocks.length) return stdout
---
>   const blocks = splitBlocks(standardOut, _GIT_LOG_COMMIT_RE)
>   if (!blocks.length) return standardOut
275c275
<   if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
279c279
< function _compressGitLogPatch(stdout: string, stderr: string, maxLines?: number): string {
---
> function _compressGitLogPatch(standardOut: string, standardErr: string, maxLines?: number): string {
281c281
<   return _compressGitLogCapped(stdout, stderr, (block) => _capPatchLinesInBlock(block, MAX_PATCH_LINES), maxLines)
---
>   return _compressGitLogCapped(standardOut, standardErr, (block) => _capPatchLinesInBlock(block, MAX_PATCH_LINES), maxLines)
313c313
< function _compressGitLogStat(stdout: string, stderr: string, maxLines?: number): string {
---
> function _compressGitLogStat(standardOut: string, standardErr: string, maxLines?: number): string {
315c315
<   return _compressGitLogCapped(stdout, stderr, (block) => _capStatLinesInBlock(block, MAX_STAT_FILES), maxLines)
---
>   return _compressGitLogCapped(standardOut, standardErr, (block) => _capStatLinesInBlock(block, MAX_STAT_FILES), maxLines)
320,321c320,321
<   stdout: string,
<   stderr: string,
---
>   standardOut: string,
>   standardErr: string,
336c336
<     const nonEmpty = stdout.split('\\n').filter((ln) => ln.trim())
---
>     const nonEmpty = standardOut.split('\\n').filter((ln) => ln.trim())
364c364
<       blocks = splitBlocks(stdout, _GIT_LOG_ONELINE_RE)
---
>       blocks = splitBlocks(standardOut, _GIT_LOG_ONELINE_RE)
373c373
<       blocks = stdout.split('\\n').filter((ln) => ln.trim() && _GIT_LOG_ONELINE_GRAPH_RE.test(ln))
---
>       blocks = standardOut.split('\\n').filter((ln) => ln.trim() && _GIT_LOG_ONELINE_GRAPH_RE.test(ln))
388c388
<     if (stderr.trim()) out += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>     if (standardErr.trim()) out += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
392,393c392,393
<   if (isPatch) return _compressGitLogPatch(stdout, stderr, maxLines)
<   if (isStat) return _compressGitLogStat(stdout, stderr, maxLines)
---
>   if (isPatch) return _compressGitLogPatch(standardOut, standardErr, maxLines)
>   if (isStat) return _compressGitLogStat(standardOut, standardErr, maxLines)
395c395
<   return _compressGitLogFull(stdout, stderr)
---
>   return _compressGitLogFull(standardOut, standardErr)
402,403c402,403
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
<     return _compressGitLogEnhanced(stdout, stderr, argv, ctx.inputTruncated === true, ctx.maxLines)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
>     return _compressGitLogEnhanced(standardOut, standardErr, argv, ctx.inputTruncated === true, ctx.maxLines)
513,514c513,514
< function _compressGitDiffStat(stdout: string, stderr: string, argv: string[]): string {
<   const lines = stdout.split('\\n')
---
> function _compressGitDiffStat(standardOut: string, standardErr: string, argv: string[]): string {
>   const lines = standardOut.split('\\n')
523c523
<     out = stdout
---
>     out = standardOut
547c547
<   if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
695c695
< function _compressGitDiffBody(stdout: string, stderr: string, maxHunksPerFile = 10, maxLines?: number): string {
---
> function _compressGitDiffBody(standardOut: string, standardErr: string, maxHunksPerFile = 10, maxLines?: number): string {
700,701c700,701
<   const fileBlocks = splitBlocks(stdout, _GIT_DIFF_FILE_RE)
<   if (!fileBlocks.length) return stdout
---
>   const fileBlocks = splitBlocks(standardOut, _GIT_DIFF_FILE_RE)
>   if (!fileBlocks.length) return standardOut
786c786
<   if (stderr.trim()) text += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) text += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
791c791
< function _compressGitDiffEnhanced(stdout: string, stderr: string, argv: string[], maxLines?: number): string {
---
> function _compressGitDiffEnhanced(standardOut: string, standardErr: string, argv: string[], maxLines?: number): string {
794c794
<   if (isStat) return _compressGitDiffStat(stdout, stderr, argv)
---
>   if (isStat) return _compressGitDiffStat(standardOut, standardErr, argv)
804,805c804,805
<     ? _compressGitDiffBody(stdout, stderr, undefined, maxLines)
<     : _compressGitDiffBody(stdout, stderr, maxHunksPerFile, maxLines)
---
>     ? _compressGitDiffBody(standardOut, standardErr, undefined, maxLines)
>     : _compressGitDiffBody(standardOut, standardErr, maxHunksPerFile, maxLines)
812,813c812,813
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
<     return _compressGitDiffEnhanced(stdout, stderr, argv, ctx.maxLines)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
>     return _compressGitDiffEnhanced(standardOut, standardErr, argv, ctx.maxLines)
852,853c852,853
<   stdout: string,
<   stderr: string,
---
>   standardOut: string,
>   standardErr: string,
856,857c856,857
<   const lines = stdout.split('\\n')
<   if (!lines.length) return stdout
---
>   const lines = standardOut.split('\\n')
>   if (!lines.length) return standardOut
860,861c860,861
<     let out = stdout
<     if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>     let out = standardOut
>     if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
910c910
<   if (stderr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) out = out.replace(/\\s+$/, '') + '\\n---\\n' + standardErr.replace(/\\s+$/, '')
918,919c918,919
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     return _compressGitStatusVerbose(stdout, stderr, argv)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     return _compressGitStatusVerbose(standardOut, standardErr, argv)
933c933
< function _compressGitBlameAnnotated(lines: string[], stderr: string): string {
---
> function _compressGitBlameAnnotated(lines: string[], standardErr: string): string {
975c975
<   if (stderr.trim()) outText += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) outText += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
980c980
< function _compressGitBlamePorcelain(lines: string[], stderr: string): string {
---
> function _compressGitBlamePorcelain(lines: string[], standardErr: string): string {
1048c1048
<   if (stderr.trim()) outText += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) outText += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
1052,1054c1052,1054
< function _compressGitBlame(stdout: string, stderr: string): string {
<   const lines = stdout.split('\\n')
<   if (!lines.length) return stdout
---
> function _compressGitBlame(standardOut: string, standardErr: string): string {
>   const lines = standardOut.split('\\n')
>   if (!lines.length) return standardOut
1056,1057c1056,1057
<   if (isPorcelain) return _compressGitBlamePorcelain(lines, stderr)
<   return _compressGitBlameAnnotated(lines, stderr)
---
>   if (isPorcelain) return _compressGitBlamePorcelain(lines, standardErr)
>   return _compressGitBlameAnnotated(lines, standardErr)
1064,1065c1064,1065
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     return _compressGitBlame(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     return _compressGitBlame(standardOut, standardErr)
1080,1081c1080,1081
< function _compressGitCommit(stdout: string, stderr: string): string {
<   const merged = stderr.trim() ? stdout.replace(/\\s+$/, '') + '\\n' + stderr.replace(/\\s+$/, '') : stdout
---
> function _compressGitCommit(standardOut: string, standardErr: string): string {
>   const merged = standardErr.trim() ? standardOut.replace(/\\s+$/, '') + '\\n' + standardErr.replace(/\\s+$/, '') : standardOut
1141,1142c1141,1142
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     return _compressGitCommit(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     return _compressGitCommit(standardOut, standardErr)
1290,1291c1290,1291
< function _compressGitPush(stdout: string, stderr: string): string {
<   const merged = stderr.trim() ? stdout.replace(/\\s+$/, '') + '\\n' + stderr.replace(/\\s+$/, '') : stdout
---
> function _compressGitPush(standardOut: string, standardErr: string): string {
>   const merged = standardErr.trim() ? standardOut.replace(/\\s+$/, '') + '\\n' + standardErr.replace(/\\s+$/, '') : standardOut
1389,1390c1389,1390
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     return _compressGitPush(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     return _compressGitPush(standardOut, standardErr)
1399,1400c1399,1400
< function _truncateListing(stdout: string, stderr: string, head = 100): string {
<   const lines = stdout.split('\\n')
---
> function _truncateListing(standardOut: string, standardErr: string, head = 100): string {
>   const lines = standardOut.split('\\n')
1403c1403
<     merged = stdout
---
>     merged = standardOut
1409c1409
<   if (stderr.trim()) merged += '\\n---\\n' + stderr.replace(/\\s+$/, '')
---
>   if (standardErr.trim()) merged += '\\n---\\n' + standardErr.replace(/\\s+$/, '')
1417c1417
< function _compressGitRemote(stdout: string, stderr: string): string {
---
> function _compressGitRemote(standardOut: string, standardErr: string): string {
1419,1420c1419,1420
<     ...stdout.split('\\n'),
<     ...(stderr.trim() ? ['---', ...stderr.split('\\n')] : []),
---
>     ...standardOut.split('\\n'),
>     ...(standardErr.trim() ? ['---', ...standardErr.split('\\n')] : []),
1445c1445
<   override compress(stdout: string, stderr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
1449,1450c1449,1450
<       // Unreachable today: GitDiffFilter claims both subcommands and is registered ahead of this catch-all, confirmed through selectFilter rather than by reading the registry order. Kept as a fallback against a future registry change, and pointed at the same compressor GitDiffFilter uses. It previously called a second, near-duplicate diff compressor that had drifted from the live one: that copy built its stat-only view by walking only the \`diff --git\` blocks, so every standalone notice between them was dropped without a word, and it returned before appending stderr, so a diff large enough to trigger the stat view discarded whatever git wrote there. Neither defect was reachable, and neither was catchable, which is the argument against keeping a second copy at all.
<       return _compressGitDiffEnhanced(stdout, stderr, argv, ctx.maxLines)
---
>       // Unreachable today: GitDiffFilter claims both subcommands and is registered ahead of this catch-all, confirmed through selectFilter rather than by reading the registry order. Kept as a fallback against a future registry change, and pointed at the same compressor GitDiffFilter uses. It previously called a second, near-duplicate diff compressor that had drifted from the live one: that copy built its stat-only view by walking only the \`diff --git\` blocks, so every standalone notice between them was dropped without a word, and it returned before appending standardErr, so a diff large enough to trigger the stat view discarded whatever git wrote there. Neither defect was reachable, and neither was catchable, which is the argument against keeping a second copy at all.
>       return _compressGitDiffEnhanced(standardOut, standardErr, argv, ctx.maxLines)
1453c1453
<       return _truncateListing(stdout, stderr, 100)
---
>       return _truncateListing(standardOut, standardErr, 100)
1460c1460
<       return _compressGitRemote(stdout, stderr)
---
>       return _compressGitRemote(standardOut, standardErr)
1462c1462
<     return dedupeCombinedOutput(this.combineOutput(stdout, stderr))
---
>     return dedupeCombinedOutput(this.combineOutput(standardOut, standardErr))
diff -r a/go_test.ts b/go_test.ts
3c3
< // Go test emits a \`=== RUN\` / \`--- PASS:\` pair per testcase plus a final summary; failures interleave stderr blocks. This is its own filter (not the Node test-runner family) because of two Go-specific concerns the family can't model: * \`go test -json\` must pass through UNTOUCHED (compressing it corrupts the machine-readable stream that gotestsum and friends parse). * \`go test -race\` emits \`==========\` / \`WARNING: DATA RACE\` fence blocks that are critical signal — kept verbatim, but with deep goroutine stacks collapsed to the first five frames.
---
> // Go test emits a \`=== RUN\` / \`--- PASS:\` pair per testcase plus a final summary; failures interleave standardErr blocks. This is its own filter (not the Node test-runner family) because of two Go-specific concerns the family can't model: * \`go test -json\` must pass through UNTOUCHED (compressing it corrupts the machine-readable stream that gotestsum and friends parse). * \`go test -race\` emits \`==========\` / \`WARNING: DATA RACE\` fence blocks that are critical signal — kept verbatim, but with deep goroutine stacks collapsed to the first five frames.
5c5
< // Compression model: * Keep — FAIL/ERROR blocks (the stderr captured under the RUN line), the final summary (\`ok …\`, \`FAIL …\`, coverage %), and race blocks. * Drop — \`=== RUN/PAUSE/CONT/NAME\` lines outside FAIL blocks, \`--- PASS:\` lines, and \`go: downloading …\` lines (counted in notes). * Collapse — \`--- SKIP:\` lines (counted separately from PASS).
---
> // Compression model: * Keep — FAIL/ERROR blocks (the standardErr captured under the RUN line), the final summary (\`ok …\`, \`FAIL …\`, coverage %), and race blocks. * Drop — \`=== RUN/PAUSE/CONT/NAME\` lines outside FAIL blocks, \`--- PASS:\` lines, and \`go: downloading …\` lines (counted in notes). * Collapse — \`--- SKIP:\` lines (counted separately from PASS).
44c44
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
46c46
<     if (argv.includes('-json')) return this.combineOutput(stdout, stderr)
---
>     if (argv.includes('-json')) return this.combineOutput(standardOut, standardErr)
48c48
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
diff -r a/helpers.ts b/helpers.ts
119c119
<  * Combine stdout/stderr with a \`---\` separator when both are present. Shared
---
>  * Combine standardOut/standardErr with a \`---\` separator when both are present. Shared
124,126c124,126
< export function combineStreams(stdout: string, stderr: string): string {
<   if (stderr.trim() && stdout.trim()) return \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\`
<   return stdout.trim() ? stdout.replace(/\\s+$/, '') : stderr.replace(/\\s+$/, '')
---
> export function combineStreams(standardOut: string, standardErr: string): string {
>   if (standardErr.trim() && standardOut.trim()) return \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\`
>   return standardOut.trim() ? standardOut.replace(/\\s+$/, '') : standardErr.replace(/\\s+$/, '')
196c196
<  * grandchild's inherited stdout until it exits or the wrapper times out,
---
>  * grandchild's inherited standardOut until it exits or the wrapper times out,
665c665
<  * Combined output when a command failed (non-zero exit) and produced stderr;
---
>  * Combined output when a command failed (non-zero exit) and produced standardErr;
668,670c668,670
< export function preserveStderrOnError(stdout: string, stderr: string, exitCode: number): string | null {
<   if (exitCode !== 0 && stderr.trim()) {
<     return stdout.trim() ? \`\${stdout.replace(/\\s+$/, '')}\\n---\\n\${stderr.replace(/\\s+$/, '')}\` : stderr
---
> export function preserveStderrOnError(standardOut: string, standardErr: string, exitCode: number): string | null {
>   if (exitCode !== 0 && standardErr.trim()) {
>     return standardOut.trim() ? \`\${standardOut.replace(/\\s+$/, '')}\\n---\\n\${standardErr.replace(/\\s+$/, '')}\` : standardErr
1181c1181
< export function fallbackTruncate(stdout: string, stderr: string, maxLines: number): string {
---
> export function fallbackTruncate(standardOut: string, standardErr: string, maxLines: number): string {
1183,1185c1183,1185
<   const outLines = truncateMiddle(capLongLines(dedupeConsecutive(stdout.split('\\n'))), half)
<   const errLines = truncateMiddle(capLongLines(dedupeConsecutive(stderr.split('\\n'))), half)
<   if (stderr) return \`\${outLines.join('\\n')}\\n---\\n\${errLines.join('\\n')}\`
---
>   const outLines = truncateMiddle(capLongLines(dedupeConsecutive(standardOut.split('\\n'))), half)
>   const errLines = truncateMiddle(capLongLines(dedupeConsecutive(standardErr.split('\\n'))), half)
>   if (standardErr) return \`\${outLines.join('\\n')}\\n---\\n\${errLines.join('\\n')}\`
1190,1193c1190,1193
< export function compressBashOutput(stdout: string, stderr: string): string {
<   let body = dedupeConsecutive(stdout.split('\\n'), { entropyBypass: true }).join('\\n')
<   if (stderr.trim()) {
<     const err = dedupeConsecutive(stderr.split('\\n'), { entropyBypass: true }).join('\\n')
---
> export function compressBashOutput(standardOut: string, standardErr: string): string {
>   let body = dedupeConsecutive(standardOut.split('\\n'), { entropyBypass: true }).join('\\n')
>   if (standardErr.trim()) {
>     const err = dedupeConsecutive(standardErr.split('\\n'), { entropyBypass: true }).join('\\n')
diff -r a/linters.ts b/linters.ts
102,103c102,103
<   override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
327c327
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
331c331
<     const combined = this.combineOutput(stdout, stderr)
---
>     const combined = this.combineOutput(standardOut, standardErr)
459,460c459,460
<   override compress(stdout: string, stderr: string, exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
571,572c571,572
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
650,651c650,651
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
758,759c758,759
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
860,861c860,861
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
959,960c959,960
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
1048,1049c1048,1049
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
1094,1095c1094,1095
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
1220c1220
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
1224c1224
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
1335c1335
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
1337,1338c1337,1338
<     if (binary === 'isort') return this._compressIsort(stdout, stderr)
<     return this._compressBlack(stdout, stderr)
---
>     if (binary === 'isort') return this._compressIsort(standardOut, standardErr)
>     return this._compressBlack(standardOut, standardErr)
1341,1342c1341,1342
<   private _compressBlack(stdout: string, stderr: string): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   private _compressBlack(standardOut: string, standardErr: string): string {
>     const merged = this.combineOutput(standardOut, standardErr)
1367,1368c1367,1368
<   private _compressIsort(stdout: string, stderr: string): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   private _compressIsort(standardOut: string, standardErr: string): string {
>     const merged = this.combineOutput(standardOut, standardErr)
1415,1416c1415,1416
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
1465,1466c1465,1466
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
1511,1512c1511,1512
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
diff -r a/package_managers.ts b/package_managers.ts
193c193
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
195c195
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
309c309
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
312c312
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
370,371c370,371
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
447,448c447,448
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
545c545
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
549c549
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
593c593
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
596c596
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
695,696c695,696
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
780,781c780,781
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
834,835c834,835
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
907c907
<   override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
909c909
<     return super.compress(stdout, stderr, exitCode, argv)
---
>     return super.compress(standardOut, standardErr, exitCode, argv)
912,913c912,913
<   protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
952,953c952,953
<   override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
<     return super.compress(stdout, stderr, exitCode, argv)
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
>     return super.compress(standardOut, standardErr, exitCode, argv)
956,957c956,957
<   protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const combined = this.combineOutput(stdout, stderr)
---
>   protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const combined = this.combineOutput(standardOut, standardErr)
1009,1010c1009,1010
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
1169,1170c1169,1170
<   protected override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const merged = this.combineOutput(stdout, stderr)
---
>   protected override compressBody(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const merged = this.combineOutput(standardOut, standardErr)
diff -r a/pytest.ts b/pytest.ts
52,53c52,53
<   override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
<     const text = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, _argv: string[]): string {
>     const text = this.combineOutput(standardOut, standardErr)
diff -r a/shell_file.ts b/shell_file.ts
47,48c47,48
<   override compress(stdout: string, stderr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
<     const text = this.combineOutput(stdout, stderr)
---
>   override compress(standardOut: string, standardErr: string, _exitCode: number, argv: string[], ctx: CompressContext = {}): string {
>     const text = this.combineOutput(standardOut, standardErr)
209,210c209,210
<   override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
<     return clipGrepLines(this._compressBody(stdout, stderr, exitCode, argv), argv)
---
>   override compress(standardOut: string, standardErr: string, exitCode: number, argv: string[]): string {
>     return clipGrepLines(this._compressBody(standardOut, standardErr, exitCode, argv), argv)
213,214c213,214
<   private _compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
<     const text = this.combineOutput(stdout, stderr)
---
>   private _compressBody(standardOut: string, standardErr: string, _exitCode: number, argv: string[]): string {
>     const text = this.combineOutput(standardOut, standardErr)
300,301c300,301
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
305c305
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
452,453c452,453
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
457c457
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
518,519c518,519
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
523c523
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
587,588c587,588
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
592c592
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
610,611c610,611
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
615c615
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
647,648c647,648
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
652c652
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
679,680c679,680
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
684c684
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
702,703c702,703
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
707c707
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
725,726c725,726
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
730c730
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
749,750c749,750
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
754c754
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
772,773c772,773
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
777c777
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
806,807c806,807
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
812c812
<     const combined = this.combineOutput(stdout, stderr)
---
>     const combined = this.combineOutput(standardOut, standardErr)
884,885c884,885
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
889c889
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
1057,1058c1057,1058
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
1063c1063
<     const text = this.combineOutput(stdout, stderr)
---
>     const text = this.combineOutput(standardOut, standardErr)
1218,1219c1218,1219
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
1223c1223
<     const primary = stderr.trim() ? stderr : stdout
---
>     const primary = standardErr.trim() ? standardErr : standardOut
1359,1360c1359,1360
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
1364c1364
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
1388,1389c1388,1389
<     stdout: string,
<     stderr: string,
---
>     standardOut: string,
>     standardErr: string,
1393c1393
<     const merged = this.combineOutput(stdout, stderr)
---
>     const merged = this.combineOutput(standardOut, standardErr)
1452,1453c1452,1453
<   static detect(stdout: string): boolean {
<     for (const line of stdout.split(/\\r?\\n/)) {
---
>   static detect(standardOut: string): boolean {
>     for (const line of standardOut.split(/\\r?\\n/)) {
1465c1465
<     stdout: string,
---
>     standardOut: string,
1470,1471c1470,1471
<     const lines = stdout.split(/\\r?\\n/)
<     if (lines.length <= _PS_MIN_LINES) return stdout
---
>     const lines = standardOut.split(/\\r?\\n/)
>     if (lines.length <= _PS_MIN_LINES) return standardOut
1485c1485
<     if (colHeaderIdx === -1) return stdout
---
>     if (colHeaderIdx === -1) return standardOut
1522c1522
<     if (suppressedCount === 0) return stdout
---
>     if (suppressedCount === 0) return standardOut
`
