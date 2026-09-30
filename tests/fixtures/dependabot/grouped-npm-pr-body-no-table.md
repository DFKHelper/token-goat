Bumps the npm-dependencies group with 2 updates in the / directory: [smol-toml](https://github.com/squirrelchat/smol-toml) and [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint/tree/HEAD/packages/typescript-eslint).

Updates `smol-toml` from 1.8.0 to 1.9.0
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/squirrelchat/smol-toml/releases">smol-toml's releases</a>.</em></p>
<blockquote>
<h2>v1.9.0</h2>
<p><strong>Huge update</strong>!!! This is most likely the largest update the library received since its release, with lots of new features and improvements.</p>
<h3>Performance improvements</h3>
<p>Significant parts of the internal parse logic have been rewritten, improving performance by <strong>1.5x-2x</strong>. The library was already comfortably ahead of the others, but it is now faster than ever, sitting at <strong>4x faster parse performance</strong> than the closest maintained implementation.</p>
<p>Problematic code paths have also been replaced by safer implementations, solving potential DoS vectors. See GHSA-r4xh-jqrq-34v2.</p>
<p>Note: the objects returned by the library now have a <em>null prototype</em>. This is a transparent change for 99.9% of users, and is one of the most significant contributors to the major performance gains in this version.</p>
<h3>Full Temporal support</h3>
<p>Version 1.8.0 brought support for Temporal in <code>stringify</code>; now the library is also able to emit Temporal objects instead of its own ad-hoc <code>TomlDate</code> object. It is not enabled by default, but it will become the default in v2. Enable by setting <code>useLegacyDate: false</code> in the parser's options.</p>
<h4>Better Temporal support in stringify</h4>
<p>Temporal support has been improved since it released: Temporal objects that cannot be represented (such as <code>Temporal.PlainMonthDay</code>) now throw an error (instead of silently emitting a bogus object).</p>
<p>A new option has been added to <code>stringify</code> to disallow Temporal objects that cannot be fully represented in TOML. This includes <code>ZonedDateTime</code> objects with a IANA timezone attached instead of a plain offset, and dates with a specific calendar value set. Enable by setting <code>strictTemporal: true</code> in the options.</p>
<h3>Handling of unsafe keys</h3>
<p>Since its release the library has been protected against prototype pollution attacks, setting properties like <code>__proto__</code> using safe mechanisms that do not trigger prototype pollution. However, while the returned objects are safe on their own, they may become problematic if used carelessly.</p>
<p>Inspired by <code>secure-json-parse</code>, the library now offers a way to either drop unsafe properties from the returned object, or to throw an error and reject documents altogether. By default, these potentially unsafe keys are preserved and returned.</p>
<h3>Miscellaneous updates</h3>
<ul>
<li>Unicode BOM is now gracefully accepted and ignored.</li>
<li>Table array headers are now properly checked again. Reported in <a href="https://redirect.github.com/squirrelchat/smol-toml/issues/65">#65</a>.</li>
<li>Closed certain gaps where invalid whitespace would be accepted. Reported in <a href="https://redirect.github.com/squirrelchat/smol-toml/issues/61">#61</a>.</li>
<li>Bogus local date and local time values with a UTC offset are no longer accepted.</li>
<li>Certain error messages are more accurate and handle errors at line boundaries better.</li>
<li>The default export of the lib is now formally deprecated; use a <code>import *</code> instead. Proposed in <a href="https://redirect.github.com/squirrelchat/smol-toml/issues/50">#50</a>.</li>
<li>On Node 20+, strings that contain lone surrogates are now normalised to well-formed strings.</li>
<li>On Node 20+, keys that contain lone surrogates are now rejected.</li>
</ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/squirrelchat/smol-toml/compare/v1.8.0...v1.9.0">https://github.com/squirrelchat/smol-toml/compare/v1.8.0...v1.9.0</a></p>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/6f9739a5ab481f57c3112024bc4947534b580b58"><code>6f9739a</code></a> fix: gate <code>[is|to]WellFormed</code> (Node 18 compat)</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/a73ca32c7c9237f744c880d900ad15307a0cef56"><code>a73ca32</code></a> fix: no Temporal with toml-test when Node &lt; 26</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/7727890604580bd3fc2d7d2f79ad6e67b745ebe7"><code>7727890</code></a> chore: version bump</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/641903d60d47900080602b6a83e919d2a526547f"><code>641903d</code></a> chore: rewrite README.md</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/2df14c57945fec5a3737bc0cdce06a436bf9a77e"><code>2df14c5</code></a> fix(types): make it work if Temporal doesn't exist</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/3eaa44ef54b859990969935664b12023b26d0eae"><code>3eaa44e</code></a> chore: update benchmark harness</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/cd3ba6021a59bff0ac57dc059ca2e194365caedd"><code>cd3ba60</code></a> feat: safety option for dangerous properties</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/6746a7f3ec066109ef8ba69126489fd84b6d3b73"><code>6746a7f</code></a> perf: refactor TomlDate to avoid regex path</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/16fa64fc5efad895e8657d70e5a1855a16f58ace"><code>16fa64f</code></a> chore: move benchmarks and test harness under 0BSD</li>
<li><a href="https://github.com/squirrelchat/smol-toml/commit/bbd14b154b603068ad25ad54b4a3e7f53adeedc0"><code>bbd14b1</code></a> fix: correct sign for single-char numbers</li>
<li>Additional commits viewable in <a href="https://github.com/squirrelchat/smol-toml/compare/v1.8.0...v1.9.0">compare view</a></li>
</ul>
</details>
<br />

Updates `typescript-eslint` from 8.70.0 to 8.70.1
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/typescript-eslint/typescript-eslint/releases">typescript-eslint's releases</a>.</em></p>
<blockquote>
<h2>v8.70.1</h2>
<h2>8.70.1 (2026-09-21)</h2>
<h3>🩹 Fixes</h3>
<ul>
<li><strong>ast-spec:</strong> narrow import attribute keys to identifiers and strings (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12879">#12879</a>)</li>
<li><strong>eslint-plugin:</strong> [no-useless-default-assignment] avoid false positives on tuples with a rest element (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12768">#12768</a>)</li>
<li><strong>eslint-plugin:</strong> [no-unnecessary-type-parameters] handle type precedence in the suggestion fixer (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12637">#12637</a>)</li>
<li><strong>eslint-plugin:</strong> [no-explicit-any] use unknown[] for bare any rest parameters (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12818">#12818</a>)</li>
<li><strong>eslint-plugin:</strong> [no-generated-empty-object-type] don't report a mapped type whose keys are not resolved yet (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12854">#12854</a>)</li>
<li><strong>eslint-plugin:</strong> [no-misused-spread] omit WeakMap spread suggestions (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12850">#12850</a>)</li>
<li><strong>eslint-plugin:</strong> [no-unnecessary-type-assertion] false positive for empty object asserted to a type alias of Record (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12869">#12869</a>)</li>
<li><strong>eslint-plugin:</strong> [no-meaningless-void-operator] allow void on assignment expressions (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12873">#12873</a>)</li>
<li><strong>eslint-plugin:</strong> [await-thenable] prevent autofix from breaking code when removing <code>await</code> (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12716">#12716</a>)</li>
<li><strong>eslint-plugin:</strong> [no-unnecessary-parameter-property-assignment] account for parameter reassignment (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12880">#12880</a>)</li>
<li><strong>eslint-plugin:</strong> [unbound-method] treat Intl.Collator.prototype.compare as spec-bound (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12845">#12845</a>)</li>
<li><strong>eslint-plugin:</strong> [no-unnecessary-condition] handle union-keyed index access on the left-hand side of nullish assignment (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12747">#12747</a>)</li>
<li><strong>eslint-plugin:</strong> [no-useless-default-assignment] convert the fixer to a suggestion fixer (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12826">#12826</a>)</li>
<li><strong>eslint-plugin:</strong> [no-misused-promises] handle multiple Promise constituents (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12904">#12904</a>)</li>
<li><strong>rule-tester:</strong> test the final autofix output instead of the first pass (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12867">#12867</a>)</li>
<li><strong>scope-manager:</strong> merge implicit global definitions (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12809">#12809</a>)</li>
<li><strong>type-utils:</strong> match package specifiers on whole path components (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12838">#12838</a>)</li>
<li><strong>typescript-estree:</strong> resolve symlinked paths when matching files to projects (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12725">#12725</a>)</li>
<li><strong>typescript-estree:</strong> add missing <code>&lt;</code> token opening type arguments (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12821">#12821</a>)</li>
<li><strong>typescript-estree:</strong> require string literal import attribute values (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12894">#12894</a>)</li>
<li><strong>website:</strong> prevent playground from breaking down after opening link with the .js file type (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12777">#12777</a>)</li>
</ul>
<h3>❤️ Thank You</h3>
<ul>
<li>Amin <a href="https://github.com/amiin-dev"><code>@​amiin-dev</code></a></li>
<li>Brad Zacher <a href="https://github.com/bradzacher"><code>@​bradzacher</code></a></li>
<li>Cameron</li>
<li>Diptajoy Mistry <a href="https://github.com/diptomistry"><code>@​diptomistry</code></a></li>
<li>Evyatar Daud <a href="https://github.com/StyleShit"><code>@​StyleShit</code></a></li>
<li>Grit <a href="https://github.com/Grit03"><code>@​Grit03</code></a></li>
<li>Hugo <a href="https://github.com/hugop95"><code>@​hugop95</code></a></li>
<li>Josh Goldberg ✨</li>
<li>Michael Naumov <a href="https://github.com/mnaoumov"><code>@​mnaoumov</code></a></li>
<li>Mikhail Baev <a href="https://github.com/baevm"><code>@​baevm</code></a></li>
<li>Om Rawat</li>
<li>overlookmotel</li>
<li>Sanath <a href="https://github.com/sansynx"><code>@​sansynx</code></a></li>
<li>Shinji</li>
<li>stoicism <a href="https://github.com/stoicism02"><code>@​stoicism02</code></a></li>
<li>Vinccool96</li>
<li>Younsang Na <a href="https://github.com/nayounsang"><code>@​nayounsang</code></a></li>
<li>김채영 <a href="https://github.com/cchaeyoung"><code>@​cchaeyoung</code></a></li>
<li>송재욱</li>
</ul>
<p>See <a href="https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.70.1">GitHub Releases</a> for more information.</p>
<!-- raw HTML omitted -->
</blockquote>
<p>... (truncated)</p>
</details>
<details>
<summary>Changelog</summary>
<p><em>Sourced from <a href="https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/typescript-eslint/CHANGELOG.md">typescript-eslint's changelog</a>.</em></p>
<blockquote>
<h2>8.70.1 (2026-09-21)</h2>
<p>This was a version bump only for typescript-eslint to align it with other projects, there were no code changes.</p>
<p>See <a href="https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.70.1">GitHub Releases</a> for more information.</p>
<p>You can read about our <a href="https://typescript-eslint.io/users/versioning">versioning strategy</a> and <a href="https://typescript-eslint.io/users/releases">releases</a> on our website.</p>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/typescript-eslint/typescript-eslint/commit/23d38ceeb8fb1237f55cb62fc2b54419e1fa1ed7"><code>23d38ce</code></a> chore(release): publish 8.70.1</li>
<li><a href="https://github.com/typescript-eslint/typescript-eslint/commit/eb42d9b7e7ab0eca543bc16b726688624c532fc6"><code>eb42d9b</code></a> chore: cleanup and fix Nx dependencies and missing tasks (<a href="https://github.com/typescript-eslint/typescript-eslint/tree/HEAD/packages/typescript-eslint/issues/12897">#12897</a>)</li>
<li><a href="https://github.com/typescript-eslint/typescript-eslint/commit/8c8053103f4ab8df3105826181c43fa257289a73"><code>8c80531</code></a> chore: fix typos in comments and docs (<a href="https://github.com/typescript-eslint/typescript-eslint/tree/HEAD/packages/typescript-eslint/issues/12846">#12846</a>)</li>
<li><a href="https://github.com/typescript-eslint/typescript-eslint/commit/b6b86a15dd42aaa0e37054683cb5606c8fd203c2"><code>b6b86a1</code></a> chore: migrate to nx 23.2.0 (<a href="https://github.com/typescript-eslint/typescript-eslint/tree/HEAD/packages/typescript-eslint/issues/12843">#12843</a>)</li>
<li>See full diff in <a href="https://github.com/typescript-eslint/typescript-eslint/commits/v8.70.1/packages/typescript-eslint">compare view</a></li>
</ul>
</details>
<br />


Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself. You can also trigger a rebase manually by commenting `@dependabot rebase`.

[//]: # (dependabot-automerge-start)
[//]: # (dependabot-automerge-end)

---

<details>
<summary>Dependabot commands and options</summary>
<br />

You can trigger Dependabot actions by commenting on this PR:
- `@dependabot rebase` will rebase this PR
- `@dependabot recreate` will recreate this PR, overwriting any edits that have been made to it
- `@dependabot show <dependency name> ignore conditions` will show all of the ignore conditions of the specified dependency
- `@dependabot ignore <dependency name> major version` will close this group update PR and stop Dependabot creating any more for the specific dependency's major version (unless you unignore this specific dependency's major version or upgrade to it yourself)
- `@dependabot ignore <dependency name> minor version` will close this group update PR and stop Dependabot creating any more for the specific dependency's minor version (unless you unignore this specific dependency's minor version or upgrade to it yourself)
- `@dependabot ignore <dependency name>` will close this group update PR and stop Dependabot creating any more for the specific dependency (unless you unignore this specific dependency or upgrade to it yourself)
- `@dependabot unignore <dependency name>` will remove all of the ignore conditions of the specified dependency
- `@dependabot unignore <dependency name> <ignore condition>` will remove the ignore condition of the specified dependency and ignore conditions


</details>
