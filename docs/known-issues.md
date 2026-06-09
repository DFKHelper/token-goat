# Known issues — 2026-06-09

Latent issues found but not yet fixed, recorded so the next person has the
measurement and the root cause instead of rediscovering them.

## Cross-session cache-hit asymmetry: Bash file-reads vs native `Read` — OPEN (low severity)

**Symptom:** identical file content is treated inconsistently across sessions
depending on *which tool* surfaced it. A file read issued as a Bash command
(`cat file`, `Get-Content file`, etc.) can receive a "this output is already
cached from a prior session" hint, while a native `Read(file)` of the same file
— or a Bash read that token-goat rewrote into a synthesized `Read` — receives no
cross-session treatment at all.

**Where it comes from:**

* Bash commands flow through `hints.py::build_bash_cache_hit_hint`, which calls
  `bash_cache.find_cached_for_command(command, cwd)` to look up output cached on
  disk by *any* prior session. Bash output has a persistent on-disk ledger
  (sidecar metadata under the per-project cache), so the lookup can succeed
  across sessions.
* File reads have no equivalent cross-session ledger. The session cache marks a
  path as "already touched" only *within the current session*; once the session
  ends, that state is gone. So native `Read` (and the converted
  bash-read-equivalents produced by `hooks_read.py::_handle_bash_read_equivalent`)
  get within-session dedup only.

**Why it usually does not bite:** `_handle_bash_read_equivalent` rewrites most
file-read Bash commands (`cat`/`head`/`tail`/`sed`/`Get-Content`, including globs
and multi-file forms) into synthesized `Read`s *before* the bash-cache path runs,
so they take the file-read route, not the Bash route. The asymmetry only surfaces
on the residual ~10–15% that escape the rewrite (e.g. the POSIX `type` builtin,
malformed commands), which stay as Bash and reach the cross-session lookup. A
clean native `Read` of the same file does not.

**Net effect:** a small, content-dependent inconsistency in whether a repeat read
is flagged as redundant across sessions. It never serves *wrong* content — a miss
just means a hint is not emitted — so the cost is a missed savings opportunity,
not a correctness bug.

**Discovered:** context-savings audit (Loop 2 adversarial verification of
opportunity #2, the bash-read-equivalent conversion). The headline conversion
work shipped; this asymmetry is the residual edge it left behind.

**Possible fix (not yet scoped):** give file reads a cross-session ledger
analogous to the Bash sidecar — keyed on `(normalized_path, content_sha)` so a
re-read of unchanged content can be flagged across sessions — or route the
residual escaped Bash reads through the same file-read dedup so both tools share
one path. Either needs a staleness/`mtime` guard so a changed file is never
suppressed.
