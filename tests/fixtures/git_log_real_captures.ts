// Real captures for GitLogFilter --name-only / --numstat regression tests.
// Generated from actual `git log` output in this repo -- see tests/tool_filters_git.test.ts
// for the provenance comment and must-not-drop assertions on each.

export const CAPTURE_NAME_ONLY_12 = `commit 1a2495725c54231cdc5495885a02801ce85045c3
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 14:23:58 2026 -0500

    fix(npm): anchor the general deprecation regex to npm's own warning line
    
    NodePackageFilter is the fall-through filter for any npm subcommand
    that is not install/ci/list, which includes npm test/npm run <script>
    whenever the script cannot be resolved to a single binary (a compound
    script such as \`vitest run && tsc --noEmit\`). Its deprecation collapse
    matched /\\bdeprecated\\b/i against every line with no anchor, so a
    vitest FAIL header, a failing test's x line, its code frame, or any
    other output that merely contains the word "deprecated" (including a
    describe block literally named "deprecated flag handling") was deleted
    and replaced with a fabricated "collapsed N deprecation warnings across
    M packages: <unknown>" trailer, while the pass/fail counts in the
    footer survived untouched.
    
    The pattern is now anchored to npm's own \`npm warn deprecated ...\` line
    shape, which still collapses real npm deprecation noise (verified
    against real npm 11.6.2 output) and no longer touches unrelated output
    that happens to contain the word.
    
    Gates: lint clean, typecheck and typecheck:tests clean, full suite
    796 files / 14792 passed / 51 skipped, build + bench 96.1% saved with
    fidelity 6/6, test:matrix 164 passed. Mutation: reverting the regex to
    its old unanchored form turns two of the three new tests red (the
    compound-script capture and the mixed-line case), while the
    real-npm-deprecation-line test alone stays green, confirming that test
    does not guard the fix on its own.

CHANGELOG.md
src/tool_filters/package_managers.ts
tests/tool_filters_package_managers.test.ts

commit a80b5063b4f5d16b37fac637ca17fb0f1efe9b1c
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:48:20 2026 -0500

    fix(pytest): drop the default path-led per-file progress line, not only bare dots
    
    pytest's default (non-verbose, non-xdist) reporter leads each file's result
    run with its path, \`tests/test_foo.py ..F.s    [ 50%]\`, and prints a bare
    dot run only when that line wraps. PytestFilter's DOTS_RE matched only the
    bare form, so every per-file progress line of a default run fell through to
    the keep branch. The verbose \`path::test PASSED\` form had been fixed earlier;
    this shape never was, and the only test for progress lines used the bare
    fixture, which real non-xdist pytest never emits alone.
    
    On a short failing run the surviving lines left the saving below the
    net-benefit floor and the whole output shipped verbatim with no filter
    marker; measured on a docs-shaped 14-line run, the built bundle went from a
    pass-through to -42% with the collected count, the failure body, the short
    summary and the tally all intact.
    
    A second pattern, FILE_DOTS_RE, recognises the path-led form. It requires
    the trailing percent column, because a bare \`path dots\` shape would also
    match captured text such as \`assert F\`.

CHANGELOG.md
src/tool_filters/pytest.ts
tests/tool_filters_pytest_gotest.test.ts

commit 4675d7b5bbe7267b3ffc50ef77a354f07f871149
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:28:36 2026 -0500

    fix(git): name the author on every collapsed run in git blame --porcelain output
    
    \`git blame --porcelain\` prints a commit's author/committer/summary/filename
    block only the first time that commit appears in the output. Every later run
    of the same commit is a bare \`<sha> <orig> <final> [<n>]\` header followed by
    its tab-prefixed content line, and the 2nd..Nth lines of a group carry only a
    3-field header.
    
    _compressGitBlamePorcelain reset currentAuthor to null at every new run header
    and re-learned it only from that run's own metadata lines, which a repeat
    appearance never carries. So the collapse note for any run after a commit's
    first read \`[token-goat: N more lines by null (<sha8>)]\`. On this repo's own
    \`git blame --porcelain src/hooks_edit.ts\`, 20 of 21 notes printed \`null\`.
    
    Nothing failed because the note stayed well-formed, and the only porcelain
    fixture repeated the full metadata block on every line, which is the
    \`--line-porcelain\` shape rather than \`--porcelain\`, so the reset was never
    observed.
    
    The author is now remembered per commit hash across the whole output and
    looked up when a later run of that commit opens. The regression fixture puts a
    different author's commit between the two appearances so the test proves the
    note is keyed by hash, not by the last author seen.

CHANGELOG.md
src/tool_filters/git.ts
tests/tool_filters_git.test.ts

commit f7565b6fa93a1cbd2044a14b1cecffc0d671bf5a
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:16:10 2026 -0500

    fix(xlsx): read a never-calculated formula cell as empty, not a fabricated 0
    
    A producer that writes formulas without evaluating them (openpyxl does this for every formula it writes, and ECMA-376 18.3.1.4 declares the cached <v> optional) emits <c><f>A1*2</f></c> with no <v> element at all. buildCell's numeric branch converted the absent element with Number(textOf(undefined)), and Number('') is 0, so every such cell carried raw=0/text='0' out of the reader. The display layer could not recover it: a fabricated 0 and a real cached 0 arrive as the same shape, and 0 is a plausible enough spreadsheet value that nothing looked wrong in xlsx-head, xlsx-range, xlsx-columns or xlsx-query output.
    
    The reader now keys on the <v> text being empty rather than on the parsed number, reporting result null and text ''. cellText prints a null formula result as an empty field (String(null) would have printed the word "null"), and in the same branch prints a boolean formula result as TRUE/FALSE, matching the spelling a plain t="b" cell already gets instead of the JS "false". --formulas is unaffected and still shows the formula text.
    
    Regression tests: a hand-authored SpreadsheetML part in tests/xlsx_reader.test.ts (no <v> beside a cell whose cached 0 must survive) and two ExcelJS-written rows in tests/xlsx_extract.test.ts. Each of the three hunks fails its own test when reverted alone. The embed fingerprint changed because the xlsx reader feeds embeddings.

CHANGELOG.md
src/embed_fingerprint.ts
src/xlsx_extract.ts
src/xlsx_reader.ts
tests/xlsx_extract.test.ts
tests/xlsx_reader.test.ts

commit c8e2952520b298a95e248c61786dc8fbc27f9655
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:04:31 2026 -0500

    fix(transcript): decode the six WebVTT cue text escapes in cue text and speaker names
    
    WebVTT has no way to write a literal \`&\` or \`<\` in cue text or in a
    voice-span annotation except as one of its six named escapes (\`&amp;\`,
    \`&lt;\`, \`&gt;\`, \`&lrm;\`, \`&rlm;\`, \`&nbsp;\`; W3C WebVTT, "WebVTT cue text
    span"), so the escaped form is never the author's own text.
    parseTranscript stripped tags and shipped the escapes verbatim: a
    \`<v Tom &amp; Jerry>\` cue listed a speaker named \`Tom &amp; Jerry\`, the
    cue text read \`Tom &amp; Jerry\`, and \`transcript --grep "Tom & Jerry"\`
    matched nothing. Nothing failed, because the output was still readable
    text.
    
    Decode the escapes after the tag strip, so an escaped \`&lt;i&gt;\` stays
    the author's literal \`<i>\` rather than becoming a tag the strip removes,
    and only under a \`WEBVTT\` signature: SRT defines no escape syntax, so an
    \`&amp;\` in an SRT cue stays byte-for-byte as written.

CHANGELOG.md
src/transcript_extract.ts
tests/transcript_extract.test.ts

commit 4fd36e1ef98a7c7b4ae360012bb8c236849d7eaf
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:50:47 2026 -0500

    fix(transcript): read the speaker from a <v> tag with more than one class name
    
    WebVTT lets a voice span open with zero or more \`.class\` names before the
    speaker annotation; the spec's own voice-span example is
    \`<v.first.loud Esme>It's a blue apple tree!\`. V_TAG_RE in
    src/transcript_extract.ts allowed at most one class (\`(?:\\.\\w+)?\`), so a
    two-class tag did not match, the generic \`<...>\` strip then removed the
    whole tag as markup, and the leading-\`Name:\` heuristic ran on plain
    dialogue and found nothing. The cue came out with speaker null: it was
    invisible to \`transcript --speaker\`, and \`transcript-outline\` dropped the
    name from its speaker list. Nothing signalled it, since a speakerless cue
    is a legitimate shape.
    
    The tag pattern now accepts any number of classes, \`(?:\\.[^\\s.>]+)*\`; each
    repetition starts with a literal \`.\` that the class body excludes, so the
    quantifier is unambiguous. Regression test uses the spec's example
    (FORMAT-DERIVED, https://www.w3.org/TR/webvtt1/#webvtt-cue-voice-span) and
    fails against the previous pattern.

CHANGELOG.md
src/transcript_extract.ts
tests/transcript_extract.test.ts

commit d239132eb9c803c09a6b7215b557a2aa2cc28729
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:41:28 2026 -0500

    fix(docx): read a Word text box once, not once per markup-compatibility branch
    
    Word writes a text box as mc:AlternateContent, carrying the box's
    paragraphs under mc:Choice (the w:drawing form) and again, character for
    character, under mc:Fallback (the older w:pict form). ISO/IEC 29500-3
    says a consumer processes exactly one branch. The docx readers walked
    the whole parsed tree, so collectTextRuns gathered both copies of every
    w:t under the outer paragraph and docx-text printed a box reading
    "Datum plane" as "Datum planeDatum plane", with nothing between the
    copies. The same doubled text fed the embeddings. Nothing signalled it:
    a repeated phrase is not an error, and none of the documents this reader
    had been checked against held a text box.
    
    The parsed tree now has every mc:Fallback deleted wherever an mc:Choice
    stands beside it, in loadDocumentBody before any paragraph, heading or
    table is collected, so all three docx readers and the embedding path
    see one copy. A Fallback with no Choice is kept, since it is then the
    only copy. Both extractor sources feed embed_fingerprint.ts, so the
    fingerprint moved and upgrading reindexes.
    
    Confirmed against python-mammoth's tests/test-data/text-box.docx, saved
    by Microsoft Office Word 14; the regression fixture is that paragraph
    with only the anchor geometry and shape properties left out.

CHANGELOG.md
src/docx_extract.ts
src/embed_fingerprint.ts
src/ooxml_extract.ts
tests/docx_extract.test.ts

commit 664497f7d3c9d74bd99d80108402339c4bc7fe71
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:31:40 2026 -0500

    fix(docx): keep a Word tab as a tab character between the runs it separates
    
    Word writes a tab as an empty <w:tab/> element between <w:t> runs rather than as a character, and a line break inside a paragraph as <w:br/> (<w:cr/> the legacy form) the same way. Every docx reader collected only <w:t> values, so \`Section 1.<w:tab/>Definitions.\` came out as \`Section 1.Definitions.\`; a Word-saved NDA on this machine had 16 such tabs and docx-text dropped every one, with nothing to show a character had gone. docx-tables special-cased w:br per paragraph, docx-text and docx-outline did not even do that.
    
    The parse tree cannot restore the position: same-name siblings fold into one array per name, so \`<w:t>A</w:t><w:tab/><w:t>B</w:t>\` arrives as \`{'w:t': ['A','B'], 'w:tab': ''}\` with the interleaving gone. loadDocumentBody now rewrites each bare <w:tab/> into a <w:t> run holding a tab, and <w:br .../> and <w:cr/> into one holding a newline, before the part is parsed. Those are same-name siblings of the text they sit between, which the parse does keep in order, so the character lands exactly where Word put it, including between two text elements of one run, which the per-paragraph join could never place. Tab-stop definitions (<w:tab w:val w:pos/> under w:tabs) always carry attributes and are untouched; a manual page break in its own paragraph still yields no paragraph of its own.
    
    The pre-existing w:br table fixture placed <w:br/> directly under w:p, a shape ECMA-376 17.3.3.1 (the section it cites) does not allow and Word never writes; it now sits inside a run as run content. docx_extract.ts feeds the embeddings indexer through doc_embed_extract.ts, so the embed fingerprint is refreshed and upgrading reindexes.

CHANGELOG.md
src/docx_extract.ts
src/embed_fingerprint.ts
tests/docx_extract.test.ts

commit 01a937fd408dbbef18dbebc78c919dd1dbe8cb73
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:17:03 2026 -0500

    fix(trace): accept logback packaging data on JVM frames and a message-less exception header
    
    JVM_FRAME_RE anchored the closing \`)\` to end-of-line, so a frame carrying
    logback packaging data (\`~[spring-boot-3.2.0.jar:3.2.0]\`, \`~[na:na]\`,
    \`[classes/:na]\`) matched nothing. parseJvmBlock decides whether a header
    line is a trace at all by parsing the first frame, so the first such
    frame rejected the entire block and \`trace\` reported "no traceback
    found" rather than a shorter frame list. Spring Boot enables packaging
    data by default, so every Spring Boot log hit this.
    
    JVM_HEADER_RE also required \`: message\`, but the JDK prints only the
    class name when the throwable's message is null, so a block headed
    \`Caused by: java.lang.reflect.InvocationTargetException\` was dropped
    even from plain \`java\` output.
    
    Both regexes now accept those forms: the frame pattern takes an optional
    trailing \`~?[...]\` token, and the header's \`: message\` is optional. The
    regression fixture is a real logback-classic 1.5.32 capture on OpenJDK
    17.0.19 with packagingData="true", CRLF and log-line prefix intact; it
    goes red with either hunk reverted on its own.

CHANGELOG.md
src/text_trace.ts
tests/text_commands.test.ts

commit 8b3203aa80b8639056ad4241388351b6c55fd5ce
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:06:12 2026 -0500

    fix(trace): keep the exception line after a context-less innermost Python frame
    
    parsePythonBlock decided that the line after a \`File "...", line N, in f\`
    frame was that frame's source line whenever it was not another File or
    Traceback line. CPython prints no source line for frozen modules, exec()
    strings, and REPL input, so when such a frame was the innermost one the
    unindented exception line that followed it was consumed as the frame's
    context and the block's exception came back empty. Every
    ModuleNotFoundError ends in a \`<frozen importlib._bootstrap>\` frame, so
    the most common import failure lost its exception text while the frame
    list looked normal.
    
    The context check now also requires the candidate line to be indented,
    which CPython does for every source line and never for an exception
    line. The regression test drives the built bundle with a captured
    CPython 3.13.1 ModuleNotFoundError traceback and asserts the exception
    text survives and appears in no frame's context; it fails on the
    previous parser with exception ''.

CHANGELOG.md
src/text_trace.ts
tests/text_commands.test.ts

commit 49f8136b7977f7c64c46022234dc81fc4472a604
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 10:57:07 2026 -0500

    fix(todo): keep a marker that follows a rejected kind word on the same line
    
    scanFileForTodos ran a single non-global exec per line and judged the whole
    line by that first occurrence of any kind word. When that occurrence was
    prose ("Note that", "a hack;") or sat inside a double-quoted string, the
    \`continue\` discarded the line, so a genuine FIXME: or TODO: further along
    was never examined. The loss was silent: the line simply did not appear,
    indistinguishable from a line with no marker.
    
    The regex is now global and every occurrence on the line is a candidate;
    the first one that passes both the marker test and the string-literal
    exclusion is reported. Because the trailing (.*) consumes the rest of the
    line, lastIndex is reset just past the matched word so the scan continues.
    On this repository the change surfaces 7 markers the previous build
    never listed.
    
    Regression test in tests/text_commands.test.ts pairs a prose word and a
    quoted word ahead of real markers, and a control line with only rejected
    occurrences; it fails against the previous scanner.

CHANGELOG.md
src/text_todo.ts
tests/text_commands.test.ts

commit f39a297ac4ea541de155d1e3e904b0172f3751a9
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 10:46:19 2026 -0500

    fix(index): index a Groovy generic method whose type-parameter list precedes its return type
    
    \`static <T> T first(List<T> self) {\` produced no symbol. matchGroovy strips
    the modifier words and hands the rest to cFunctionHeader, whose C_PREFIX_RE
    requires the text before \`(\` to begin with a letter; after \`static\` is gone
    that text begins with \`<\`, so the header reader returned null before
    isReturnType was ever consulted. \`def <T> T first(...)\` was indexed all
    along because \`def\` comes first, which made a class mixing the two
    spellings look partially indexed rather than broken.
    
    matchGroovy now removes a leading balanced \`<...>\` type-parameter list
    (bounded forms such as \`<T extends Comparable<T>>\` included) before the
    header is read, at class-member and script level alike. Unbalanced angle
    brackets leave the text untouched. Parser fingerprint regenerated.

CHANGELOG.md
src/languages/groovy.ts
src/parser_fingerprint.ts
tests/brace_adapters.test.ts`

