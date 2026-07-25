> **STATUS (2026-05-24):** Items 1–12 DONE (iter 41–45). Items 13–15, 18–19 PENDING. Items 16, 17, 20 DELIBERATE-SKIP.

# DRY Consolidation Design — 2026-05-23

## Problem

token-goat has had four prior DRY passes (commits `56190217`, `8cb04609`, `fc5e5075`, `5f9dca5f`) which extracted the biggest offenders into `cache_common.py`, `hooks_common.py`, and `languages/common.py`. The surface still carries roughly **600–900 lines of removable duplication** concentrated in four bands: (1) PostToolUse payload extraction across `hooks_read.post_bash`, `hooks_fetch.post_fetch`, and `hooks_skill.post_skill` which each re-implement nearly identical `tool_response → text/body` walkers; (2) three `*_cache.py` modules that still carry per-cache `_safe_join`, `output_id_for`, `sha-256[:16]`, `_OutputStatDict`, and `sidecar_meta_path` boilerplate even after the `cache_common` extraction; (3) the four pre-hook handlers (`_handle_bash_dedup`, `_handle_grep_dedup`, `_handle_glob_dedup`, `_handle_web_dedup`) that share a 15-line "load session, build hint, record stat pair, log, return context response" skeleton with only the hint builder and stat-kind label varying; (4) two CLI commands (`cmd_bash_output`/`cmd_web_output`) and two list commands (`cmd_bash_history`/`cmd_web_history`) which are 90-line near-copies of one another. There is also a `_humanize_bytes` triplicate (`compact._humanize_bytes`, `cli_doctor._humanize_bytes_doctor`, `stats._fmt_bytes`) plus a `_fmt_bytes` quadruplicate when counting `render/stats_renderer._fmt_bytes`.

## Methodology

1. Ran `token-goat map --compact` to rank files by repo-importance and read-frequency.
2. Grepped for duplicate function signatures (`def _safe_join`, `def _extract_*_response`, `def cmd_*_(output|history)`, `def _humanize_bytes`), repeated literals (`hashlib.sha256(...).hexdigest()[:16]`, `data_dir() / "X"`, `payload.get("tool_response")`, `typer.Option(False, "--json")`), and repeated try/except shapes (`except Exception: _LOG.debug(...stat record failed...)`).
3. Read every file in `src/token_goat/hooks_*.py`, `src/token_goat/*_cache.py`, `src/token_goat/cache_common.py`, `src/token_goat/hooks_common.py`, all 13 `src/token_goat/languages/*.py`, and `src/token_goat/read_commands.py` + the JSON-output blocks of `cli.py:1290-1570`.
4. Cross-referenced findings against `compact.py:1403`, `stats.py:505`, `cli_doctor.py:61`, and `render/stats_renderer.py:173` to confirm humanize/format duplication.
5. Inventoried four prior DRY commits in the history to avoid recommending consolidations already done.

## Consolidation Backlog (ranked)

### 1. PostToolUse `tool_response` body extractor (HIGH IMPACT)
**STATUS:** DONE (iter 45, commits 3d23f19, 3d11a4f)

**Locations**: `src/token_goat/hooks_read.py:817-1013` (`_coerce_text` + `_extract_bash_response`), `src/token_goat/hooks_fetch.py:243-301` (`_extract_web_response`), `src/token_goat/hooks_skill.py:49-91` (`_extract_skill_body`). All three walk the same `payload["tool_response"] → tool_result → response` chain, accept the same string/dict/MCP-content-array shape, and probe the same key set (`output`/`text`/`body`/`content`/`stdout`).
**Lines saved**: ~120
**Approach**: New `hooks_common.extract_tool_response_text(payload, *, keys=("output","text","body","content"))` returning `str`. Add sibling `extract_tool_response_pair(payload, body_keys, status_keys, exit_keys)` returning `(body, secondary_int_or_none)` for the bash exit-code + web status-code variants. Move `_coerce_text` into `hooks_common` as `coerce_mcp_text`.
**Risk**: med — the bash variant's stderr probe (`raw_resp.get("stderr") or raw_resp.get("err")`) and the top-level `payload.get("stdout") or payload.get("output")` fallback need a `secondary_field` parameter, otherwise we lose harness-version coverage.
**Test**: existing `tests/test_hooks_pre_fetch.py`, `tests/test_post_bash_payloads.py`, `tests/test_skill_preservation.py` cover all three call sites; add one focused `tests/test_hooks_common.py::test_extract_tool_response_text_shapes` for the helper.

