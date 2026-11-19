/** Checks beyond the test, lint, typecheck and build runners that verification_state.ts recognises by name. Each entry is narrow on purpose: a command wrongly taken for a check clears the Stop advisory for edits nothing verified, which is the costly direction, while a check that goes unrecognised only costs one extra reminder. A git commit or push is absent on purpose: a hook file existing does not prove it checks anything, and hook-skipping state can come from outside the segment (`export HUSKY=0`, `SKIP=`, another ref). */

const PYTHON_SCRIPT_RUN = /^python3?\s+(\S+\.py)(?=\s|$)/i
/** A script path word: no quote, no expansion, no space, so the script that runs is the one the check sees. */
const SCRIPT_PATH = /^[\w./@~:\\-]+$/
// The name patterns accept the risk of a mutating script with a check-like name; that is narrow because the run must also carry only path or selector arguments.
/** `run_self_tests.py`, `run_tests.py`, `validate-skills.py`, `check_push_bumps.py`: the file name states that the script's whole job is to check. A script's exit status is its verdict by the convention these names carry. */
const CHECK_SCRIPT_NAME = /^(?:run_[\w-]*tests?[\w-]*|validate[\w-]*|check[_-][\w-]+)\.py$/i
/** An argument that names what to check: a word that starts like a path and holds a separator, `::` or a file extension, so `help` and `list` are not one. No colon outside `::`, so `user:secret@host` is not one. */
const PATH_OR_SELECTOR_ARG = /^[\w./@~][\w./@\\-]*(?:::[\w./@\\-]+)*$/
/** A directory (trailing separator, or a separator and a last segment without a dot), a `::` selector, or a file with a source extension; a data, output or document extension (`.json`, `.txt`, `.log`, `.md`) never counts, because such a file is as likely a report the script writes as an input it checks, and a document's existence says nothing about what the run verified. */
const PATH_EVIDENCE = /::|[/\\]$|[/\\][^/\\.]+$|\.(?:py|ts|tsx|js|mjs|cjs)$/i
/** A `.md` document as a bare word, a `::` selector or a directory form: it is never a check input, whichever of the forms in PATH_EVIDENCE it takes. */
const DOCUMENT_ARG = /\.md(?:::|[/\\]+$|$)/i
/** The one switch a recognised script run may carry: the repository's own spelling for "run this script's built-in tests". Every other switch (`-h`, `--help`, `--list`, `--version`, `--dry-run`, an unknown one) can print or preview instead of checking, so it makes the run not a check. */
const SELF_TEST_FLAG = '--self-test'

function isCheckArgument(word: string): boolean {
  return word === SELF_TEST_FLAG || (PATH_OR_SELECTOR_ARG.test(word) && PATH_EVIDENCE.test(word) && !DOCUMENT_ARG.test(word))
}

/** The script path and its arguments of a `python` run, or null when `segment` is not one. */
function pythonScriptRun(segment: string): { script: string; words: string[] } | null {
  const script = PYTHON_SCRIPT_RUN.exec(segment)?.[1]
  if (script === undefined || !SCRIPT_PATH.test(script)) return null
  return { script, words: segment.trim().split(/\s+/).slice(2) }
}

/** True when the script's file name says its whole job is to check, or it is given `--self-test`. */
function isCheckingScript(script: string, words: readonly string[]): boolean {
  const name = script.split(/[/\\]/).pop() ?? ''
  return CHECK_SCRIPT_NAME.test(name) || words.includes(SELF_TEST_FLAG)
}

/** True when `segment` (its leading `NAME=value` assignments already removed) runs a script that checks a repository: one with a checking file name, or any script given `--self-test`, carrying only path or selector arguments besides that switch. A bare `python foo.py` is not one, and neither is a help, listing, version or preview run of a checking script. */
export function isScriptCheckSegment(segment: string): boolean {
  const run = pythonScriptRun(segment)
  return run !== null && run.words.every(isCheckArgument) && isCheckingScript(run.script, run.words)
}

const LAUNCHER_RUN = /^(?:python3?|node)\s+(?:-[\w-]+\s+)*[\w./@~:\\-]+\.(?:py|mjs|cjs|js)\s+(\S[\s\S]*)$/i
/** A launcher's switch (`-q`, `--timeout=5`) is never a subcommand, quote or expansion; the check follows. */
const LAUNCHER_WORD = /^--?[A-Za-z][\w-]*(?:=[\w./:@-]*)?$/
/** A launcher word saying the check runs on without the launcher waiting, so its status is not the check's. */
const DETACHING_WORD = /^-*(?:start|bg|background|detach|daemon|spawn|nohup|enqueue|queue)$/i
const MAX_LAUNCHER_WORDS = 3
const SHELL_EXPANSION = /[`$]/

/** The words of `rest` with their offsets, split on whitespace outside quotes; null on an unclosed quote. */
function launcherWords(rest: string): Array<{ word: string; at: number }> | null {
  const words: Array<{ word: string; at: number }> = []
  let quote = ''
  let start = -1
  for (let i = 0; i <= rest.length; i++) {
    const ch = rest[i] ?? ' '
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (/\s/.test(ch)) {
      if (start >= 0) words.push({ word: rest.slice(start, i), at: start })
      start = -1
      continue
    } else if (ch === '"' || ch === "'") quote = ch
    if (start < 0) start = i
  }
  return quote === '' ? words : null
}

/** A launcher's check runs from its switches to the segment's end; `python notes.py add npm test` has none. */
export function launcherCarriedCheck(segment: string, isCheck: (candidate: string) => boolean): string | null {
  const rest = LAUNCHER_RUN.exec(segment.trim())?.[1]
  if (rest === undefined || SHELL_EXPANSION.test(rest)) return null
  const words = launcherWords(rest)
  if (words === null) return null
  for (let i = 0; i < Math.min(words.length, MAX_LAUNCHER_WORDS); i++) {
    const own = words.slice(0, i).map((w) => w.word)
    const plain = own.every((word) => LAUNCHER_WORD.test(word))
    if (!plain || own.some((word) => DETACHING_WORD.test(word))) return null
    const candidate = rest.slice(words[i]?.at ?? 0)
    if (isCheck(candidate)) return candidate
  }
  return null
}

/** True when `segment` is a checking script run ({@link isScriptCheckSegment}) whose only arguments besides the check ones are `.md` documents. The documents are not check inputs, so the run is judged as if they were absent: a verdict only when it fails, since a pass on a document names nothing the run verified. Without a `.md` argument it is {@link isScriptCheckSegment}'s run, and a non-checking script is never one. */
export function isDocumentOnlyScriptCheckSegment(segment: string): boolean {
  const run = pythonScriptRun(segment)
  if (run === null) return false
  const inputs = run.words.filter((word) => !DOCUMENT_ARG.test(word))
  return inputs.length < run.words.length && inputs.every(isCheckArgument) && isCheckingScript(run.script, inputs)
}
