# DRY / Consolidation Design — Round 2 (2026-05-24)

**Scope:** 15 new consolidation items not covered by the 55-iteration loop that completed
`docs/plans/2026-05-23-dry-design.md` (items 1–12 DONE, 13–15/18–19 PENDING, 16/17/20 SKIP).
None of the items below duplicate any of the 20 items in that prior doc.

**Scoring key**
- Score 1 — 3+ sites, identical/near-identical pattern, safe, S = < 30 lines
- Score 2 — 2–3 sites with variation, M = 30–100 lines
- Score 3 — Wide refactor touching many callers, L = 100+ lines

---

## Item 1 — Config env-var disable pattern (Score 1 · S)

**Pattern:** Seven features in `config.py` each repeat the same three-line env-var disable block:

```python
env_X = os.environ.get(_ENV_X, "").strip().lower()
if env_X in ("0", "false", "no", "off"):
    _LOG.info("X disabled by environment variable (%s=%s)", _ENV_X, env_X)
    cfg.enabled = False
```

**Sites:** `config.py` — compact_assist (≈l.478), bash_compress (≈l.495), session_brief (≈l.511),
skill_preservation (≈l.527), image_shrink (≈l.543), curator (≈l.559), hint_budget (≈l.575). Seven
instances, identical aside from the env-var name constant, the feature label in the log message, and
which `cfg` object/attribute receives `False`.

**Proposed helper:**

```python
# config.py (module-level)
def _apply_env_disable(cfg_obj: Any, attr: str, env_key: str, label: str) -> None:
    """Set cfg_obj.attr = False when env_key is a falsy env-var value."""
    val = os.environ.get(env_key, "").strip().lower()
    if val in ("0", "false", "no", "off"):
        _LOG.info("%s disabled by environment variable (%s=%s)", label, env_key, val)
        setattr(cfg_obj, attr, False)
```

Each call site collapses to one line:
`_apply_env_disable(cfg, "enabled", _ENV_COMPACT_ASSIST, "compact_assist")`

**Risk:** Low. Pure refactor; no observable behavior change. The helper is private to `config.py`.

---

## Item 2 — `_serialize_grep_entry` / `_serialize_glob_entry` duplicate (Score 1 · S)

**Pattern:** Two functions in `session.py` have byte-for-byte identical bodies; only the return
TypedDict annotation differs:

```python
def _serialize_grep_entry(e: GrepEntry) -> dict[str, Any]:
    return {"pattern": e.pattern, "path": str(e.path), "ts": e.ts, "result_count": e.result_count}

def _serialize_glob_entry(e: GlobEntry) -> dict[str, Any]:
    return {"pattern": e.pattern, "path": str(e.path), "ts": e.ts, "result_count": e.result_count}
```

**Sites:** `session.py:1030–1039` (`_serialize_grep_entry`), `session.py:1042–1051`
(`_serialize_glob_entry`).

**Proposed helper:**

```python
def _serialize_pattern_entry(e: GrepEntry | GlobEntry) -> dict[str, Any]:
    return {"pattern": e.pattern, "path": str(e.path), "ts": e.ts, "result_count": e.result_count}
```

Both callers (`_serialize_grep_entries`, `_serialize_glob_entries`) switch to calling the shared
function. The two typed wrappers can be removed or reduced to one-line aliases.

**Risk:** Low. Both entry types share the same four fields. The structural union type is already
sound; mypy will validate.

---

## Item 3 — `_parse_grep_entry` / `_parse_glob_entry` identical parse logic (Score 1 · S)

**Pattern:** Two parse functions in `session.py` follow the same structure: read `pattern`, `path`,
`ts` (with float coercion), `result_count` from a raw dict, then construct the dataclass. The
bodies differ only in which dataclass (`GrepEntry` vs `GlobEntry`) is constructed on the final
line.

**Sites:** `session.py:1054–1081` (`_parse_glob_entry`), `session.py:1230–1257`
(`_parse_grep_entry`).

**Proposed helper:**

```python
from typing import TypeVar, Callable
_E = TypeVar("_E")

def _parse_pattern_entry(
    v: dict[str, Any],
    factory: Callable[..., _E],
    label: str,
) -> _E | None:
    """Parse a grep-or-glob entry dict, constructing the dataclass via factory."""
    try:
        pattern = str(v.get("pattern", ""))
        path = Path(str(v.get("path", "")))
        ts = _coerce_ts(v.get("ts", 0.0))          # Item 4 helper
        result_count = max(0, int(v.get("result_count", 0)))
        return factory(pattern=pattern, path=path, ts=ts, result_count=result_count)
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted %s entry: %s", label, exc)
        return None
```