### 2. Per-cache `_safe_join` + `_OutputStatDict` (HIGH IMPACT)
**STATUS:** DONE (iter 45, commit d24a5b4)

**Locations**: `src/token_goat/bash_cache.py:100-109,145-151`, `src/token_goat/web_cache.py:119-127,164-170`, `src/token_goat/skill_cache.py:113-119,170-172`. The `class _OutputStatDict(TypedDict)` triplicate is byte-for-byte identical; the three `_safe_join` wrappers each forward to `safe_join_output_id` with one constant-string parameter difference.
**Lines saved**: ~45
**Approach**: Export `cache_common._OutputStatDict` publicly as `cache_common.OutputStatDict` (already imported indirectly via `list_cache_outputs` return type). Delete each module's local copy. Replace each `_safe_join(out_id)` with a lambda or a `functools.partial(safe_join_output_id, cache_dir_fn=_X_outputs_dir, log_name="X_cache")`.
**Risk**: low — `_safe_join` is module-private; only intra-file callers.
**Test**: existing `tests/test_bash_cache.py`, `tests/test_web_cache.py`, `tests/test_skill_cache.py` pass unchanged.

### 3. `*_cache.output_id_for` + content hash collapse (HIGH IMPACT)
**STATUS:** DONE (iter 45, commit 47072d6)

**Locations**: `src/token_goat/bash_cache.py:116-142` (`command_hash` + `output_id_for`), `src/token_goat/web_cache.py:137-161` (`url_hash` + `output_id_for`), `src/token_goat/skill_cache.py:126-167` (`content_hash` + `output_id_for`). Each pair is the same `sha256(text)[:16]` plus the same `f"{safe_session}-{ms:013d}-{hash}"` template (or `{name}-{hash}` for skills). Three identical 4-line `hexdigest()[:16]` helpers exist.
**Lines saved**: ~60
**Approach**: Add `cache_common.short_content_hash(text: str) -> str` returning `sha256(text.encode(..., errors='replace')).hexdigest()[:16]`. Add `cache_common.build_output_id(session_id, content_token, *, ts=None)` returning the canonical `{session_short}-{ms:013d}-{content_token}` shape. Skill cache keeps its `output_id_for` (name-not-time-based) but uses the shared `short_content_hash`.
**Risk**: low — pure refactor of a hash helper, no on-disk format change.
**Test**: existing cache test suites cover round-trip.

### 4. Pre-hook dedup-handler skeleton (HIGH IMPACT)
**STATUS:** DONE (iter 45, commit 809aed4)

**Locations**: `src/token_goat/hooks_read.py:402-440` (`_handle_grep_dedup`), `hooks_read.py:488-526` (`_handle_glob_dedup`), `hooks_read.py:529-564` (`_handle_bash_dedup`), `src/token_goat/hooks_fetch.py:141-170` (`_handle_web_dedup`). Each is the same template: get session context → load session cache → call a hint builder → call `record_hint_stat_pair` with a kind string → log → return `pre_tool_use_with_context(str(hint))`. About 35 lines × 4 = 140 lines of glue.
**Lines saved**: ~80
**Approach**: New `hooks_common.run_dedup_hint(payload, *, builder, stat_kind, log_label, detail_field)` where `builder(session_id, tool_input, cache) -> ReadHint | None` and `detail_field` names the `tool_input` key to extract as the stat detail (`command`/`pattern`/`url`). Each existing handler shrinks to a ~6-line config block.
**Risk**: med — the four handlers have small per-tool kwargs to the builder (`pattern`, `path`, `command`, `url`); the builder signature must absorb a `tool_input` dict not yet uniformly typed. A typed `Protocol` for the builder signature avoids `Any`.
**Test**: existing `tests/test_hooks_pre_read.py` and `tests/test_hooks_pre_fetch.py` cover all four; add one `tests/test_hooks_common.py::test_run_dedup_hint_dispatch` for the helper.