export const CAPTURE_ONELINE_NAME_ONLY_8 = `1a249572 fix(npm): anchor the general deprecation regex to npm's own warning line
CHANGELOG.md
src/tool_filters/package_managers.ts
tests/tool_filters_package_managers.test.ts
a80b5063 fix(pytest): drop the default path-led per-file progress line, not only bare dots
CHANGELOG.md
src/tool_filters/pytest.ts
tests/tool_filters_pytest_gotest.test.ts
4675d7b5 fix(git): name the author on every collapsed run in git blame --porcelain output
CHANGELOG.md
src/tool_filters/git.ts
tests/tool_filters_git.test.ts
f7565b6f fix(xlsx): read a never-calculated formula cell as empty, not a fabricated 0
CHANGELOG.md
src/embed_fingerprint.ts
src/xlsx_extract.ts
src/xlsx_reader.ts
tests/xlsx_extract.test.ts
tests/xlsx_reader.test.ts
c8e29525 fix(transcript): decode the six WebVTT cue text escapes in cue text and speaker names
CHANGELOG.md
src/transcript_extract.ts
tests/transcript_extract.test.ts
4fd36e1e fix(transcript): read the speaker from a <v> tag with more than one class name
CHANGELOG.md
src/transcript_extract.ts
tests/transcript_extract.test.ts
d239132e fix(docx): read a Word text box once, not once per markup-compatibility branch
CHANGELOG.md
src/docx_extract.ts
src/embed_fingerprint.ts
src/ooxml_extract.ts
tests/docx_extract.test.ts
664497f7 fix(docx): keep a Word tab as a tab character between the runs it separates
CHANGELOG.md
src/docx_extract.ts
src/embed_fingerprint.ts
tests/docx_extract.test.ts`

