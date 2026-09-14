# Security-auditor agent notes — token-goat

## A pre-approval filesystem touch in `relay.ts` is invisible to the registry sweep — this is the third recurrence (2026-09-12)
`tests/vscode_pre_handler_path_gate.test.ts` builds its population from the live handler registry, so by construction it can only see code a registered `pre_tool_use` handler reaches. Everything `relay.ts` does before `runHook` dispatches — `buildEvent`, `normalizePayload`, and the duplicate-suppression check — is outside that population and always has been. Three pre-approval touches have now landed in the relay or its callees:

1. `view_image` stat'd a UNC or out-of-workspace path before approval;
2. every VS Code pre hook stat'd its path before approval (fixed `1c6368fd` by the shared `vscode_path_gate` plus the registry sweep — which is exactly the guard that cannot see the pre-dispatch half);
3. `vscode_duplicate.ts::userScopeCopyIsRedundant` ran a bare `fs.existsSync` on a VS-Code-supplied `cwd`; on Windows a UNC `cwd` turns that into an outbound SMB connection carrying an NTLM authentication attempt, with no timeout available on the in-process path.

Audit rule that follows: **check `relay.ts` and everything it calls before `buildEvent`'s handlers separately from the registry.** A green `vscode_pre_handler_path_gate` says nothing about that region. Grep for `fs.`/`net.` in the closure rather than trusting the sweep, or read `tests/guards/pre_handler_fs_touches_are_gated.test.ts`, which now automates exactly this walk (from `relayInProcess` up to the first `runHook`, inverted default: an unclassified direct `fs`/`net` call is red on arrival). Its stated false-negative is a payload-derived path laundered through a wrapper such as `ensureDirSync` — direct calls only, because transitive propagation reds `relayInProcess` itself. If a finding has that laundered shape, the guard will not catch it and it needs a hand-written test.

Note that only instance 3 is in the new guard's population; 1 and 2 sat inside registered handlers. The two guards partition the relay at the dispatch boundary, and an audit of pre-approval behaviour has to look at both populations, not either one.

## Severity here is driven by "who controls the input", and commit `d4fc796c` moved that line (2026-09-12)
`install --vscode` defaulted to USER scope before `d4fc796c` and to PROJECT scope after it. That flip is what first points the installer and the VS Code hook at content a *repository* controls, and it re-prices findings that were previously cosmetic:

- a config path the installer reads or backs up can now be a symlink a clone committed (`.github/copilot-instructions.md` → `~/.ssh/id_ed25519`), and `copyFileSync` follows the source link;
- a file merely *existing* in the clone can now be load-bearing for a security decision (`.github/hooks/token-goat.json` containing `{}` stood every VS Code hook down);
- the `cwd` VS Code hands a hook is workspace-controlled and arrives before the user approves anything.

When reviewing any change under `src/bridges/*_install.ts` or `src/vscode_*`, ask which scope the path came from before rating the finding: the same line is low severity at user scope and medium at project scope. Two corollaries found while fixing these. A leaf `lstat` is not enough — a repository can commit `.github` itself as a directory symlink and leave an ordinary file at the leaf, so the check has to be realpath containment. And the refusal must be scoped to project targets: a symlinked `~/.copilot/...` dotfile is a normal user setup, and refusing it breaks real installs.

## A repository can forge anything inside the clone; only `dataDir()` is out of its reach (2026-09-12)
The `token-goat.owners` sidecar is a plain text file in the working tree, so any check that rests on it alone raises the attacker's cost without closing the class. The created-configs ledger under `dataDir()` is the half a clone cannot write, and it is the check that actually has to fail for a clone-planted-file attack to work. When accepting a fix of this shape, require the comment to say which half is forgeable rather than implying the class is closed — an unqualified "two checks now have to agree" reads as stronger than it is.

## A per-document bound checked only inside a per-chunk loop is not a bound on the document (2026-09-13)
`src/pdf_extract.ts` read its 60-second clock inside `for await (const chunk of page.streamTextContent())`. Every unit test agreed the clock worked, because every fixture produced chunks. A page of pure graphics operators produces none: pdfjs parses the whole content stream, yields nothing, and the loop body — the only place the clock lived — never runs once. The same page also defeats the byte budget and the item count, since both are tallied off chunks too. Measured: a 200-page graphics-only PDF ran 92 seconds unrefused through the shipping binary under a bound advertised as 60.

Audit rule: for any resource bound, name the operation that consumes the resource and check the bound sits on *that*, not on the iteration that consumes the operation's output. Here the fix is `raceDeadline` on each `await` that produces — `reader.read()`, `getTextContent()`, `getPage()`, `getOutline()`, `getMetadata()` — plus an eager `Date.now() > deadline` check before `getPage`, because `raceDeadline` cannot reject on an already-expired deadline (a microtask-resolving work promise always beats the zero-millisecond macrotask timer).

Two more things this class brings with it. Abandoning a pdfjs reader mid-stream deadlocks `loadingTask.destroy()`, so an unbounded teardown `await` converts a bounded refusal into a call that never returns — worse than the original bug, and invisible because the rejection simply never arrives. And a bound is only as good as the count of bound *classes*: text bytes, item count, encoding, clock, and what is retained in the answer (outline entries, locate match context) are five separate ceilings and none substitutes for another. Ask for each which input makes it the binding one; if no input does, it is decoration.

The test that proves this cannot use a producer-driven fixture, and it cannot rest on the work being slower than the budget on the runner that happens to execute it: at 200 pages the margin was under 2x and a quiet machine finished the document, turning the regression test green for the wrong reason. Size the input several times over the budget, or drive the deadline directly.