### 5. `cmd_bash_output` / `cmd_web_output` near-duplicate CLI bodies (HIGH IMPACT)
**STATUS:** DONE (iter 45, commit a5c68d4)

**Locations**: `src/token_goat/cli.py:1290-1382` (cmd_bash_output, 93 lines), `cli.py:1385-1470` (cmd_web_output, 86 lines). The slicing path (lines→`_slicing_requested`→grep/head/tail→`_apply_smart_default`), recall stat recording (`bash_output_recall` vs `web_output_recall`), and JSON payload assembly (`numbered_lines` with `original_index` dict) are line-for-line identical except for module imports and three sidecar field names.
**Lines saved**: ~90
**Approach**: New `_run_output_recall_command(*, output_id, head, tail, grep, full, json_output, cache_module, stat_kind, sidecar_fields: list[str])` in `cli.py` (or split to `output_commands.py` if `cli.py` is to be slimmed). Each `cmd_*_output` becomes ~12 lines.
**Risk**: low — both commands have full CLI test coverage (`tests/test_bash_cli.py`).
**Test**: existing `tests/test_bash_cli.py` + `tests/test_webfetch.py` smoke tests already exercise both paths.

### 6. `cmd_bash_history` / `cmd_web_history` (HIGH IMPACT)
**STATUS:** DONE (iter 45, commit 985ea60)

**Locations**: `src/token_goat/cli.py:1473-1519` (cmd_web_history), `cli.py:1522-1569` (cmd_bash_history). Same shape: `list_outputs` → `[:limit]` → JSON branch concatenating sidecar fields onto each row → text branch with one-liner-per-entry render. Only the sidecar field names (`url_preview`/`status_code` vs `cmd_preview`/`exit_code`) and the empty-state message differ. Add `cmd_skill_history` (cli.py:1676+) — same shape with one more field.
**Lines saved**: ~70
**Approach**: `_run_history_command(*, cache_module, json_output, limit, sidecar_attrs: list[str], render_extras_fn, empty_msg)`. The render_extras callback returns the "exit=N" / "status=N" string fragment.
**Risk**: low — well-tested commands.
**Test**: existing `tests/test_bash_cli.py`.

### 7. `_humanize_bytes` triplicate (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commit 6e1ba74)

**Locations**: `src/token_goat/compact.py:1403-1419` (`_humanize_bytes`, KB/MB), `src/token_goat/cli_doctor.py:61-74` (`_humanize_bytes_doctor`, KB/MB/GB), `src/token_goat/stats.py:505-512` (`_fmt_bytes`, B/KB/MB/GB/TB/PB). Three different ranges, otherwise identical 1024-base step logic. `cli_doctor` even notes the duplication: "Identical shape to :func:`compact._humanize_bytes`".
**Lines saved**: ~25
**Approach**: Promote to `paths.humanize_bytes(n, *, max_unit="PB")` or new `_humanize.py` module. `compact` calls with `max_unit="MB"`, `cli_doctor` with `max_unit="GB"`, `stats` with default `"PB"`. Cross-module import is safe because `compact` already pulls `_humanize_bytes` from itself to `hooks_session`, demonstrating the import path is clean.
**Risk**: low — already proven cross-module-callable (hooks_session imports compact._humanize_bytes).
**Test**: snapshot tests in `tests/test_compact.py` and `tests/test_doctor.py` cover output shapes.

### 8. `_extract_text_from_mcp_content_array` extraction (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commits 3d23f19, 3d11a4f — subsumed by item 1)

**Locations**: `src/token_goat/hooks_read.py:840-852` (inside `_coerce_text`), `hooks_fetch.py:272-280` (inside `_extract_web_response`), `hooks_skill.py:71-89` (inside `_extract_skill_body`). All three iterate a list-of-dicts looking for `{"type": "text", "text": "..."}` items and concatenate text. ~12 lines each.
**Lines saved**: ~30
**Approach**: Roll into the same helper as item 1 (`hooks_common.coerce_mcp_text`). If item 1 is implemented this collapses naturally; listed separately because it could land independently if item 1 is delayed.
**Risk**: low — pure code motion.
**Test**: subsumed by item 1.