export const CAPTURE_NUMSTAT_12 = `commit 1a2495725c54231cdc5495885a02801ce85045c3
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 14:23:58 2026 -0500

    fix(npm): anchor the general deprecation regex to npm's own warning line
    
    NodePackageFilter is the fall-through filter for any npm subcommand
    that is not install/ci/list, which includes npm test/npm run <script>
    whenever the script cannot be resolved to a single binary (a compound
    script such as \`vitest run && tsc --noEmit\`). Its deprecation collapse
    matched /\\bdeprecated\\b/i against every line with no anchor, so a
    vitest FAIL header, a failing test's x line, its code frame, or any
    other output that merely contains the word "deprecated" (including a
    describe block literally named "deprecated flag handling") was deleted
    and replaced with a fabricated "collapsed N deprecation warnings across
    M packages: <unknown>" trailer, while the pass/fail counts in the
    footer survived untouched.
    
    The pattern is now anchored to npm's own \`npm warn deprecated ...\` line
    shape, which still collapses real npm deprecation noise (verified
    against real npm 11.6.2 output) and no longer touches unrelated output
    that happens to contain the word.
    
    Gates: lint clean, typecheck and typecheck:tests clean, full suite
    796 files / 14792 passed / 51 skipped, build + bench 96.1% saved with
    fidelity 6/6, test:matrix 164 passed. Mutation: reverting the regex to
    its old unanchored form turns two of the three new tests red (the
    compound-script capture and the mixed-line case), while the
    real-npm-deprecation-line test alone stays green, confirming that test
    does not guard the fix on its own.

2	0	CHANGELOG.md
5	18	src/tool_filters/package_managers.ts
89	61	tests/tool_filters_package_managers.test.ts

commit a80b5063b4f5d16b37fac637ca17fb0f1efe9b1c
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:48:20 2026 -0500

    fix(pytest): drop the default path-led per-file progress line, not only bare dots
    
    pytest's default (non-verbose, non-xdist) reporter leads each file's result
    run with its path, \`tests/test_foo.py ..F.s    [ 50%]\`, and prints a bare
    dot run only when that line wraps. PytestFilter's DOTS_RE matched only the
    bare form, so every per-file progress line of a default run fell through to
    the keep branch. The verbose \`path::test PASSED\` form had been fixed earlier;
    this shape never was, and the only test for progress lines used the bare
    fixture, which real non-xdist pytest never emits alone.
    
    On a short failing run the surviving lines left the saving below the
    net-benefit floor and the whole output shipped verbatim with no filter
    marker; measured on a docs-shaped 14-line run, the built bundle went from a
    pass-through to -42% with the collected count, the failure body, the short
    summary and the tally all intact.
    
    A second pattern, FILE_DOTS_RE, recognises the path-led form. It requires
    the trailing percent column, because a bare \`path dots\` shape would also
    match captured text such as \`assert F\`.

2	0	CHANGELOG.md
4	2	src/tool_filters/pytest.ts
26	0	tests/tool_filters_pytest_gotest.test.ts

commit 4675d7b5bbe7267b3ffc50ef77a354f07f871149
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:28:36 2026 -0500

    fix(git): name the author on every collapsed run in git blame --porcelain output
    
    \`git blame --porcelain\` prints a commit's author/committer/summary/filename
    block only the first time that commit appears in the output. Every later run
    of the same commit is a bare \`<sha> <orig> <final> [<n>]\` header followed by
    its tab-prefixed content line, and the 2nd..Nth lines of a group carry only a
    3-field header.
    
    _compressGitBlamePorcelain reset currentAuthor to null at every new run header
    and re-learned it only from that run's own metadata lines, which a repeat
    appearance never carries. So the collapse note for any run after a commit's
    first read \`[token-goat: N more lines by null (<sha8>)]\`. On this repo's own
    \`git blame --porcelain src/hooks_edit.ts\`, 20 of 21 notes printed \`null\`.
    
    Nothing failed because the note stayed well-formed, and the only porcelain
    fixture repeated the full metadata block on every line, which is the
    \`--line-porcelain\` shape rather than \`--porcelain\`, so the reset was never
    observed.
    
    The author is now remembered per commit hash across the whole output and
    looked up when a later run of that commit opens. The regression fixture puts a
    different author's commit between the two appearances so the test proves the
    note is keyed by hash, not by the last author seen.

2	0	CHANGELOG.md
7	2	src/tool_filters/git.ts
43	0	tests/tool_filters_git.test.ts

commit f7565b6fa93a1cbd2044a14b1cecffc0d671bf5a
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:16:10 2026 -0500

    fix(xlsx): read a never-calculated formula cell as empty, not a fabricated 0
    
    A producer that writes formulas without evaluating them (openpyxl does this for every formula it writes, and ECMA-376 18.3.1.4 declares the cached <v> optional) emits <c><f>A1*2</f></c> with no <v> element at all. buildCell's numeric branch converted the absent element with Number(textOf(undefined)), and Number('') is 0, so every such cell carried raw=0/text='0' out of the reader. The display layer could not recover it: a fabricated 0 and a real cached 0 arrive as the same shape, and 0 is a plausible enough spreadsheet value that nothing looked wrong in xlsx-head, xlsx-range, xlsx-columns or xlsx-query output.
    
    The reader now keys on the <v> text being empty rather than on the parsed number, reporting result null and text ''. cellText prints a null formula result as an empty field (String(null) would have printed the word "null"), and in the same branch prints a boolean formula result as TRUE/FALSE, matching the spelling a plain t="b" cell already gets instead of the JS "false". --formulas is unaffected and still shows the formula text.
    
    Regression tests: a hand-authored SpreadsheetML part in tests/xlsx_reader.test.ts (no <v> beside a cell whose cached 0 must survive) and two ExcelJS-written rows in tests/xlsx_extract.test.ts. Each of the three hunks fails its own test when reverted alone. The embed fingerprint changed because the xlsx reader feeds embeddings.

2	0	CHANGELOG.md
1	1	src/embed_fingerprint.ts
3	0	src/xlsx_extract.ts
4	2	src/xlsx_reader.ts
20	0	tests/xlsx_extract.test.ts
14	0	tests/xlsx_reader.test.ts

commit c8e2952520b298a95e248c61786dc8fbc27f9655
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 12:04:31 2026 -0500

    fix(transcript): decode the six WebVTT cue text escapes in cue text and speaker names
    
    WebVTT has no way to write a literal \`&\` or \`<\` in cue text or in a
    voice-span annotation except as one of its six named escapes (\`&amp;\`,
    \`&lt;\`, \`&gt;\`, \`&lrm;\`, \`&rlm;\`, \`&nbsp;\`; W3C WebVTT, "WebVTT cue text
    span"), so the escaped form is never the author's own text.
    parseTranscript stripped tags and shipped the escapes verbatim: a
    \`<v Tom &amp; Jerry>\` cue listed a speaker named \`Tom &amp; Jerry\`, the
    cue text read \`Tom &amp; Jerry\`, and \`transcript --grep "Tom & Jerry"\`
    matched nothing. Nothing failed, because the output was still readable
    text.
    
    Decode the escapes after the tag strip, so an escaped \`&lt;i&gt;\` stays
    the author's literal \`<i>\` rather than becoming a tag the strip removes,
    and only under a \`WEBVTT\` signature: SRT defines no escape syntax, so an
    \`&amp;\` in an SRT cue stays byte-for-byte as written.

2	0	CHANGELOG.md
13	6	src/transcript_extract.ts
14	0	tests/transcript_extract.test.ts

commit 4fd36e1ef98a7c7b4ae360012bb8c236849d7eaf
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:50:47 2026 -0500

    fix(transcript): read the speaker from a <v> tag with more than one class name
    
    WebVTT lets a voice span open with zero or more \`.class\` names before the
    speaker annotation; the spec's own voice-span example is
    \`<v.first.loud Esme>It's a blue apple tree!\`. V_TAG_RE in
    src/transcript_extract.ts allowed at most one class (\`(?:\\.\\w+)?\`), so a
    two-class tag did not match, the generic \`<...>\` strip then removed the
    whole tag as markup, and the leading-\`Name:\` heuristic ran on plain
    dialogue and found nothing. The cue came out with speaker null: it was
    invisible to \`transcript --speaker\`, and \`transcript-outline\` dropped the
    name from its speaker list. Nothing signalled it, since a speakerless cue
    is a legitimate shape.
    
    The tag pattern now accepts any number of classes, \`(?:\\.[^\\s.>]+)*\`; each
    repetition starts with a literal \`.\` that the class body excludes, so the
    quantifier is unambiguous. Regression test uses the spec's example
    (FORMAT-DERIVED, https://www.w3.org/TR/webvtt1/#webvtt-cue-voice-span) and
    fails against the previous pattern.

2	0	CHANGELOG.md
2	1	src/transcript_extract.ts
9	0	tests/transcript_extract.test.ts

commit d239132eb9c803c09a6b7215b557a2aa2cc28729
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:41:28 2026 -0500

    fix(docx): read a Word text box once, not once per markup-compatibility branch
    
    Word writes a text box as mc:AlternateContent, carrying the box's
    paragraphs under mc:Choice (the w:drawing form) and again, character for
    character, under mc:Fallback (the older w:pict form). ISO/IEC 29500-3
    says a consumer processes exactly one branch. The docx readers walked
    the whole parsed tree, so collectTextRuns gathered both copies of every
    w:t under the outer paragraph and docx-text printed a box reading
    "Datum plane" as "Datum planeDatum plane", with nothing between the
    copies. The same doubled text fed the embeddings. Nothing signalled it:
    a repeated phrase is not an error, and none of the documents this reader
    had been checked against held a text box.
    
    The parsed tree now has every mc:Fallback deleted wherever an mc:Choice
    stands beside it, in loadDocumentBody before any paragraph, heading or
    table is collected, so all three docx readers and the embedding path
    see one copy. A Fallback with no Choice is kept, since it is then the
    only copy. Both extractor sources feed embed_fingerprint.ts, so the
    fingerprint moved and upgrading reindexes.
    
    Confirmed against python-mammoth's tests/test-data/text-box.docx, saved
    by Microsoft Office Word 14; the regression fixture is that paragraph
    with only the anchor geometry and shape properties left out.

2	0	CHANGELOG.md
4	2	src/docx_extract.ts
1	1	src/embed_fingerprint.ts
17	0	src/ooxml_extract.ts
27	0	tests/docx_extract.test.ts

commit 664497f7d3c9d74bd99d80108402339c4bc7fe71
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:31:40 2026 -0500

    fix(docx): keep a Word tab as a tab character between the runs it separates
    
    Word writes a tab as an empty <w:tab/> element between <w:t> runs rather than as a character, and a line break inside a paragraph as <w:br/> (<w:cr/> the legacy form) the same way. Every docx reader collected only <w:t> values, so \`Section 1.<w:tab/>Definitions.\` came out as \`Section 1.Definitions.\`; a Word-saved NDA on this machine had 16 such tabs and docx-text dropped every one, with nothing to show a character had gone. docx-tables special-cased w:br per paragraph, docx-text and docx-outline did not even do that.
    
    The parse tree cannot restore the position: same-name siblings fold into one array per name, so \`<w:t>A</w:t><w:tab/><w:t>B</w:t>\` arrives as \`{'w:t': ['A','B'], 'w:tab': ''}\` with the interleaving gone. loadDocumentBody now rewrites each bare <w:tab/> into a <w:t> run holding a tab, and <w:br .../> and <w:cr/> into one holding a newline, before the part is parsed. Those are same-name siblings of the text they sit between, which the parse does keep in order, so the character lands exactly where Word put it, including between two text elements of one run, which the per-paragraph join could never place. Tab-stop definitions (<w:tab w:val w:pos/> under w:tabs) always carry attributes and are untouched; a manual page break in its own paragraph still yields no paragraph of its own.
    
    The pre-existing w:br table fixture placed <w:br/> directly under w:p, a shape ECMA-376 17.3.3.1 (the section it cites) does not allow and Word never writes; it now sits inside a run as run content. docx_extract.ts feeds the embeddings indexer through doc_embed_extract.ts, so the embed fingerprint is refreshed and upgrading reindexes.

2	0	CHANGELOG.md
8	3	src/docx_extract.ts
1	1	src/embed_fingerprint.ts
46	2	tests/docx_extract.test.ts

commit 01a937fd408dbbef18dbebc78c919dd1dbe8cb73
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:17:03 2026 -0500

    fix(trace): accept logback packaging data on JVM frames and a message-less exception header
    
    JVM_FRAME_RE anchored the closing \`)\` to end-of-line, so a frame carrying
    logback packaging data (\`~[spring-boot-3.2.0.jar:3.2.0]\`, \`~[na:na]\`,
    \`[classes/:na]\`) matched nothing. parseJvmBlock decides whether a header
    line is a trace at all by parsing the first frame, so the first such
    frame rejected the entire block and \`trace\` reported "no traceback
    found" rather than a shorter frame list. Spring Boot enables packaging
    data by default, so every Spring Boot log hit this.
    
    JVM_HEADER_RE also required \`: message\`, but the JDK prints only the
    class name when the throwable's message is null, so a block headed
    \`Caused by: java.lang.reflect.InvocationTargetException\` was dropped
    even from plain \`java\` output.
    
    Both regexes now accept those forms: the frame pattern takes an optional
    trailing \`~?[...]\` token, and the header's \`: message\` is optional. The
    regression fixture is a real logback-classic 1.5.32 capture on OpenJDK
    17.0.19 with packagingData="true", CRLF and log-line prefix intact; it
    goes red with either hunk reverted on its own.

2	0	CHANGELOG.md
3	2	src/text_trace.ts
37	0	tests/text_commands.test.ts

commit 8b3203aa80b8639056ad4241388351b6c55fd5ce
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 11:06:12 2026 -0500

    fix(trace): keep the exception line after a context-less innermost Python frame
    
    parsePythonBlock decided that the line after a \`File "...", line N, in f\`
    frame was that frame's source line whenever it was not another File or
    Traceback line. CPython prints no source line for frozen modules, exec()
    strings, and REPL input, so when such a frame was the innermost one the
    unindented exception line that followed it was consumed as the frame's
    context and the block's exception came back empty. Every
    ModuleNotFoundError ends in a \`<frozen importlib._bootstrap>\` frame, so
    the most common import failure lost its exception text while the frame
    list looked normal.
    
    The context check now also requires the candidate line to be indented,
    which CPython does for every source line and never for an exception
    line. The regression test drives the built bundle with a captured
    CPython 3.13.1 ModuleNotFoundError traceback and asserts the exception
    text survives and appears in no frame's context; it fails on the
    previous parser with exception ''.

2	0	CHANGELOG.md
1	1	src/text_trace.ts
23	0	tests/text_commands.test.ts

commit 49f8136b7977f7c64c46022234dc81fc4472a604
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 10:57:07 2026 -0500

    fix(todo): keep a marker that follows a rejected kind word on the same line
    
    scanFileForTodos ran a single non-global exec per line and judged the whole
    line by that first occurrence of any kind word. When that occurrence was
    prose ("Note that", "a hack;") or sat inside a double-quoted string, the
    \`continue\` discarded the line, so a genuine FIXME: or TODO: further along
    was never examined. The loss was silent: the line simply did not appear,
    indistinguishable from a line with no marker.
    
    The regex is now global and every occurrence on the line is a candidate;
    the first one that passes both the marker test and the string-literal
    exclusion is reported. Because the trailing (.*) consumes the rest of the
    line, lastIndex is reset just past the matched word so the scan continues.
    On this repository the change surfaces 7 markers the previous build
    never listed.
    
    Regression test in tests/text_commands.test.ts pairs a prose word and a
    quoted word ahead of real markers, and a control line with only rejected
    occurrences; it fails against the previous scanner.

2	0	CHANGELOG.md
13	7	src/text_todo.ts
17	0	tests/text_commands.test.ts

commit f39a297ac4ea541de155d1e3e904b0172f3751a9
Author: Token Goat Test <test@token-goat.local>
Date:   Thu Sep 17 10:46:19 2026 -0500

    fix(index): index a Groovy generic method whose type-parameter list precedes its return type
    
    \`static <T> T first(List<T> self) {\` produced no symbol. matchGroovy strips
    the modifier words and hands the rest to cFunctionHeader, whose C_PREFIX_RE
    requires the text before \`(\` to begin with a letter; after \`static\` is gone
    that text begins with \`<\`, so the header reader returned null before
    isReturnType was ever consulted. \`def <T> T first(...)\` was indexed all
    along because \`def\` comes first, which made a class mixing the two
    spellings look partially indexed rather than broken.
    
    matchGroovy now removes a leading balanced \`<...>\` type-parameter list
    (bounded forms such as \`<T extends Comparable<T>>\` included) before the
    header is read, at class-member and script level alike. Unbalanced angle
    brackets leave the text untouched. Parser fingerprint regenerated.

2	0	CHANGELOG.md
12	1	src/languages/groovy.ts
1	1	src/parser_fingerprint.ts
30	0	tests/brace_adapters.test.ts`
