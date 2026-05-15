# Security Policy

Token-Goat runs on your machine, registers hooks with two AI coding tools, and reads files those tools open. The attack surface is real and the project treats security reports as a priority.

## Reporting a vulnerability

Email token-goat@dfkhelper.com. This is a private inbox, not a public issue tracker. Do not file security reports as GitHub issues; that exposes the finding before a fix ships. PGP key available on request.

A useful report contains:

- Affected Token-Goat version (`token-goat --version`)
- Operating system and Python version
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

## License

Token-Goat is source-available under the PolyForm Noncommercial License 1.0.0. Submitting a security report does not grant the reporter any license to Token-Goat's code beyond what PolyForm Noncommercial already permits. See LICENSE for the full terms.