### 9. `try: cache = session.load(session_id) except (OSError, ValueError): return None` (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commit 9c3d8d1)

**Locations**: `src/token_goat/hooks_read.py:425-428,463-466,511-514,549-552`, `hooks_fetch.py:155-158` — five occurrences of the same 4-line try/except.
**Lines saved**: ~25
**Approach**: Add `hooks_common.try_load_session(session_id) -> SessionCache | None` that swallows `(OSError, ValueError)` and returns `None`. If item 4 (`run_dedup_hint`) lands, the four dedup-handler occurrences disappear; the fifth in `_handle_grep_written_not_read` remains and benefits independently.
**Risk**: low — pure refactor.
**Test**: existing hook tests.

### 10. `data_dir() / "X"` + `paths.ensure_dir` per-cache helpers (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commit df41374)

**Locations**: `src/token_goat/bash_cache.py:111-113` (`_bash_outputs_dir`), `web_cache.py:130-134` (`_web_outputs_dir`), `skill_cache.py:121-123` (`_skill_outputs_dir`), plus `snapshots.py:103,271`, `paths.py:175-332` (~10 sibling getters). The `_web_outputs_dir` even uses inline `mkdir(parents=True, exist_ok=True)` instead of the existing `paths.ensure_dir` helper — a minor inconsistency.
**Lines saved**: ~20
**Approach**: Add `paths.cache_subdir(name: str) -> Path` returning `ensure_dir(data_dir() / name)`. Each cache module's `_X_outputs_dir = lambda: paths.cache_subdir("X_outputs")` or even drop the wrapper entirely and inline the call.
**Risk**: low — single function.
**Test**: existing cache tests; cross-platform path tests already in `tests/test_paths.py`.

### 11. `write_sidecar` / `sidecar_meta_path` per-cache wrappers (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commit df41374)

**Locations**: `bash_cache.py:284-305`, `web_cache.py:259-274`, `skill_cache.py:291-306`. Each module has a `sidecar_meta_path(output_id)` that calls `_safe_join(output_id).with_suffix(".json")` and a `write_sidecar(meta)` that forwards to `cache_common.write_sidecar_metadata`. The pattern is identical; only the `log_prefix` string differs.
**Lines saved**: ~30
**Approach**: New `cache_common.make_sidecar_writer(cache_dir_fn, log_name, log_module)` returning a `(sidecar_path_fn, write_sidecar_fn)` pair, or simpler: a single `cache_common.sidecar_meta_path(output_id, cache_dir_fn, log_name)` mirror of `safe_join_output_id` and have each module write `write_sidecar = lambda meta: write_sidecar_metadata(sidecar_meta_path(meta.output_id, ...), meta, log=..., log_prefix=...)`.
**Risk**: low — the dataclass type per cache is different but `write_sidecar_metadata` already accepts `Any`.
**Test**: existing cache tests.

### 12. `cached_recovery_stat_pair` for informational `*_cached` rows (MEDIUM IMPACT)
**STATUS:** DONE (iter 45, commit 47072d6)

**Locations**: `hooks_read.py:1088-1095` (`bash_output_cached`), `hooks_fetch.py:367-374` (`web_output_cached`), `hooks_skill.py:194-201` (`skill_cached`). All three are `try: db.record_stat(None, "X_cached", bytes_saved=0, tokens_saved=0, detail=...) except Exception: _LOG.debug("X: stat record failed", exc_info=True)`.
**Lines saved**: ~25
**Approach**: Add `hooks_common.record_cache_capture_stat(kind: str, detail: str, log_label: str) -> None` that wraps the try/except.
**Risk**: low — purely a logging convenience.
**Test**: existing hook tests.

