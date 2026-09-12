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
