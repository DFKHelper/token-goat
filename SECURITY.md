# Security Policy

Token-Goat runs on your machine, registers hooks with two AI coding tools, and reads files those tools open. The attack surface is real and the project treats security reports as a priority.

## Reporting a vulnerability

Email token-goat@dfkhelper.com. This is a private inbox, not a public issue tracker. Do not file security reports as GitHub issues; that exposes the finding before a fix ships. PGP key available on request.

A useful report contains:

- Affected Token-Goat version (`token-goat --version`)
- Operating system and Node version (`node --version`)
- Reproduction steps, ideally a minimal command sequence
- Observed impact and a short severity assessment
- Suggested fix, if known

## What to expect

Reports are acknowledged within 7 calendar days of receipt. If you have not heard back in that window, resend; mail does get lost. After triage, a target fix window is set based on severity and communicated back. Coordinated disclosure is preferred, with a typical 90-day window before public details. Reporters who want public credit are credited in the changelog and the release notes. Reporters who prefer to stay anonymous are kept anonymous.

## In scope

The following are treated as security issues:

- Privilege escalation through Token-Goat's installer, worker, or hooks
- Remote code execution via hook payloads, CLI arguments, or cached content
- Data exfiltration through Token-Goat's database, cache, or session store
- Injection vulnerabilities in any user-facing command or hook input path
- Supply-chain concerns affecting the published `token-goat` package
- Authentication or authorization flaws in token-bearing integrations

## Out of scope

The following are not treated as security issues unless paired with a working proof of concept showing actual impact:

- Theoretical vulnerabilities without a reproducer
- Issues in upstream dependencies that do not manifest through Token-Goat's surface
- Local denial of service via resource exhaustion (memory, disk, CPU) on the user's own machine
- Social-engineering attacks that require tricking the user into running malicious commands
- Issues that require an already-compromised local user account

## Dependency advisories

`npm audit --omit=dev` on the published package is not empty, and pretending otherwise would waste your review time. Every runtime advisory that remains traces to one of three packages. All three are already at their latest published version, so there is no forward patch to take: the only version npm offers as a "fix" is an older major that drops features Token-Goat uses.

| Package | Advisories it carries | Where it loads | Why the advisory does not reach you through Token-Goat |
| --- | --- | --- | --- |
| `@xenova/transformers` | [`protobufjs`](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) (critical), `onnx-proto`, `onnxruntime-web`, and its own pinned `sharp` | optional; loaded only when semantic search builds or queries embeddings | not mitigated, so it is the one to weigh. Skip it with `npm install --omit=optional`, or leave `indexing.embeddings_enabled` off, and the code never loads |
| `exceljs` | [`uuid`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | optional; loaded only when an `xlsx-*` command opens a workbook | the advisory is a missing bounds check on a caller-supplied `buf` argument; ExcelJS never passes one |
| `html-to-text` | [`deepmerge-ts`](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) | required, and bundled into `dist/token-goat.mjs`; runs when a fetched page is converted to text | the advisory is stack exhaustion while merging a recursive object graph. The only object merged is the fixed options literal in `extractCleanText`; page content is never merged |

`npm install --omit=optional` gives you an install without the first two, and the commands that need them say so rather than failing oddly.

Direct dependencies with a forward patch are kept current rather than pinned: `sharp` and `puppeteer-core` were both moved across a major version to clear their advisories.

## License

Token-Goat is source-available under the PolyForm Noncommercial License 1.0.0. Submitting a security report does not grant the reporter any license to Token-Goat's code beyond what PolyForm Noncommercial already permits. See LICENSE for the full terms.