### 13. `_extend_starts_for_decorators` Python ⇄ TypeScript near-duplicate (MEDIUM IMPACT)
**Locations**: `src/token_goat/languages/python.py:25-69`, `src/token_goat/languages/typescript.py:23-123` (the multi-line decorator walker is more elaborate, but the outer `for sym in symbols: if sym.kind not in eligible: continue; new_start = walk(text_lines, sym.line); if new_start != sym.line: sym.line = new_start` shell is identical).
**Lines saved**: ~25
**Approach**: Add `common.extend_starts_for_decorators(symbols, source, *, eligible_kinds, walk_fn)` taking a per-language walker. The Python walker (simple decorator line regex) and TS walker (bracket-balanced multi-line) stay separate but the iteration shell unifies.
**Risk**: low-med — Python's walker has a "blank line between stacked decorators" rule that TS shares; making sure the walker signature accommodates both is required.
**Test**: `tests/test_languages.py` (decorator round-trip).

### 14. `import sha256` + 16-hex truncation idiom (MEDIUM IMPACT)
**Locations**: `bash_cache.py:125`, `web_cache.py:147`, `skill_cache.py:134`, `project.py` (project hash — different length but same idea), `webfetch.py` (URL hash candidate), `snapshots.py` (content hash). All `hashlib.sha256(X.encode("utf-8", errors="replace")).hexdigest()[:N]`.
**Lines saved**: ~20
**Approach**: Subsumed by item 3 (`cache_common.short_content_hash`), but worth listing separately because a project-wide `paths.short_hash(text, length=16)` covers more sites than just the three caches.
**Risk**: low — pure refactor.
**Test**: cache + project tests.

### 15. `_ANSI_ESCAPE_RE` and `_fmt_bytes` between `stats.py` and `render/stats_renderer.py` (LOWER IMPACT)
**Locations**: `src/token_goat/stats.py:505-512` (`_fmt_bytes` + `_fmt_tokens`), `src/token_goat/render/stats_renderer.py:173-188` (richer ANSI-colored version), `render/ansi.py:35` (ANSI escape regex used in two places). The ANSI regex is already centralised; the `stats.py` plain-text `_fmt_bytes` duplicates what `stats_renderer.py` does without colour.
**Lines saved**: ~15
**Approach**: Item 7 subsumes the bytes formatter cross-module problem. For stats.py specifically, consider importing `render.stats_renderer._fmt_bytes` (or the new central one) with a "plain mode" flag that strips ANSI when `USE_COLOR=False`.
**Risk**: low — output shape verifiable.
**Test**: `tests/test_stats.py`.

### 16. `_LOG = logging.getLogger("token_goat.X")` per-module incantation (LOWER IMPACT)
**Locations**: 30+ modules, each with `_LOG = logging.getLogger(f"token_goat.{module}")`. While individually trivial, hooks already share `LOG = logging.getLogger("token_goat.hooks")` from `hooks_common`. The cache modules and language adapters could similarly share namespaced loggers if a helper existed.
**Lines saved**: ~30 (one per module, but cosmetic)
**Approach**: Add `paths.module_logger(__name__)` that returns `logging.getLogger(__name__.replace("token_goat", "token_goat"))`. **Recommendation: skip this** — Python convention is `logging.getLogger(__name__)` directly. The current pattern is idiomatic; "consolidating" it adds an indirection layer for no real benefit.
**Risk**: n/a — recommended SKIP.
**Test**: n/a.

### 17. `_intercept_X` deny_redirect builders (LOWER IMPACT)
**Locations**: `src/token_goat/hooks_fetch.py:82-114` (`_intercept_drive_download`), `hooks_fetch.py:117-138` (`_intercept_webfetch_image`). Both build a `deny_redirect(reason, context)` with similar message structure. ~20 lines.
**Lines saved**: ~10
**Approach**: Marginal. The two intercept paths have different sanitisation rules (`_sanitize_url_for_embed` vs `_validate_file_id`) and different hint composition (`sections_hint` is drive-only). **Likely premature abstraction — recommend SKIP.**
**Risk**: n/a — recommended SKIP.
**Test**: n/a.

### 18. `_emit_*_error` JSON-vs-text emission family (LOWER IMPACT)
**Locations**: `read_commands.py:175-247` (`_emit_read_error`, `_emit_ambiguous_file_match`, `_emit_file_not_found_error`). Already extracted. Cross-check with `cli.py:_error` (a single-line typer.echo to stderr) — they could share an `error_payload(code, message, **details)` builder that both consume.
**Lines saved**: ~15
**Approach**: Hoist `_emit_read_error` to a public `cli_common.emit_error(code, message, json_output, **details)` and let `cli.py:_error` use it for its few JSON-emitting commands.
**Risk**: med — `cli.py:_error` currently has a deliberately minimal API; aligning shapes might break callers that grep stderr in tests.
**Test**: `tests/test_read_replacement.py` covers all error shapes.

