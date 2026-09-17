// CAPTURE: literal output of `git diff --no-color dd3860dc~1 dd3860dc` run in this repo (both SHAs on main); 9 files, 346 raw lines, 29217 bytes.
// See tests/tool_filters_git.test.ts, describe("GitDiffFilter multi-file diffs under the shipping line cap"), for the provenance comment and must-not-drop assertions.

export const CAPTURE_DIFF_9_FILES = `diff --git a/CHANGELOG.md b/CHANGELOG.md
index f07dc0d4..2fb4c74b 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -29,6 +29,8 @@ All notable changes to Token-Goat are documented in this file. Format follows Ke
 
 ### Fixed
 
+- **The PDF, Word, PowerPoint and Excel readers no longer load on every hook call**: a hook fires before every tool call and parses the whole eagerly reachable half of its bundle before running any of it, and the four document readers (pdfjs, the OOXML and zip machinery, the spreadsheet reader) were reachable from the indexer's document bridge even though the predicate that decides whether a file is one of those formats only looks at its extension. They are now imported where they are used, which takes 69 KB off what every hook call has to parse.
+- **Three output filters no longer drop the line you ran the command to see**: \`git status -vv\` collapsed its file listing into a bare count no matter how short it was, so the one modified file in a clean tree printed as \`1 file\` instead of its name; \`aws s3\` compression matched only \`upload failed:\` and \`download failed:\`, dropping the \`copy failed:\`, \`delete failed:\` and \`move failed:\` lines the CLI emits for bucket-to-bucket copies, \`rm\` and \`mv\`, and dropping them into the progress-line count so the summary read as a clean run (reachable when the command is run with \`2>&1\`, since a separated stderr and non-zero exit already hand back the raw output untouched), and \`aws s3 rm\` was not routed to that compressor at all, so its failures were counted by nothing; and \`kubectl describe pod\` discarded \`Last State:\` and \`Container ID:\`, which is where a \`CrashLoopBackOff\`'s actual exit code and the previous container's identity live. Each filter now keeps the line and, where it summarises, counts failures in their own note rather than folding them in with successes.
 - **A repository can no longer put words in token-goat's mouth through a read hint**: hints name real headings and symbols out of the index, and a repository picks those names. token-goat speaks to the model on two channels, and only one of them was covered: a blocked read has its whole message escaped, an advisory note does not. So a heading named after token-goat's own prefix arrived in the model's context looking like token-goat had said it. Escaping the name was not enough on its own, because the suggested command is compared literally and an escaped name never resolves, which would have traded a forged line for a broken instruction. Such a name is now left out of the suggestion entirely and the hint moves on to the next real heading, so the line stays both attributable and runnable; ordinary names are untouched. The same gap in the hint that recalls saved tool output, where the file's path was shown unescaped, is closed too, and the check that is supposed to catch this class now asserts the escaping at that site instead of describing it.
 - **Editing the chunker or a document extractor now discards the vectors it made stale**: semantic search stores a vector per chunk, and the record of what produced those vectors named only the model, its pinned revision, and the inference runtime. Nothing named the code that turns a file into chunks, so changing how text is split, how a PDF or Word document is read, or how the final vector is pooled left every already-embedded file holding vectors from the old code, and a re-index reported those files skipped. That record now also names the embedding stack itself, so such a change is treated exactly like a model change: the stale vectors are discarded and rebuilt. A new guard walks the import graph from the embedding entry points and fails if any module it reaches is neither covered nor carrying a written reason it cannot affect what gets embedded.
 - **The parse-freshness digest now covers every source that decides what gets extracted**: \`PARSER_FINGERPRINT\` is stamped beside each indexed file's content hash so that changing extraction logic reindexes files whose content never moved. It was computed from \`src/parser.ts\` and the language adapters alone, which left out the table mapping every extension and basename to a language and an extraction method, the language-detection and content-sniffing functions, the reference extractor, the symbol-body size cap, and the helper fourteen adapters use to compute where a symbol ends. Editing any of those left the digest unchanged, so every already-indexed file passed the freshness check and kept symbol rows the current build would no longer produce. A new guard walks the import graph from \`src/parser.ts\` and fails if any module it reaches is neither hashed nor carrying a written reason it cannot affect extraction, so the next module added there cannot be left out silently.
diff --git a/src/doc_embed_extract.ts b/src/doc_embed_extract.ts
index 8e9cc022..255fa8a9 100644
--- a/src/doc_embed_extract.ts
+++ b/src/doc_embed_extract.ts
@@ -1,11 +1,8 @@
 /** Extracted-text bridge from the binary-document readers (pdf, docx, pptx, xlsx) into the embeddings/chunking pipeline, so \`token-goat semantic\` can answer questions from spec PDFs, design docs, decks, and spreadsheets, not just git-tracked plain-text source. Reuses the same extraction modules the read-only pdf-read/docx/pptx/xlsx CLI commands already use -- this file only dispatches by extension and normalizes each format's output into one text blob. */
 import * as path from 'node:path'
 
+// Only the error class is imported statically. The four format readers pull in pdfjs, the OOXML/zip machinery and the xlsx reader -- together the largest single block in the hook bundle's eager set -- and every hook that reaches parser.ts for a hint pays to parse all of it, while \`isEmbeddableDocument\` below answers from an extension alone and the extraction path runs for a handful of files during an index. So each reader is imported where it is used, the same way parser.ts already defers languages/registry.ts. \`document_refusal.js\` stays static because the two predicates below are synchronous \`instanceof\` checks and it carries nothing heavy.
 import { DocumentRefusedError } from './document_refusal.js'
-import { extractPdfText, readPdfFileWithinBounds } from './pdf_extract.js'
-import { docxText } from './docx_extract.js'
-import { pptxAllSlidesText } from './pptx_extract.js'
-import { allSheetsHeadText } from './xlsx_extract.js'
 
 const EMBEDDABLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])
 
@@ -31,17 +28,18 @@ export async function extractEmbeddableDocumentText(filePath: string): Promise<s
   switch (path.extname(filePath).toLowerCase()) {
     case '.pdf': {
       // The indexer reaches this unprompted, for every PDF in a repository the user has just cloned, and nobody is watching what it costs. So the bounds matter more here than at the CLI: without them a single crafted file crash-loops the background worker.
+      const { extractPdfText, readPdfFileWithinBounds } = await import('./pdf_extract.js')
       const { text } = await extractPdfText(await readPdfFileWithinBounds(filePath))
       return text
     }
     case '.docx':
-      return await docxText(filePath)
+      return await (await import('./docx_extract.js')).docxText(filePath)
     case '.pptx':
       // pptxAllSlidesText reads the archive once and reuses it across every slide, rather than looping pptxSlideText (one full archive read+reinflate per call) once per slide -- see its own doc comment for why that used to cost N+1 reads for an N-slide deck.
-      return await pptxAllSlidesText(filePath, true)
+      return await (await import('./pptx_extract.js')).pptxAllSlidesText(filePath, true)
     case '.xlsx':
       // Same shape as the pptx case above: allSheetsHeadText loads the workbook once and reuses it across every sheet, rather than looping headSheet (one full archive read+reparse of every sheet, per sheet requested).
-      return await allSheetsHeadText(filePath, XLSX_SHEET_ROW_CAP)
+      return await (await import('./xlsx_extract.js')).allSheetsHeadText(filePath, XLSX_SHEET_ROW_CAP)
     default:
       return null
   }
diff --git a/src/embed_fingerprint.ts b/src/embed_fingerprint.ts
index 494cc05d..5a66ffd9 100644
--- a/src/embed_fingerprint.ts
+++ b/src/embed_fingerprint.ts
@@ -1,4 +1,4 @@
 // GENERATED FILE -- do not edit by hand. Run \`npm run parser:fingerprint\` to regenerate.
 //
 // A digest of the embedding-decision sources returned by embedFingerprintSources() in scripts/parser-fingerprint.mjs, folded into embeddingProvenance() (src/embeddings.ts) alongside the model name, its pinned revision, and the inference backend. A mismatch there is treated as a stack change: ensureEmbeddingProvenance discards every stored vector and re-embeds. Before this existed, a chunker or document-extractor change left every already-embedded file's vectors built by the old code indefinitely, because content and model identity were the only keys.
-export const EMBED_FINGERPRINT = '0db814dbd72a53c6'
+export const EMBED_FINGERPRINT = 'b31c57d3e2f75c8d'
diff --git a/src/tool_filters/cloud.ts b/src/tool_filters/cloud.ts
index 7d26ee0c..04d2d6b4 100644
--- a/src/tool_filters/cloud.ts
+++ b/src/tool_filters/cloud.ts
@@ -435,8 +435,9 @@ export const awsFilter = new AwsFilter()
 
 const _AWS_UPLOAD_RE = /^upload:\\s+\\S+\\s+to\\s+s3:\\/\\//i
 const _AWS_DOWNLOAD_RE = /^download:\\s+s3:\\/\\//i
-const _AWS_S3_PROGRESS_RE =
-  /^(?:Completed\\s+\\d|\\d+(?:\\.\\d+)?\\s*(?:KiB|MiB|GiB|B)\\/s|Calculating|upload\\s+failed:|download\\s+failed:)/i
+// Every transfer type aws-cli can report, not just the two the progress regex used to swallow: its ResultPrinter renders one FAILURE_FORMAT of \`{transfer_type} failed: ...\`, so \`aws s3 cp\` between two buckets reports \`copy failed:\` and \`rm\`/\`mv\` report \`delete failed:\`/\`move failed:\`. Each of those four subcommands is routed to _compressS3Transfer (see isS3Transfer) -- a type matched here but not routed there would be an unreachable alternative, which is what \`delete\` was until \`rm\` was added.
+const _AWS_S3_TRANSFER_FAILED_RE = /^(?:upload|download|copy|delete|move)\\s+failed:/i
+const _AWS_S3_PROGRESS_RE = /^(?:Completed\\s+\\d|\\d+(?:\\.\\d+)?\\s*(?:KiB|MiB|GiB|B)\\/s|Calculating)/i
 
 // AWS CLI's documented global options that take a separate value token (as opposed to a
 // no-value boolean like --debug/--no-verify-ssl, or a \`--flag=value\` form already handled by
@@ -479,7 +480,8 @@ export class AwsCliFilter extends ToolFilter {
     const isS3Transfer =
       positionals.length >= 2 &&
       positionals[0] === 's3' &&
-      (positionals[1] === 'cp' || positionals[1] === 'sync' || positionals[1] === 'mv')
+      // \`rm\` belongs here for the failure path, not the volume one: \`aws s3 rm --recursive\` reports \`delete failed:\` per object, and routing it anywhere else meant those lines were never counted. Its \`delete:\` success lines are not folded into a count -- only \`upload:\`/\`download:\` are -- so adding it drops nothing that used to survive.
+      (positionals[1] === 'cp' || positionals[1] === 'sync' || positionals[1] === 'mv' || positionals[1] === 'rm')
     const isCfnEvents =
       positionals.length >= 2 &&
       positionals[0] === 'cloudformation' &&
@@ -521,16 +523,19 @@ export class AwsCliFilter extends ToolFilter {
     const kept: string[] = []
     let uploadCount = 0
     let downloadCount = 0
+    let failedCount = 0
     let progressDropped = 0
     for (const line of lines) {
       if (_AWS_UPLOAD_RE.test(line)) { uploadCount++; continue }
       if (_AWS_DOWNLOAD_RE.test(line)) { downloadCount++; continue }
+      if (_AWS_S3_TRANSFER_FAILED_RE.test(line)) { failedCount++; kept.push(line); continue } // a failed transfer is always kept in full, never folded into the progress-line count, and counted in its own note -- the success counts alone read as a clean run, which is what made a dropped \`upload failed:\` line report the opposite of what happened
       if (_AWS_S3_PROGRESS_RE.test(line)) { progressDropped++; continue }
       kept.push(line)
     }
     const notes: string[] = []
     maybeNote(notes, uploadCount, \`uploaded \${uploadCount} file(s)\`)
     maybeNote(notes, downloadCount, \`downloaded \${downloadCount} file(s)\`)
+    maybeNote(notes, failedCount, \`\${failedCount} transfer(s) failed\`)
     maybeNote(notes, progressDropped, \`dropped \${progressDropped} progress line(s)\`)
     this.emitNotes(kept, notes)
     return this.finalize(kept)
diff --git a/src/tool_filters/containers.ts b/src/tool_filters/containers.ts
index 2f03b9be..49b51bc1 100644
--- a/src/tool_filters/containers.ts
+++ b/src/tool_filters/containers.ts
@@ -292,9 +292,10 @@ function _compressKubectlEvents(text: string): string {
   return kept.join('\\n')
 }
 
+// \`Last State:\` must be listed alongside \`State:\`: kubectl's describe printer (kubectl/pkg/describe/describe.go, describeContainerStatus) emits both headers for a container that crashed before recovering, and dropping \`Last State:\` with no else branch left \`Reason:\`/\`Exit Code:\`/\`Started:\`/\`Finished:\` from the crash record sitting directly under the surviving \`State: Running\` line with nothing to say they belong to the past, reattributing a resolved crash to the container's current state. \`Container ID:\` is added for the same reason: without it, \`Restart Count: N\` has no crash record left to explain it. \`Image ID:\` is left out on purpose -- it is a long, low-signal digest that duplicates \`Image:\` (already kept) without adding diagnostic value, unlike \`Container ID:\`, which is what ties a crash record to a specific container instance.
 const _KEY_PREFIXES = [
-  'Name:', 'Namespace:', 'Status:', 'State:', 'Node:', 'IP:', 'PodIP:',
-  'NodeIP:', 'QoS Class:', 'Priority:', 'Image:', 'Ready:', 'Restart Count:',
+  'Name:', 'Namespace:', 'Status:', 'State:', 'Last State:', 'Node:', 'IP:', 'PodIP:',
+  'NodeIP:', 'QoS Class:', 'Priority:', 'Image:', 'Container ID:', 'Ready:', 'Restart Count:',
   'Started:', 'Finished:', 'Exit Code:', 'Reason:', 'Message:',
   'Replicas:', 'StrategyType:', 'Selector:', 'Type:', 'ClusterIP:',
   'Limits:', 'Requests:', 'cpu:', 'memory:',
diff --git a/src/tool_filters/git.ts b/src/tool_filters/git.ts
index 714e59ee..1b5dacd5 100644
--- a/src/tool_filters/git.ts
+++ b/src/tool_filters/git.ts
@@ -781,13 +781,20 @@ function _compressGitStatusVerbose(
   const kept: string[] = []
   let section: string | null = null
   let counts: Record<string, number> = {}
+  let fileLines: string[] = []
 
+  // A section's file lines are the whole point of running \`git status\` -- collapsing them to a bare count on a small working tree throws away the answer the command exists to give. Only fold to counts once the list itself is long enough to be the noise, reusing \`_DIFF_STAT_DIR_ROLLUP_THRESHOLD\` rather than inventing a second number. The threshold is applied per section, not across the whole status, which is a deliberate difference from \`_compressGitDiffStat\`'s global count: a section is the unit a reader scans, so a tree with a handful of staged files and a hundred untracked ones should name the staged ones and collapse the untracked list, which a global count would refuse to do.
   function flush(): void {
-    if (section !== null && section !== 'unmerged' && Object.keys(counts).length) {
-      const parts = Object.entries(counts).map(([label, n]) => \`\${n} \${label}\`)
-      kept.push('\\t' + parts.join(', '))
+    if (section !== null && section !== 'unmerged' && fileLines.length) {
+      if (fileLines.length > _DIFF_STAT_DIR_ROLLUP_THRESHOLD) {
+        const parts = Object.entries(counts).map(([label, n]) => \`\${n} \${label}\`)
+        kept.push('\\t' + parts.join(', '))
+      } else {
+        kept.push(...fileLines)
+      }
     }
     counts = {}
+    fileLines = []
   }
 
   for (const line of lines) {
@@ -805,6 +812,7 @@ function _compressGitStatusVerbose(
       } else {
         const label = _gitStatusFileLabel(line, section)
         counts[label] = (counts[label] ?? 0) + 1
+        fileLines.push(line)
       }
       continue
     }
diff --git a/tests/tool_filters_cloud.test.ts b/tests/tool_filters_cloud.test.ts
index f34a5814..dd39b830 100644
--- a/tests/tool_filters_cloud.test.ts
+++ b/tests/tool_filters_cloud.test.ts
@@ -317,6 +317,56 @@ describe('AwsCliFilter', () => {
     expect(text).not.toContain('upload: ./file-1.js')
   })
 
+  // CAPTURE: the failure line is real \`aws s3 cp\` output from the aws-cli installed on this machine, pointed at an unreachable endpoint (\`aws --endpoint-url http://localhost:1 --no-sign-request s3 cp AGENTS.md s3://bucket/AGENTS.md\`), copied verbatim apart from the file and bucket names. Suppressing each stream in turn showed aws writes it to stderr and exits 1, which matters for which path this test has to drive: with the streams separated, \`errorPassthrough\` hands back the raw output and the compressor never runs, so the only way a failure line reaches \`_compressS3Transfer\` is with stderr folded into stdout -- \`aws s3 sync . s3://b 2>&1\`, or any wrapper that merges them -- where \`preserveStderrOnError\` sees an empty stderr and declines. That is the shape driven here, and it is where the line used to be swallowed as progress noise. The multi-line success/failure interleaving matches the same FAILURE_FORMAT aws-cli's ResultPrinter renders for every transfer type.
+  it('keeps a failed transfer line in full and counts it separately from successes', () => {
+    const text =
+      'upload: ./file1.txt to s3://mybucket/file1.txt\\n' +
+      'upload failed: ./secret.txt to s3://mybucket/secret.txt Could not connect to the endpoint URL: "http://localhost:1/mybucket/secret.txt"\\n' +
+      'upload: ./file3.txt to s3://mybucket/file3.txt\\n'
+    const { text: result } = apply(f, text, '', 1, ['aws', 's3', 'sync', '.', 's3://mybucket'])
+    // must-not-drop: the failure line, verbatim, is the entire point of this output
+    expect(result).toContain('upload failed: ./secret.txt to s3://mybucket/secret.txt Could not connect to the endpoint URL: "http://localhost:1/mybucket/secret.txt"')
+    expect(result).toContain('uploaded 2')
+    // the summary must say a transfer failed rather than only counting the ones that worked -- the success count alone reads as a clean run, and a failure folded into the dropped-progress count read as one too
+    expect(result).toContain('1 transfer(s) failed')
+    expect(result).not.toMatch(/uploaded 3\\b/)
+    expect(result).not.toMatch(/dropped 1 progress/)
+  })
+
+  // FORMAT-DERIVED: \`copy failed:\` is the same FAILURE_FORMAT with a different transfer_type, which \`aws s3 cp\` between two buckets emits -- aws-cli's \`awscli/customizations/s3/results.py\` renders one format string for every type, so matching only upload and download left the bucket-to-bucket case counted as nothing at all. The routing for this filter already accepts \`cp\`.
+  it('counts a bucket-to-bucket copy failure as a failed transfer', () => {
+    const text =
+      'copy: s3://src/a.txt to s3://dst/a.txt\\n' +
+      'copy failed: s3://src/b.txt to s3://dst/b.txt An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied\\n'
+    const { text: result } = apply(f, text, '', 1, ['aws', 's3', 'cp', '--recursive', 's3://src', 's3://dst'])
+    expect(result).toContain('copy failed: s3://src/b.txt to s3://dst/b.txt An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied')
+    expect(result).toContain('1 transfer(s) failed')
+  })
+
+  // FORMAT-DERIVED: the same FAILURE_FORMAT again, with \`delete\` as the transfer_type -- the type \`aws s3 rm\` reports, per the one format string in aws-cli's \`awscli/customizations/s3/results.py\`. Kept separate from the \`copy\` case above because \`rm\` also has to be routed to this compressor at all; matching \`delete failed:\` while \`rm\` fell through to the generic path left the pattern unreachable.
+  it('counts a failed delete from \`aws s3 rm\` as a failed transfer', () => {
+    const text =
+      'delete: s3://mybucket/a.txt\\n' +
+      'delete failed: s3://mybucket/b.txt An error occurred (AccessDenied) when calling the DeleteObject operation: Access Denied\\n'
+    const { text: result } = apply(f, text, '', 1, ['aws', 's3', 'rm', '--recursive', 's3://mybucket'])
+    expect(result).toContain('delete failed: s3://mybucket/b.txt An error occurred (AccessDenied) when calling the DeleteObject operation: Access Denied')
+    expect(result).toContain('1 transfer(s) failed')
+    // the successful delete is never folded into a count: only upload and download lines are, so routing \`rm\` here cannot cost it a line it used to keep
+    expect(result).toContain('delete: s3://mybucket/a.txt')
+  })
+
+  // The sibling path the test above deliberately does not drive: with the streams kept apart, aws exits non-zero with the failure on stderr, and \`errorPassthrough\` returns the raw output before any compression runs. Asserted rather than described, because the comment above depends on it being true -- if this ever started compressing, the fixture above would be testing a path real output no longer takes.
+  it('hands back raw output when the failure arrives on stderr with a non-zero exit', () => {
+    const stderr = 'upload failed: ./secret.txt to s3://mybucket/secret.txt Could not connect to the endpoint URL: "http://localhost:1/mybucket/secret.txt"'
+    // Enough successes that compression would visibly fold them into a count if it ran; a two-line input cannot tell the two paths apart, because the compressor leaves a list that short alone and the mutation looks identical.
+    const stdout = Array.from({ length: 12 }, (_, i) => \`upload: ./file\${i}.txt to s3://mybucket/file\${i}.txt\`).join('\\n') + '\\n'
+    const { text: result } = apply(f, stdout, stderr, 1, ['aws', 's3', 'sync', '.', 's3://mybucket'])
+    expect(result).toContain(stderr)
+    // Only the absence of the success note can show compression never ran: asserting the failure note is absent passes either way, since the failure line rides on stderr, which _compressS3Transfer never sees.
+    expect(result).not.toContain('uploaded 12 file(s)')
+    expect(result).toContain('upload: ./file11.txt to s3://mybucket/file11.txt')
+  })
+
   it('collapses CFN IN_PROGRESS repeated events', () => {
     const events = Array.from({ length: 15 }, (_, i) => ({
       LogicalResourceId: 'MyBucket',
diff --git a/tests/tool_filters_containers.test.ts b/tests/tool_filters_containers.test.ts
index 4ebb3af0..bf6f09d9 100644
--- a/tests/tool_filters_containers.test.ts
+++ b/tests/tool_filters_containers.test.ts
@@ -358,6 +358,39 @@ describe('KubectlFilter', () => {
     expect(result).not.toContain('Some other field')
   })
 
+  // FORMAT-DERIVED: the \`State:\`/\`Last State:\`/\`Container ID:\` labels come from kubectl's own describe printer, \`kubernetes/kubectl\` \`pkg/describe/describe.go\` (https://github.com/kubernetes/kubectl/blob/master/pkg/describe/describe.go) -- \`describeContainerBasicInfo\` writes \`Container ID:\`/\`Image ID:\`, and the container-state helper (\`describeStatus\`, called once for the current state and once more for \`LastTerminationState\` with the label "Last State") writes \`State:\` and \`Last State:\` respectively. No live cluster is available on this machine, so this cannot be a CAPTURE.
+  it('describe keeps Last State separate from State so a past crash is not reattributed to the current one', () => {
+    const text = [
+      'Name:         mypod',
+      'Status:       Running',
+      '    Image:         nginx:1.21',
+      '    Container ID:  docker://abc123',
+      '    State:          Running',
+      '      Started:      Mon, 01 Jan 2024 00:00:00 +0000',
+      '    Last State:     Terminated',
+      '      Reason:       Error',
+      '      Exit Code:    1',
+      '      Started:      Sun, 31 Dec 2023 23:00:00 +0000',
+      '      Finished:     Sun, 31 Dec 2023 23:05:00 +0000',
+      '    Ready:          True',
+      '    Restart Count:  7',
+    ].join('\\n')
+    const result = apply(f, text, '', 0, ['kubectl', 'describe', 'pod', 'mypod'])
+    // must-not-drop: the Last State header itself, so Reason/Exit Code/the second Started/Finished read as history, not current state
+    expect(result).toContain('Last State:     Terminated')
+    expect(result).toContain('Container ID:  docker://abc123')
+    expect(result).toContain('State:          Running')
+    expect(result).toContain('Reason:       Error')
+    expect(result).toContain('Exit Code:    1')
+    expect(result).toContain('Finished:     Sun, 31 Dec 2023 23:05:00 +0000')
+    expect(result).toContain('Restart Count:  7')
+    // the crash record must appear after its own header, not directly under the still-kept \`State:\` line
+    const lastStateIdx = result.indexOf('Last State:')
+    const reasonIdx = result.indexOf('Reason:       Error')
+    expect(lastStateIdx).toBeGreaterThan(-1)
+    expect(reasonIdx).toBeGreaterThan(lastStateIdx)
+  })
+
   it('describe preserves Events section, elides older events', () => {
     // Ported from Python test_describe_preserves_events
     let text = [
diff --git a/tests/tool_filters_git.test.ts b/tests/tool_filters_git.test.ts
index 56d9a91b..ce251441 100644
--- a/tests/tool_filters_git.test.ts
+++ b/tests/tool_filters_git.test.ts
@@ -789,17 +789,28 @@ describe('GitStatusVerboseFilter short format', () => {
 // ---------------------------------------------------------------------------
 
 describe('GitStatusVerboseFilter verbose format', () => {
-  it('strips advice lines, groups file listing into count', () => {
+  // CAPTURE: real \`git status\` output from a real scratch repo on this machine (git's own long format, one tracked file modified plus untracked files), pasted verbatim.
+  it('keeps the literal file lines on a small change set, strips only advice and the trailer', () => {
     const text =
-      'On branch main\\n' +
+      'On branch master\\n' +
       'Changes not staged for commit:\\n' +
       '  (use "git add <file>..." to update what will be committed)\\n' +
       '  (use "git restore <file>..." to discard changes in working directory)\\n' +
-      '\\tmodified:   src/foo.py\\n\\n' +
+      '\\tmodified:   tracked.ts\\n\\n' +
+      'Untracked files:\\n' +
+      '  (use "git add <file>..." to include in what will be committed)\\n' +
+      '\\treal_git_status.txt\\n' +
+      '\\ts3.sh\\n' +
+      '\\tuntracked1.txt\\n' +
+      '\\tuntracked2.txt\\n\\n' +
       'no changes added to commit (use "git add" and/or "git commit -a")\\n'
     const result = apply(gitStatusFilter, text, ['git', 'status'])
-    expect(result).toContain('1 modified')
-    expect(result).not.toContain('src/foo.py')
+    // must-not-drop: the actual paths are the entire point of running \`git status\` on a small tree
+    expect(result).toContain('modified:   tracked.ts')
+    expect(result).toContain('real_git_status.txt')
+    expect(result).toContain('s3.sh')
+    expect(result).toContain('untracked1.txt')
+    expect(result).toContain('untracked2.txt')
     expect(result).not.toContain('use "git add')
     expect(result).not.toContain('use "git restore')
     expect(result).not.toContain('no changes added to commit')
@@ -812,7 +823,8 @@ describe('GitStatusVerboseFilter verbose format', () => {
     expect(result).toContain('On branch main')
   })
 
-  it('untracked list grouped to count', () => {
+  // HAND-DERIVED: 3 files is well under \`_DIFF_STAT_DIR_ROLLUP_THRESHOLD\` (20, shared with \`_compressGitDiffStat\`'s directory-rollup gate), so the literal paths must survive -- a small untracked list is exactly the case that names the files, not just their count.
+  it('small untracked list (3 files) keeps the literal paths', () => {
     const files = Array.from({ length: 3 }, (_, i) => \`\\t    new_file_\${i}.py\`).join('\\n')
     const text =
       'On branch main\\n' +
@@ -821,12 +833,14 @@ describe('GitStatusVerboseFilter verbose format', () => {
       files +
       '\\n'
     const result = apply(gitStatusFilter, text, ['git', 'status'])
-    expect(result).toContain('3 untracked')
-    expect(result).not.toContain('new_file_0.py')
+    expect(result).toContain('new_file_0.py')
+    expect(result).toContain('new_file_1.py')
+    expect(result).toContain('new_file_2.py')
   })
 
-  it('large untracked list (15 files) grouped to count', () => {
-    const files = Array.from({ length: 15 }, (_, i) => \`\\tnew_file_\${i}.py\`).join('\\n')
+  // HAND-DERIVED: 25 files exceeds the same 20-file threshold, so this is the case the collapse-to-count path exists for.
+  it('large untracked list (25 files) grouped to count', () => {
+    const files = Array.from({ length: 25 }, (_, i) => \`\\tnew_file_\${i}.py\`).join('\\n')
     const text =
       'On branch main\\n' +
       'Untracked files:\\n' +
@@ -834,9 +848,9 @@ describe('GitStatusVerboseFilter verbose format', () => {
       files +
       '\\n'
     const result = apply(gitStatusFilter, text, ['git', 'status'])
-    expect(result).toContain('15 untracked')
+    expect(result).toContain('25 untracked')
     expect(result).not.toContain('new_file_0.py')
-    expect(result).not.toContain('new_file_14.py')
+    expect(result).not.toContain('new_file_24.py')
   })
 })
 
`