Both callers become: `_parse_pattern_entry(v, GrepEntry, "grep")` and
`_parse_pattern_entry(v, GlobEntry, "glob")`.

**Risk:** Low. The factory pattern is standard; mypy inference on the TypeVar keeps return types
correct.

---

## Item 4 — Session `_parse_*` ts float coercion idiom (Score 1 · S)

**Pattern:** Seven locations in `session.py` inline the same conditional:

```python
float(v.get("ts", 0.0)) if isinstance(v.get("ts", 0.0), (int, float)) else 0.0
```

This evaluates `v.get("ts", 0.0)` twice, is verbose, and is repeated at lines ≈1068, 1156, 1244,
1281, 1357, 1385, and in `from_dict` at ≈995.

**Sites:** `session.py` — 7 inline occurrences.

**Proposed helper:**

```python
def _coerce_ts(raw: Any) -> float:
    """Return raw as float if it is numeric, else 0.0."""
    return float(raw) if isinstance(raw, (int, float)) else 0.0
```

Each site becomes: `ts = _coerce_ts(v.get("ts", 0.0))`

**Risk:** Negligible. Pure extraction of an already-correct expression. No behavior change.

---

## Item 5 — Session `max(0, int(v.get(..., 0)))` non-negative int coercion (Score 1 · S)

**Pattern:** Five locations in `session.py` repeat the same pattern for parsing integer counters
from raw session dicts:

```python
max(0, int(v.get("read_count", 0)))
max(0, int(v.get("result_count", 0)))
max(0, int(v.get("token_count", 0)))
# etc.
```

**Sites:** `session.py` — ≈5 inline occurrences across `_parse_*` functions.

**Proposed helper:**

```python
def _coerce_nonneg_int(raw: Any, default: int = 0) -> int:
    """Return int(raw) clamped to ≥0, or default on error."""
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return default
```

Each site becomes, e.g.: `read_count = _coerce_nonneg_int(v.get("read_count", 0))`

**Risk:** Negligible. The `try/except` in the helper is slightly more defensive than the inline
form (which raises on non-numeric strings); existing parse functions already wrap in a broader
`except (TypeError, ValueError, KeyError)` so behavior is unchanged for any realistic input.

---

## Item 6 — `lookup_*_entry` 5-line _resolve_cache + unavailable guard (Score 1 · S)

**Pattern:** Four (possibly five) lookup functions in `session.py` share an identical 5-line
structure:

```python
try:
    cache = self._resolve_cache(session_id)
except ValueError:
    return None
if cache.unavailable:
    return None
return cache.bash_history.get(key)   # field name varies
```

Only the field name accessed on `cache` and the `key` parameter differ.

**Sites:** `session.py` — `lookup_bash_entry` (≈l.2541), `lookup_web_entry` (≈l.2613),
`lookup_skill_entry` (≈l.2690), `lookup_glob_entry` (≈l.2232). Likely `lookup_grep_entry` as well.

**Proposed helper (private method on the session manager class):**

```python
def _lookup_in_cache(
    self,
    session_id: str,
    accessor: Callable[[_CacheEntry], dict[str, Any] | None],
    key: str,
) -> Any | None:
    try:
        cache = self._resolve_cache(session_id)
    except ValueError:
        return None
    if cache.unavailable:
        return None
    mapping = accessor(cache)
    return mapping.get(key) if mapping is not None else None
```

Each lookup function becomes a one-liner:
`return self._lookup_in_cache(session_id, lambda c: c.bash_history, key)`

**Risk:** Low. The lambda accessor is a thin indirection. The method is private; no external API
changes.

---

## Item 7 — `injection_cost_tokens` formula duplicated across hook modules (Score 1 · S)

**Pattern:**

```python
injection_cost_tokens = max(1, int(injection_bytes / CHARS_PER_TOKEN))
```

This appears verbatim in two different hook modules. Both import `CHARS_PER_TOKEN` from
`hooks_common` independently.

**Sites:**
- `src/token_goat/hooks_common.py:345`
- `src/token_goat/hooks_session.py:415`

**Proposed helper (add to `hooks_common.py`, already imported by both callers):**

```python
def bytes_to_tokens(byte_count: int) -> int:
    """Convert a byte count to an approximate token count (minimum 1)."""
    return max(1, int(byte_count / CHARS_PER_TOKEN))
```