### 19. `validate_session_id` try/except wrapper (LOWER IMPACT)
**Locations**: `src/token_goat/cli.py:130-149` (`_validate_session_id`) — already extracted from "all five session-aware commands". Verify no remaining inline copies in `session.py` or `read_commands.py`.
**Lines saved**: ~10 (audit only)
**Approach**: Audit pass. Already done in cli.py per the docstring; check sibling modules.
**Risk**: low.
**Test**: existing tests.

### 20. `_extract_module` / import-target extraction across language adapters (LOWER IMPACT)
**Locations**: `languages/python.py:_parse_import_source`, `languages/rust.py:_parse_use_target`, `languages/typescript.py:_extract_module`, `languages/go.py:_extract_go_import_target`. Each is a tiny per-language string-parsing function passed to `common.add_imports`. The four functions are already small; further consolidation would force a shared regex registry that doesn't map cleanly.
**Approach**: **Recommend SKIP**. The functions are correctly factored at the right grain — each language's import syntax is structurally distinct, and the only commonality (a regex on `.source`) is captured already by `common.add_imports`. Listed here for completeness so the reviewer doesn't try to merge them.
**Risk**: n/a — recommended SKIP.
**Test**: n/a.

## Out of scope

- **Logger per-module pattern (item 16)** — idiomatic, "consolidation" would harm readability.
- **`_intercept_drive_download` vs `_intercept_webfetch_image` (item 17)** — only two callers, divergent sanitisation, abstraction would lose clarity.
- **Per-language `_extract_*_target` import helpers (item 20)** — already at the right grain; merging would re-introduce conditionals on `language=="X"`.
- **`make_add_symbol` recursion shell** — already extracted into `common.collect_symbols_and_refs` in commit `39353e01`.
- **`_HOOK_CTX` Typer context_settings repetition** — already a single module-level constant in `cli.py`.
- **Test fixtures across `tests/test_*_cache.py`** — explicitly out of scope per the task constraints (focus on src/).
- **`mark_file_read` + `mark_file_edited` session mutators** — these are core domain operations with semantically distinct side effects; sharing implementation would obscure intent.
- **`open_global_readonly` vs `open_project_readonly`** — already share `db._open_readonly_impl` under the hood.

## Hypothesis

The riskiest single bet is **item 1 (`extract_tool_response_text`)**. The three call sites (`_extract_bash_response`, `_extract_web_response`, `_extract_skill_body`) currently survive harness payload-shape drift across Claude Code versions, Codex, MCP-relayed Bash, MCP-relayed WebFetch, and one MCP-Skill variant. Consolidating into a single helper *must* preserve every shape currently accepted; missing a shape would silently break post-hook caching for one tool surface — and since the hook returns `CONTINUE` on cache-write failure, the regression would not surface as a crash, only as a missing dedup hint days later. Mitigation: write a `tests/test_hooks_common.py::test_extract_tool_response_text_shapes` first, parametrised on every shape currently exercised by the three existing test files; only then refactor the call sites to point at the helper. If even one shape needs a special-case parameter (e.g. bash's stderr path), the helper grows a kwarg rather than being inlined back — but if it grows three kwargs, that is the signal that the abstraction is wrong and these three extractors should stay separate.

The second-riskiest is **item 4 (`run_dedup_hint`)** because the four dedup handlers pull *different* fields from `tool_input` and the builder signatures vary; the dispatcher's kwargs surface could end up larger than the duplication it removes. Mitigation: prototype the helper against grep+glob (the two most similar) first, validate the abstraction is clean, then absorb bash+web. If bash+web force a `Protocol[**P]` or an `Any`, retreat to a two-handler helper rather than four.

Total estimated lines saved across the 15 actionable items: **~700 lines** (high-impact items 1–6: ~465 lines; medium-impact items 7–14: ~210 lines; lower-impact 15, 18, 19: ~40 lines).
