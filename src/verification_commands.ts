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

/** True when `segment` (its leading `NAME=value` assignments already removed) runs a script that checks a repository: one with a checking file name, or any script given `--self-test`, carrying only path or selector arguments besides that switch. A bare `python foo.py` is not one, and neither is a help, listing, version or preview run of a checking script. */
export function isScriptCheckSegment(segment: string): boolean {
  const script = PYTHON_SCRIPT_RUN.exec(segment)?.[1]
  if (script === undefined || !SCRIPT_PATH.test(script)) return false
  const words = segment.trim().split(/\s+/).slice(2)
  if (!words.every(isCheckArgument)) return false
  const name = script.split(/[/\\]/).pop() ?? ''
  return CHECK_SCRIPT_NAME.test(name) || words.includes(SELF_TEST_FLAG)
}