Both sites replace their inline formula with `bytes_to_tokens(injection_bytes)`.

**Risk:** Negligible. Pure extraction. `CHARS_PER_TOKEN` stays where it is; only the formula moves.

---

## Item 8 — Path traversal guard (`null-byte + relative_to`) duplicated in paths.py (Score 1 · S)

**Pattern:** Three functions in `paths.py` share an identical traversal-guard structure:

```python
if "\x00" in str(some_id):
    raise ValueError(f"Invalid X id: {some_id!r}")
base = _DATA_ROOT / "subdir"
candidate = (base / f"{some_id}.ext").resolve()
try:
    candidate.relative_to(base.resolve())
except ValueError:
    raise ValueError(f"Path traversal attempt for X: {some_id!r}") from None
return candidate
```

**Sites:** `paths.py` — `project_db_path` (≈l.186–194), `session_cache_path` (≈l.236–243),
`compact_skip_sentinel_path` (≈l.352–361). Possibly a fourth site in `snapshots.py`.

**Proposed helper:**

```python
def _safe_child_path(
    base: Path,
    child_name: str,
    extension: str,
    label: str,
) -> Path:
    """Return base / (child_name + extension) after null-byte and traversal checks."""
    if "\x00" in child_name:
        raise ValueError(f"Invalid {label}: {child_name!r}")
    candidate = (base / f"{child_name}{extension}").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt for {label}: {child_name!r}") from None
    return candidate
```

**Risk:** Low. The helper is private to `paths.py`. Error messages are slightly normalized (labels
become consistent). Existing tests that assert on `ValueError` messages will need updating if they
check the exact text.

---

## Item 9 — Raw `logging.getLogger(f"token_goat.{name}")` calls not using `util.get_logger` (Score 1 · S)

**Pattern:** `util.get_logger(name)` was introduced as the canonical way to create a child logger
under `token_goat.*`. Several modules were not updated to use it:

```python
# cache_common.py (3 sites)
logging.getLogger(f"token_goat.{log_name}")   # lines ≈169, 399, 444

# embeddings.py
logging.getLogger("token_goat.embeddings")    # line ≈47

# languages/common.py
logging.getLogger("token_goat.languages.common")  # line ≈38
```

**Sites:** 5 raw calls across 3 files.

**Proposed fix:** Replace each call with the canonical `util.get_logger(...)` import + call. In
`cache_common.py`, the `log_name` variable is already computed, so the replacement is:
`get_logger(log_name)`. In `embeddings.py` and `languages/common.py` the suffix is a literal string.

**Risk:** Negligible. `util.get_logger` is a thin wrapper around `logging.getLogger`; logger
identity is preserved because the full name is unchanged.

---

## Item 10 — `cmd_skill_body` duplicates output-recall slicing logic (Score 2 · M)

**Pattern:** `cli.py` has a private helper `_run_output_recall_command` (≈l.1305) that handles the
`--head / --tail / --grep / --full` slicing pipeline for `bash-output` and `web-output` commands.
`cmd_skill_body` (≈l.1586) reimplements this pipeline inline:

```python
_slicing_requested = grep or head > 0 or tail > 0
...
if not _slicing_requested and not full:
    text = _apply_smart_default(text, ...)
if head > 0:
    text = "\n".join(text.splitlines()[:head])
if tail > 0:
    text = "\n".join(text.splitlines()[-tail:])
if grep:
    text = "\n".join(ln for ln in text.splitlines() if grep.lower() in ln.lower())
```

**Sites:** `cli.py:1337` (`_run_output_recall_command`), `cli.py:1635` (`cmd_skill_body` inline
duplicate).

**Proposed fix:** Factor the slicing+smart-default pipeline out of `_run_output_recall_command`
into a standalone `_apply_recall_filters(text, *, head, tail, grep, full, token_budget)` function,
then have both `_run_output_recall_command` and `cmd_skill_body` call it.

**Risk:** Medium. `cmd_skill_body` has a slightly different token-budget source (reads from
`config()` instead of receiving it as a parameter). The refactor requires careful parameter
threading to avoid breaking the existing commands. Cover with tests before merging.

---

## Item 11 — `--head/--tail/--grep/--full` Typer options repeated across output commands (Score 2 · M)

**Pattern:** The four output-slicing options are copy-pasted identically into three CLI command
definitions:

```python
head: int = typer.Option(0, "--head", help="Return first N lines.")
tail: int = typer.Option(0, "--tail", help="Return last N lines.")
grep: str = typer.Option("", "--grep", help="Filter lines containing pattern.")
full: bool = typer.Option(False, "--full", help="Return full output without smart truncation.")
```

**Sites:** `cli.py:1399–1402` (`cmd_bash_output`), `cli.py:1436–1439` (`cmd_web_output`),
`cli.py:1589–1592` (`cmd_skill_body`).

**Proposed fix:** Typer does not support shared option groups natively, but the option objects
themselves are constants. Define them once at module level:

```python
_OPT_HEAD  = typer.Option(0,    "--head", help="Return first N lines.")
_OPT_TAIL  = typer.Option(0,    "--tail", help="Return last N lines.")
_OPT_GREP  = typer.Option("",   "--grep", help="Filter lines containing pattern.")
_OPT_FULL  = typer.Option(False,"--full", help="Return full output without smart truncation.")
```

Each command then uses `head: int = _OPT_HEAD`, etc.

**Risk:** Medium. Typer resolves defaults eagerly from the `Option` object; shared `Option`
instances must be tested to confirm Typer does not mutate them between invocations. A quick
integration test with two successive calls to `typer.testing.CliRunner` will confirm.

---

## Item 12 — `--session-id` Typer Option repeated across CLI modules (Score 2 · M)

**Pattern:** The `--session-id` option is defined four times with near-identical help text and
default:

```python
session_id: Optional[str] = typer.Option(None, "--session-id", help="Session ID to target.")
```

**Sites:** `cli.py:792` (`cmd_compact_hint`), `cli.py:813` (`cmd_session_brief`),
`read_commands.py:707` (`cmd_symbol`), `read_commands.py:726` (`cmd_section`).

**Proposed fix:** Define `_OPT_SESSION_ID` once in a shared location (e.g., `cli.py` or a new
`cli_options.py`), import it in `read_commands.py`, and replace all four inline definitions.

**Risk:** Medium. Same Typer-mutable-Option concern as Item 11. Test before shipping.

---

## Item 13 — `USE_COLOR` / isatty + NO_COLOR check divergence across CLI modules (Score 2 · M)

**Pattern:** Three separate sites re-implement the "should we emit ANSI color?" check with slight
variations, diverging from the canonical definition in `render/ansi.py:24`:

| Site | Expression |
|------|-----------|
| `render/ansi.py:24` | `not os.environ.get("NO_COLOR") and sys.stdout.isatty()` |
| `cli.py:43` | `sys.stderr.isatty() and not os.environ.get("NO_COLOR")` |
| `cli.py:52` | `sys.stderr.isatty() and not os.environ.get("NO_COLOR")` |
| `cli_stats.py:23` | `os.environ.get("NO_COLOR") or not sys.stdout.isatty()` |

The `cli.py` variant intentionally uses `stderr` (for the spinner/progress output) while
`render/ansi.py` uses `stdout`. `cli_stats.py` inverts the boolean. These divergences are
semi-intentional but undocumented, making future changes error-prone.

**Proposed fix:** Add two named helpers to `render/ansi.py`:

```python
def color_stdout() -> bool:
    """True when stdout supports ANSI color."""
    return not os.environ.get("NO_COLOR") and sys.stdout.isatty()

def color_stderr() -> bool:
    """True when stderr supports ANSI color."""
    return not os.environ.get("NO_COLOR") and sys.stderr.isatty()
```

`cli.py` uses `color_stderr()`; `cli_stats.py` uses `not color_stdout()` (or a named inverse).
`USE_COLOR` in `render/ansi.py` becomes `USE_COLOR: bool = color_stdout()`.

**Risk:** Medium. The behavioral difference between stdout vs stderr variants is real and must be
preserved. Requires verifying which stream each call site targets before substituting.

---

## Item 14 — Git `subprocess.run` inline in `compact.py` vs `_run_git` in `git_history.py` (Score 2 · M)

**Pattern:** `compact.py` contains ≈7 inline `subprocess.run(["git", ...], capture_output=True,
text=True, timeout=N)` calls. `git_history.py` already has a private helper:

```python
def _run_git(args: list[str], cwd: Path | None, timeout: int = 10) -> str | None:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout
    )
    return result.stdout.strip() if result.returncode == 0 else None
```

`compact.py` does not import or use this helper; it duplicates the pattern inline each time.

