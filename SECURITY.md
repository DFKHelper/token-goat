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

`npm audit` reports Token-Goat clean whichever way you scan it, and that has only been true of a default install since `@xenova/transformers` became opt-in. All three numbers below are reproducible with the commands shown.

| What you scan | Command | Result |
| --- | --- | --- |
| this repository | `npm audit` | clean, development dependencies included |
| an install without optional packages | `npm install --omit=optional token-goat` then `npm audit --omit=dev --omit=optional` | clean, 40 packages |
| a default install | `npm install token-goat` then `npm audit --omit=dev` | clean, 106 packages |

The repository carries an `overrides` block in [`package.json`](package.json) that pins five transitive packages to patched versions, and **npm applies `overrides` only in the root project**, so those pins do not travel to anyone who installs Token-Goat as a dependency. That distinction used to matter a great deal, because a clean repository scan was standing in for an install that was not clean. It no longer decides anything: the packages those pins were protecting against are not in a consumer's tree at all now, whether or not the pins travel. The block stays because the development tree still resolves them -- the same packages arrive through devDependencies, which is where the embedding model now lives.

There is no table of reaching advisories here any more, and the last entry in it is worth recording rather than deleting. `@xenova/transformers` was an optional dependency, which in npm means everyone got it unless they asked not to, and it carried [`protobufjs`](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) through `onnx-proto` and `onnxruntime-web` -- one critical advisory and four more -- plus its own nested, older `sharp` carrying [four inherited libvips CVEs](https://github.com/advisories/GHSA-f88m-g3jw-g9cj). None of the six was fixable from here: every one sits in a transitive package with no patched version, and the pins that would have solved it do not travel to consumers.

It is not installed by default now. `semantic` still works without it, because that command always consults keyword search alongside the vectors, so nothing errors and nothing comes back empty; what goes away is the embedding half, and with it the ability to match on meaning rather than words. To get it back:

```bash
npm install -g @xenova/transformers   # drop -g if token-goat is a project dependency
```

Nothing else is needed. The index notices on its own: files skipped while the model was absent are recorded as skipped for that reason specifically, so the next index pass re-embeds them rather than treating them as already done. `token-goat doctor` reports which of the three states you are in -- available, switched off in config, or not installed with the command above -- because a fallback that works silently is exactly the kind of thing nobody discovers on their own.

The same nested `sharp` had already cost something before any of this. It ships its own libvips binaries, and loading the model eagerly put them ahead of Token-Goat's own `sharp` in the Windows DLL search order, which broke image shrinking with `ERR_DLOPEN_FAILED` while `sharp` loaded perfectly well on its own. The workaround, deferring the model load until something actually asks to embed, is still in [`src/embeddings.ts`](src/embeddings.ts) and still worth keeping for the opt-in case.

`npm install --omit=optional` remains available and gives a smaller install still, at 40 packages. Every command starts either way; the ones that need a package you skipped say so. The `xlsx-*`, `docx-*` and `pptx-*` commands report that fflate is not installed rather than failing oddly, and `zip-list`/`zip-read` do the same.

`exceljs` used to appear in that table, carrying [`uuid`](https://github.com/advisories/GHSA-w5hq-g745-h8pq). It is now a development dependency instead. The `xlsx-*` commands read the workbook container directly, the same way the `.docx` and `.pptx` readers already did, so `exceljs` is only a test fixture writer now. That removes 55 packages from a default install, including every deprecated one in the tree.

`fast-xml-parser` has moved the same way, and for a reason worth stating even though it carries no advisory. Its 5.x line splits what used to be one transitive package into six ([`@nodable/entities`](https://www.npmjs.com/package/@nodable/entities), [`fast-xml-builder`](https://www.npmjs.com/package/fast-xml-builder), [`is-unsafe`](https://www.npmjs.com/package/is-unsafe), [`path-expression-matcher`](https://www.npmjs.com/package/path-expression-matcher), [`xml-naming`](https://www.npmjs.com/package/xml-naming) and `strnum`, which itself now pulls [`anynum`](https://www.npmjs.com/package/anynum)). Five new maintainer surfaces arrived inside a version range an existing install accepts on its own, without anyone deciding to take them on, and that is the shape of supply-chain exposure regardless of whether any one of those packages is doing anything wrong today. What we used was one constructor with four options over machine-generated XML, so it is now [`src/xml_parser.ts`](src/xml_parser.ts) instead, with nothing underneath it. That parser reads no DTD and supports no entity declarations at all, so XXE and entity-expansion attacks are closed by construction rather than by a limit. `fast-xml-parser` stays as a development dependency, where a differential test holds the local parser to its exact output.

`@modelcontextprotocol/sdk` has moved to a development dependency as well, and it is the largest single reduction of the three. The SDK is Anthropic-maintained and good at what it does, but it is built to be every MCP participant at once -- client and server, stdio and HTTP and SSE, OAuth, resources, prompts, sampling, tasks -- and it charges every install for all of it. It brought 99 packages, among them two HTTP frameworks ([`express`](https://www.npmjs.com/package/express) and [`hono`](https://www.npmjs.com/package/hono)), [`cors`](https://www.npmjs.com/package/cors), [`body-parser`](https://www.npmjs.com/package/body-parser), [`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit), [`jose`](https://www.npmjs.com/package/jose), [`pkce-challenge`](https://www.npmjs.com/package/pkce-challenge), [`qs`](https://www.npmjs.com/package/qs) and [`path-to-regexp`](https://www.npmjs.com/package/path-to-regexp). Token-goat runs one stdio server that registers tools and answers `tools/call`, so no HTTP transport is reachable from it and none of those packages can execute here; they were install weight and attack surface and nothing else. What token-goat used of the SDK was five calls, and that is now [`src/mcp_jsonrpc.ts`](src/mcp_jsonrpc.ts) and [`src/mcp_stdio.ts`](src/mcp_stdio.ts). The SDK stays as a development dependency, and that is load-bearing rather than incidental: every MCP test in the repository drives our server through the SDK's own client over its own transport, so the reference implementation checks our wire format on every run. A default install drops from 250 packages to 151, and to 106 once the embedding model comes out too.

Every package count on this page is a measurement, not a constant, and it was taken the same way each time: `npm install <the package>` into an empty project, then counting the directories under `node_modules`, the package itself included. They are counts as of 2026-08-22 and they drift upward on their own, because the version ranges a dependency declares resolve to whatever is newest at install time and other people's trees grow. This paragraph said 238 and 87 for a while for exactly that reason: both were true when they were written and neither was true a few releases later. Re-measure before quoting them rather than assuming they still hold. The default figure additionally depends on where you stand: `sharp`, `@napi-rs/canvas` and `sqlite-vec` each publish a prebuilt binary per platform, an install takes only the one that matches, and the rest are skipped, so a default install is a few packages larger on Linux than on Windows or macOS. The 106 above was measured on Windows x64, and it is the largest of the three. The no-optional install has no prebuilt binary in it at all, so 40 is 40 everywhere.

One half of that drift is checked rather than trusted. [`tests/guards/dependency_advisory_disclosure.test.ts`](tests/guards/dependency_advisory_disclosure.test.ts) resolves both installs out of [`package-lock.json`](package-lock.json) the way npm resolves them, platform gating included, and holds this page to the answer: the no-optional figure has to match exactly, and the default figure may not be smaller than the lock file already proves it must be. That catches every package this project adds or removes on its own. It cannot catch the other half, which is other people's trees growing inside ranges an install already accepts, and that is what the date is for.

`html-to-text` used to appear in that table, carrying [`deepmerge-ts`](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). It is now a development dependency instead. esbuild inlines it into `dist/token-goat.mjs` at build time and nothing in the published bundle imports it, so it was a runtime dependency in name only: moving it removes `html-to-text`, `deepmerge-ts`, `htmlparser2`, `selderee`, and `dom-serializer` from an installed copy while the HTML-to-text output stays byte-for-byte identical. That is what takes the no-optional install to zero, and it is better than the alternative we had considered, rolling `html-to-text` back to 9.x: that version pins `htmlparser2` two majors lower, and `htmlparser2` is what parses fetched pages, so it would have traded an advisory in an options merger for an older parser on the one path that handles untrusted input.

Five more packages were in `dependencies` for the same reason and have moved the same way: `commander`, `csv-parse`, `js-yaml`, `smol-toml` and `zod`. esbuild inlines each one into the bundle, and the published bundle resolves none of them, so a consumer was downloading code the artifact already carried. Moving them takes an install without optional packages from 46 packages to 40. `better-sqlite3` and `jsonc-parser` stay, because the bundle really does load them at run time: the first is a native addon, and the second is reached through `createRequire` rather than an import esbuild can inline. `zod` is the largest of the five on disk, and when that move was made it saved least in practice, because `@modelcontextprotocol/sdk` and `puppeteer-core` both depended on it and a default install still got it from them. Neither is true any more: the puppeteer-core major bump dropped its `zod` dependency, and the MCP SDK is a development dependency now for the reason below. A default install carries no copy of `zod` at all.

Direct dependencies with a forward patch are kept current rather than pinned: `sharp` and `puppeteer-core` were both moved across a major version to clear their advisories.

For a scanner that ingests a bill of materials rather than a lockfile, `npm run sbom` writes CycloneDX 1.5 to stdout.

## Verifying what you installed

Every published version is built and pushed by one workflow, [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which runs only when a GitHub release is published (or manually, and then only from `main`). It publishes with npm provenance, so npm holds a signed attestation tying the tarball to the commit and workflow run that produced it. Nothing is ever published from a laptop.

To check a copy you already have:

```
npm audit signatures
```

Run from a project that depends on token-goat, that command verifies the registry signature and the provenance attestation for every installed package, token-goat included. The package page on npm links the attestation to the exact commit, so you can read the source that produced the bytes you are running.

Every action used by that workflow, and by CI, is pinned to a full commit SHA rather than a tag, so a compromised action repository cannot silently change what runs. That is enforced by a test rather than by review: see [tests/guards/workflow_actions_pinned.test.ts](tests/guards/workflow_actions_pinned.test.ts).

## License

Token-Goat is source-available under the PolyForm Noncommercial License 1.0.0. Submitting a security report does not grant the reporter any license to Token-Goat's code beyond what PolyForm Noncommercial already permits. See LICENSE for the full terms.


## Dependency licenses

Every production dependency is permissively licensed, but a scan does not read it that way on its
own. Counted from `package-lock.json`, which lists the packages for every platform rather than only
the ones this machine installed, 21 entries need a human answer: 7 declare a license a scanner
cannot resolve, and 14 carry a copyleft term. All 21 arrive through optional dependencies. Install
with `npm install --omit=optional token-goat` and not one of them is present.

**Declarations a scanner cannot resolve.** One remains, and it is an upstream mistake of the same
kind this project made in its own manifest and fixed: `MIT OR Apache` is not a valid expression,
because the identifier is `Apache-2.0`. `npm sbom` emits no `licenses` field at all for it rather
than an unresolvable one. (`flatbuffers` was listed here too, declaring `SEE LICENSE IN LICENSE.txt`
while actually granting Apache-2.0. It arrived through `@xenova/transformers` and left with it.)

| Package | Declares | Actually grants | Reached through |
| --- | --- | --- | --- |
| `sqlite-vec` and its 5 platform packages | `MIT OR Apache` | MIT or Apache-2.0, your choice | direct optional dependency |

**Copyleft terms.** Two families, and neither puts a copyleft obligation on Token-Goat's own code.

| Package | Declares | Why it is not a problem |
| --- | --- | --- |
| `@img/sharp-libvips-<platform>` (10 packages) | `LGPL-3.0-or-later` | libvips, shipped as a prebuilt shared library and used unmodified. LGPL asks that the library stay replaceable, and it is: it is a separate package that `sharp` loads at runtime. |
| `@img/sharp-<platform>` (4 packages) | `Apache-2.0 AND LGPL-3.0-or-later` | the Apache half is `sharp` itself, the LGPL half is the same libvips |

`sharp` is optional: it powers image shrinking. `jszip` used to be listed here too; it arrived
through `exceljs`, which is no longer a dependency a consumer installs.

**Three packages with no license at all used to be here.** `buffers@0.1.1` and `chainsaw@0.1.0`
shipped with neither a `license` field nor a license file, and `traverse@0.3.9` had the file but
not the field. No grant at all is worse for a review than a copyleft grant, because there is
nothing to apply policy to. They arrived through `exceljs`, which depends on `unzipper`, which
depended on `binary`, which depended on all three. `unzipper` dropped `binary` in 0.11, so an
override to `^0.12.5` removes the sub-chain, and the deprecated `fstream` with it. `exceljs` is now
a development dependency, so none of that chain reaches an installed copy either way; the override
stays because it is what keeps this repository's own `npm audit`, which includes development
dependencies, clean.

Reproduce the whole picture:

```bash
npm run sbom
```

Like the advisory disclosure above, this is checked by a test rather than by review: see
[tests/guards/dependency_licenses.test.ts](tests/guards/dependency_licenses.test.ts). Any
production package that a scanner cannot resolve, or that carries a copyleft term, has to be named
here or that test fails.