**Sites:** `compact.py` — ≈7 sites; `git_history.py:79` — the canonical helper.

**Proposed fix:** Move `_run_git` to a shared `git_utils.py` (or to `util.py`), have both
`compact.py` and `git_history.py` import from there.

**Risk:** Medium. `compact.py` uses various `timeout` values and may check `returncode` directly
on some calls rather than trusting `_run_git`'s `None`-on-failure contract. Each inline call must
be audited before substituting.

---

## Item 15 — `_parse_*_entry` `except (TypeError, ValueError, KeyError)` boilerplate (Score 3 · L)

**Pattern:** Seven `_parse_*_entry` functions in `session.py` each wrap their body in:

```python
try:
    ...field extraction and dataclass construction...
except (TypeError, ValueError, KeyError) as exc:
    _LOG.debug("session: skipping corrupted %s entry: %s", label, exc)
    return None
```

This is the outermost error handler for all entry parsing. The label string (e.g., `"bash"`,
`"grep"`, `"web"`, `"skill"`, `"read"`, `"glob"`, `"edit"`) is the only variation.

**Sites:** `session.py` — `_parse_bash_entry`, `_parse_grep_entry`, `_parse_glob_entry`,
`_parse_web_entry`, `_parse_skill_entry`, `_parse_read_entry`, `_parse_edit_entry` (7 functions).

**Proposed helper:**

```python
from typing import TypeVar, Callable
_T = TypeVar("_T")

def _safe_parse(
    factory: Callable[[dict[str, Any]], _T],
    data: dict[str, Any],
    label: str,
) -> _T | None:
    """Call factory(data), logging and returning None on any parse error."""
    try:
        return factory(data)
    except (TypeError, ValueError, KeyError) as exc:
        _LOG.debug("session: skipping corrupted %s entry: %s", label, exc)
        return None
```

Each `_parse_*_entry` function loses its try/except and is reduced to pure field-extraction logic.
The call sites that currently call `_parse_bash_entry(v)` become `_safe_parse(_parse_bash_entry_inner, v, "bash")`.

**Risk:** High relative to other items. Requires touching 7 functions plus their call sites,
reorganizing the exception boundary to be outside rather than inside each parser, and verifying
that no parser relies on a mid-function early return that the try/except previously swallowed.
Full test coverage of all 7 parse paths (including corrupted-input cases) is required before
merging. This is the highest-impact consolidation in this batch — reduces ~50 lines of identical
boilerplate — but demands a careful incremental approach: migrate one parser at a time with a
passing test for each.

---

## Summary

| # | Pattern | Files | Score | Size |
|---|---------|-------|-------|------|
| 1 | Config env-var disable pattern | `config.py` (7 sites) | 1 | S |
| 2 | `_serialize_grep/glob_entry` duplicate | `session.py` (2 sites) | 1 | S |
| 3 | `_parse_grep/glob_entry` identical parse logic | `session.py` (2 sites) | 1 | S |
| 4 | ts float coercion idiom | `session.py` (7 sites) | 1 | S |
| 5 | `max(0, int(...))` non-negative int coercion | `session.py` (5 sites) | 1 | S |
| 6 | `lookup_*_entry` _resolve_cache + unavailable guard | `session.py` (4–5 sites) | 1 | S |
| 7 | `injection_cost_tokens` formula | `hooks_common.py`, `hooks_session.py` | 1 | S |
| 8 | Path traversal guard (null-byte + relative_to) | `paths.py` (3–4 sites) | 1 | S |
| 9 | Raw `logging.getLogger` not using `util.get_logger` | `cache_common.py`, `embeddings.py`, `languages/common.py` | 1 | S |
| 10 | `cmd_skill_body` duplicates recall slicing | `cli.py` (2 sites) | 2 | M |
| 11 | `--head/--tail/--grep/--full` options repeated | `cli.py` (3 sites) | 2 | M |
| 12 | `--session-id` option repeated | `cli.py`, `read_commands.py` (4 sites) | 2 | M |
| 13 | `USE_COLOR`/isatty+NO_COLOR divergence | `render/ansi.py`, `cli.py`, `cli_stats.py` | 2 | M |
| 14 | Git subprocess inline vs `_run_git` helper | `compact.py` (7 sites), `git_history.py` | 2 | M |
| 15 | `_parse_*_entry` try/except boilerplate | `session.py` (7 functions) | 3 | L |

**Totals:** 9 × Score-1, 5 × Score-2, 1 × Score-3 = 15 items.
