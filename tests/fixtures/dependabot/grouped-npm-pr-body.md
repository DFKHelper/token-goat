Bumps the npm-dependencies group with 7 updates in the / directory:

| Package | From | To |
| --- | --- | --- |
| [@types/jpeg-js](https://github.com/eugeneware/jpeg-js) | `0.3.0` | `0.3.7` |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) | `26.4.0` | `26.4.1` |
| [lefthook](https://github.com/evilmartians/lefthook) | `2.1.10` | `2.1.12` |
| [tsx](https://github.com/privatenumber/tsx) | `4.23.12` | `4.23.13` |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint/tree/HEAD/packages/typescript-eslint) | `8.68.0` | `8.69.0` |
| [zod](https://github.com/colinhacks/zod) | `4.4.3` | `4.5.4` |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | `6.2.108` | `6.3.289` |


Updates `@types/jpeg-js` from 0.3.0 to 0.3.7
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/eugeneware/jpeg-js/releases">@​types/jpeg-js's releases</a>.</em></p>
<blockquote>
<h2>v0.3.3</h2>
<p>0.3.3</p>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/6241ba46a3df66a97d209948749ce508586c3eed"><code>6241ba4</code></a> chore: bump to 0.3.7</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/7f96707f68f5e6ec26a996a88de8981bcca2b1aa"><code>7f96707</code></a> docs: add writeFileSync example to README.md (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/65">#65</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/4495701bfd462598a027671521bf95115d427574"><code>4495701</code></a> fix: don’t force a color transform by default for CMYK images (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/64">#64</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/275c852ceabf68140ea7c0c3eae889f4eeddb55f"><code>275c852</code></a> fix: more descriptive error for exceeding maxLength buffer (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/62">#62</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/d00366ab6ae586cc57f8e639f0d3b71c597738e7"><code>d00366a</code></a> feat: add option to decode to RGB instead of RGBA (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/49">#49</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/d340c1b2113328bdea955706e7c5f0bf0cad143b"><code>d340c1b</code></a> fix: throw better error if Huffman Table can't be created (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/60">#60</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/6bc12b0753aea139f5e739b37842bac58762c16a"><code>6bc12b0</code></a> feat: encoder.js no longer needs module.exports (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/36">#36</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/2ce6a5efb3f13c45f3a1fd16e9ddc102db1412ac"><code>2ce6a5e</code></a> 0.3.6</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/20d2f246b343d8e8ba7aa0475ec917219ca45039"><code>20d2f24</code></a> misc: added TypeScript types (<a href="https://redirect.github.com/eugeneware/jpeg-js/issues/52">#52</a>)</li>
<li><a href="https://github.com/jpeg-js/jpeg-js/commit/82e8ef27e3f2754e5bc9707b691617a8715fe4f1"><code>82e8ef2</code></a> 0.3.5</li>
<li>Additional commits viewable in <a href="https://github.com/eugeneware/jpeg-js/compare/v0.3.0...v0.3.7">compare view</a></li>
</ul>
</details>
<br />

Updates `@types/node` from 26.4.0 to 26.4.1
<details>
<summary>Commits</summary>
<ul>
<li>See full diff in <a href="https://github.com/DefinitelyTyped/DefinitelyTyped/commits/HEAD/types/node">compare view</a></li>
</ul>
</details>
<br />

Updates `lefthook` from 2.1.10 to 2.1.12
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/evilmartians/lefthook/releases">lefthook's releases</a>.</em></p>
<blockquote>
<h2>v2.1.12</h2>
<h2>Changelog</h2>
<ul>
<li>b8350fde604197b2422adfc4ae0af080725822b9 ci: fix npm publishing by bumping Node to 24 (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1508">#1508</a>)</li>
<li>9fb290d786a0e122fe113b1b49a45bbd0ffa7d28 fix: LEFTHOOK_OUTPUT precedence (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1506">#1506</a>)</li>
<li>2f0a9f37cef73e10d95043ba3754329a21850d57 fix: fail the hook when staging fixed files errors (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1484">#1484</a>)</li>
</ul>
<h2>v2.1.11</h2>
<h2>Changelog</h2>
<ul>
<li>e5b10ac3a2645784ee2e4260620c49c31b44992a deps: bump Go to 1.26.6 (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1495">#1495</a>)</li>
<li>d4a259f460b7c1d8c512dd75eedc7068310ee961 fix: inherit terminal size for PTY commands (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1498">#1498</a>)</li>
</ul>
</blockquote>
</details>
<details>
<summary>Changelog</summary>
<p><em>Sourced from <a href="https://github.com/evilmartians/lefthook/blob/master/CHANGELOG.md">lefthook's changelog</a>.</em></p>
<blockquote>
<h2>2.1.12 (2026-08-28)</h2>
<ul>
<li>fix: fail the hook when staging fixed files errors (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1484">#1484</a>) by <a href="https://github.com/teddytennant"><code>@​teddytennant</code></a></li>
<li>fix: LEFTHOOK_OUTPUT precedence (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1506">#1506</a>) by <a href="https://github.com/Yuki9814"><code>@​Yuki9814</code></a></li>
<li>ci: fix npm publishing by bumping Node to 24 (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1508">#1508</a>) by <a href="https://github.com/mariokresic"><code>@​mariokresic</code></a></li>
</ul>
<h2>2.1.11 (2026-08-21)</h2>
<ul>
<li>fix: inherit terminal size for PTY commands (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1498">#1498</a>) by <a href="https://github.com/mariokresic"><code>@​mariokresic</code></a></li>
<li>docs: correct Lefthook commit message configuration (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1499">#1499</a>) by <a href="https://github.com/codersjj"><code>@​codersjj</code></a></li>
<li>docs: hide contributors regenerate tip from the site (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1500">#1500</a>) by <a href="https://github.com/MikevPeeren"><code>@​MikevPeeren</code></a></li>
<li>docs: clarify signed-off commit example (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1492">#1492</a>) by <a href="https://github.com/nightcityblade"><code>@​nightcityblade</code></a></li>
<li>deps: bump Go to 1.26.6 (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1495">#1495</a>) by <a href="https://github.com/quaacxlok"><code>@​quaacxlok</code></a></li>
<li>docs: fix em notice by <a href="https://github.com/mrexox"><code>@​mrexox</code></a></li>
<li>docs: update docmd (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1481">#1481</a>) by <a href="https://github.com/mrexox"><code>@​mrexox</code></a></li>
<li>docs: fix EM mention HTML by <a href="https://github.com/mrexox"><code>@​mrexox</code></a></li>
<li>docs: clarify remote script folders (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1477">#1477</a>) by <a href="https://github.com/scop"><code>@​scop</code></a></li>
<li>docs: document script args (<a href="https://redirect.github.com/evilmartians/lefthook/pull/1479">#1479</a>) by <a href="https://github.com/lntutor"><code>@​lntutor</code></a></li>
<li>docs: update em logo by <a href="https://github.com/mrexox"><code>@​mrexox</code></a></li>
</ul>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/evilmartians/lefthook/commit/4ad40c3a28bd2acabbb50eb3ff63b08c2c55f96c"><code>4ad40c3</code></a> 2.1.12: fix LEFTHOOK_OUTPUT env precedence</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/2f0a9f37cef73e10d95043ba3754329a21850d57"><code>2f0a9f3</code></a> fix: fail the hook when staging fixed files errors (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1484">#1484</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/9fb290d786a0e122fe113b1b49a45bbd0ffa7d28"><code>9fb290d</code></a> fix: LEFTHOOK_OUTPUT precedence (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1506">#1506</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/b8350fde604197b2422adfc4ae0af080725822b9"><code>b8350fd</code></a> ci: fix npm publishing by bumping Node to 24 (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1508">#1508</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/c1456461bd5321d45730e23e5b15bb928e3f8141"><code>c145646</code></a> 2.1.11: pty terminal size fix</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/d4a259f460b7c1d8c512dd75eedc7068310ee961"><code>d4a259f</code></a> fix: inherit terminal size for PTY commands (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1498">#1498</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/db7ca05f2c39b6dc6522d91cf44c83ec9b4c1e82"><code>db7ca05</code></a> docs: correct Lefthook commit message configuration (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1499">#1499</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/fd88b1060d06ed7dd53d73b8580a7a458f6f4fbe"><code>fd88b10</code></a> docs: hide contributors regenerate tip from the site (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1500">#1500</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/7ccb1d800c5bf3b58a9ca9cd596ce3a2cd40cedc"><code>7ccb1d8</code></a> docs: clarify signed-off commit example (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1492">#1492</a>)</li>
<li><a href="https://github.com/evilmartians/lefthook/commit/e5b10ac3a2645784ee2e4260620c49c31b44992a"><code>e5b10ac</code></a> deps: bump Go to 1.26.6 (<a href="https://redirect.github.com/evilmartians/lefthook/issues/1495">#1495</a>)</li>
<li>Additional commits viewable in <a href="https://github.com/evilmartians/lefthook/compare/v2.1.10...v2.1.12">compare view</a></li>
</ul>
</details>
<br />

Updates `tsx` from 4.23.12 to 4.23.13
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/privatenumber/tsx/releases">tsx's releases</a>.</em></p>
<blockquote>
<h2>v4.23.13</h2>
<h2><a href="https://github.com/privatenumber/tsx/compare/v4.23.12...v4.23.13">4.23.13</a> (2026-08-30)</h2>
<h3>Bug Fixes</h3>
<ul>
<li><strong>cache:</strong> bound shared transform cache memory (<a href="https://redirect.github.com/privatenumber/tsx/issues/835">#835</a>) (<a href="https://github.com/privatenumber/tsx/commit/28e1f12d04cd2afe1db17f8555b14fe5fb567c6e">28e1f12</a>)</li>
</ul>
<hr />
<p>This release is also available on:</p>
<ul>
<li><a href="https://www.npmjs.com/package/tsx/v/4.23.13"><code>npm package (@​latest dist-tag)</code></a></li>
</ul>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/privatenumber/tsx/commit/28e1f12d04cd2afe1db17f8555b14fe5fb567c6e"><code>28e1f12</code></a> fix(cache): bound shared transform cache memory (<a href="https://redirect.github.com/privatenumber/tsx/issues/835">#835</a>)</li>
<li>See full diff in <a href="https://github.com/privatenumber/tsx/compare/v4.23.12...v4.23.13">compare view</a></li>
</ul>
</details>
<br />

Updates `typescript-eslint` from 8.68.0 to 8.69.0
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/typescript-eslint/typescript-eslint/releases">typescript-eslint's releases</a>.</em></p>
<blockquote>
<h2>v8.69.0</h2>
<h2>8.69.0 (2026-08-31)</h2>
<h3>🚀 Features</h3>
<ul>
<li><strong>eslint-plugin:</strong> [no-misused-promises] add flagUnions option for checkConditionals (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12603">#12603</a>)</li>
</ul>
<h3>🩹 Fixes</h3>
<ul>
<li><strong>eslint-plugin:</strong> [no-mixed-enums] use scope analysis instead of type checking for merged namespaces (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12731">#12731</a>)</li>
<li><strong>eslint-plugin:</strong> [unified-signatures] compare type parameters by constraint instead of name (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12741">#12741</a>)</li>
<li><strong>eslint-plugin:</strong> [no-meaningless-void-operator] report void on non-call expressions (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12727">#12727</a>)</li>
<li><strong>website:</strong> respect allowJs playground config (<a href="https://redirect.github.com/typescript-eslint/typescript-eslint/pull/12744">#12744</a>)</li>
</ul>
<h3>❤️ Thank You</h3>
<ul>
<li>Abdu Alim Arlikhozhaev <a href="https://github.com/Arlikhozhaev"><code>@​Arlikhozhaev</code></a></li>
<li>Evyatar Daud <a href="https://github.com/StyleShit"><code>@​StyleShit</code></a></li>
<li>Josh Goldberg ✨</li>
<li>wonbeanie <a href="https://github.com/wonbeanie"><code>@​wonbeanie</code></a></li>
<li>Younsang Na <a href="https://github.com/nayounsang"><code>@​nayounsang</code></a></li>
</ul>
<p>See <a href="https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.69.0">GitHub Releases</a> for more information.</p>
<p>You can read about our <a href="https://typescript-eslint.io/users/versioning">versioning strategy</a> and <a href="https://typescript-eslint.io/users/releases">releases</a> on our website.</p>
</blockquote>
</details>
<details>
<summary>Changelog</summary>
<p><em>Sourced from <a href="https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/typescript-eslint/CHANGELOG.md">typescript-eslint's changelog</a>.</em></p>
<blockquote>
<h2>8.69.0 (2026-08-31)</h2>
<p>This was a version bump only for typescript-eslint to align it with other projects, there were no code changes.</p>
<p>See <a href="https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.69.0">GitHub Releases</a> for more information.</p>
<p>You can read about our <a href="https://typescript-eslint.io/users/versioning">versioning strategy</a> and <a href="https://typescript-eslint.io/users/releases">releases</a> on our website.</p>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/typescript-eslint/typescript-eslint/commit/9a6e546823e5d8f2dc015df2aa66c0230615e209"><code>9a6e546</code></a> chore(release): publish 8.69.0</li>
<li>See full diff in <a href="https://github.com/typescript-eslint/typescript-eslint/commits/v8.69.0/packages/typescript-eslint">compare view</a></li>
</ul>
</details>
<br />

Updates `zod` from 4.4.3 to 4.5.4
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/colinhacks/zod/releases">zod's releases</a>.</em></p>
<blockquote>
<h2>v4.5.4</h2>
<h2>Commits:</h2>
<ul>
<li>84e416fbf4740527bbc8f319634f4e1b065bb42c fix(v4): stop the cycle walk from firing a default factory (<a href="https://redirect.github.com/colinhacks/zod/issues/6500">#6500</a>)</li>
<li>e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653 4.5.4</li>
</ul>
<h2>v4.5.3</h2>
<h2>Commits:</h2>
<ul>
<li>e6b6ab347675cd2bd54b1bdbed16f98c59be82a9 docs(blog): widen the z.compile example to a 20-property schema</li>
<li>87d6464418582bb96fc665a01f852ca6da324ad0 fix(docs): drop the OG description when the title wraps past two lines</li>
<li>99fce394a026823e602b9c30d8d5d9f5f1932ce7 bench(v4): z.compile() against zod-compiler (<a href="https://redirect.github.com/colinhacks/zod/issues/6499">#6499</a>)</li>
<li>e3a695b6bf3f0d591ea682816e3cdaea04b0f967 docs(v4): record the email regex and container output-shape findings under Open</li>
<li>7e24a24288183ce02554f1ded7775d0650a7b7e6 docs(blog): drop the reading time and put a GitHub link in the navbar</li>
<li>eab51ff3592b2d11d863f4ee4d5452f31a3de1b6 fix(v4): emit record numeric keys as strings in toJSONSchema (<a href="https://redirect.github.com/colinhacks/zod/issues/6497">#6497</a>)</li>
</ul>
<h2>v4.5.2</h2>
<h2>Commits:</h2>
<ul>
<li>a354314ac04fdd5484aa62dd5c3a4b553211a0e4 fix(docs): keep blog posts out of the docs collection (<a href="https://redirect.github.com/colinhacks/zod/issues/6484">#6484</a>)</li>
<li>d378c42aff6869f0929058a7923cd775880f5c4c ci: drop canary publishing from the release workflow (<a href="https://redirect.github.com/colinhacks/zod/issues/6487">#6487</a>)</li>
<li>212b941791e7faae078e17645eb612824fd8f79a fix(v4): let a prototype method getter answer a bare call so vi.spyOn works (<a href="https://redirect.github.com/colinhacks/zod/issues/6488">#6488</a>)</li>
<li>e7576f542a7bc7ef3cc5eeec237714fd0e6b6e98 docs(blog): let the page show through the navbar in dark mode (<a href="https://redirect.github.com/colinhacks/zod/issues/6489">#6489</a>)</li>
<li>fedb06fafe33a66ce0b5c236ad2557e0a5a170fe fix(docs): match the blog TOC hover bar to the 2px active indicator</li>
<li>6c932fcb2eea6eb671710ea058ca9fdc382ada89 chore: bump devcontainer image to Node 24 (<a href="https://redirect.github.com/colinhacks/zod/issues/6470">#6470</a>)</li>
<li>6635d9dd367a664109de83c021995821f48efa29 docs(blog): soften the &quot;method memoization&quot; attribution</li>
<li>019ae299cc75daa132bf1acf59086a520abf6b85 fix(docs): drop ISR on the docs route so the home page hydrates</li>
<li>652bb438aa4c626c1cd7948c6849c4691239fca7 chore(docs): drop the scroll log from the route-change scroller</li>
<li>571c8e8a3d73b4305f4abfdd6977773cc12f2bf5 fix(docs): render blog tabs with the stock fumadocs tab card</li>
<li>9a193aa24b4efa3b315b91d4c56c8bc385b8513f 4.5.2</li>
</ul>
<h2>v4.5.1</h2>
<h2>Commits:</h2>
<ul>
<li>2e862dbf89da2835e5206a8fd3d3be61afe3cf7f ci: gate the GitHub release and JSR publish on the version being live on npm</li>
<li>8e03380510db36fa6fda979fc78a375fdea8021c 4.5.1</li>
</ul>
<h2>v4.5.0</h2>
<p>Zod 4.5 is now available.</p>
<pre lang="sh"><code>npm install zod@latest
</code></pre>
<p>At a glance:</p>
<ul>
<li><a href="https://github.com/colinhacks/zod/blob/HEAD%5Bhttps://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADmhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD%5Dhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADmhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD">https://github.com/colinhacks/zod/blob/HEAD[https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADmhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD]https://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADmhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD</a> — the flagship feature of Zod 4.5</li>
<li><a href="https://github.com/colinhacks/zod/blob/HEAD%5Bhttps://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADChttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD%5Dhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD">https://github.com/colinhacks/zod/blob/HEAD[https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADChttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD]https://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD</a> — 12–19 digits plus Luhn checksum</li>
<li><a href="https://github.com/colinhacks/zod/blob/HEAD%5Bhttps://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADshttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD%5Dhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADshttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD">https://github.com/colinhacks/zod/blob/HEAD[https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADshttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD]https://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADohttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADshttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD</a> — the multi-property counterpart to <code>z.property()</code></li>
<li><a href="https://github.com/colinhacks/zod/blob/HEAD%5Bhttps://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADPhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD%5Dhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD/https://github.com/colinhacks/zod/blob/HEAD%5Bhttps://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADxhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADPhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD%60https://github.com/colinhacks/zod/blob/HEAD%5Dhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADxhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD">https://github.com/colinhacks/zod/blob/HEAD[https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADPhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD]https://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADzhttps://github.com/colinhacks/zod/blob/HEADdhttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD/https://github.com/colinhacks/zod/blob/HEAD[https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD.https://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADxhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADPhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD`https://github.com/colinhacks/zod/blob/HEAD]https://github.com/colinhacks/zod/blob/HEAD(https://github.com/colinhacks/zod/blob/HEAD#https://github.com/colinhacks/zod/blob/HEADehttps://github.com/colinhacks/zod/blob/HEADxhttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADchttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADphttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADrhttps://github.com/colinhacks/zod/blob/HEADthttps://github.com/colinhacks/zod/blob/HEADihttps://github.com/colinhacks/zod/blob/HEADahttps://github.com/colinhacks/zod/blob/HEADlhttps://github.com/colinhacks/zod/blob/HEAD)https://github.com/colinhacks/zod/blob/HEAD</a></li>
</ul>
<!-- raw HTML omitted -->
</blockquote>
<p>... (truncated)</p>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/colinhacks/zod/commit/e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653"><code>e8e206f</code></a> 4.5.4</li>
<li><a href="https://github.com/colinhacks/zod/commit/84e416fbf4740527bbc8f319634f4e1b065bb42c"><code>84e416f</code></a> fix(v4): stop the cycle walk from firing a default factory (<a href="https://redirect.github.com/colinhacks/zod/issues/6500">#6500</a>)</li>
<li><a href="https://github.com/colinhacks/zod/commit/1a16102a494b03ce1df7b80b663ae2df465f419e"><code>1a16102</code></a> 4.5.3</li>
<li><a href="https://github.com/colinhacks/zod/commit/eab51ff3592b2d11d863f4ee4d5452f31a3de1b6"><code>eab51ff</code></a> fix(v4): emit record numeric keys as strings in toJSONSchema (<a href="https://redirect.github.com/colinhacks/zod/issues/6497">#6497</a>)</li>
<li><a href="https://github.com/colinhacks/zod/commit/7e24a24288183ce02554f1ded7775d0650a7b7e6"><code>7e24a24</code></a> docs(blog): drop the reading time and put a GitHub link in the navbar</li>
<li><a href="https://github.com/colinhacks/zod/commit/e3a695b6bf3f0d591ea682816e3cdaea04b0f967"><code>e3a695b</code></a> docs(v4): record the email regex and container output-shape findings under Open</li>
<li><a href="https://github.com/colinhacks/zod/commit/99fce394a026823e602b9c30d8d5d9f5f1932ce7"><code>99fce39</code></a> bench(v4): z.compile() against zod-compiler (<a href="https://redirect.github.com/colinhacks/zod/issues/6499">#6499</a>)</li>
<li><a href="https://github.com/colinhacks/zod/commit/87d6464418582bb96fc665a01f852ca6da324ad0"><code>87d6464</code></a> fix(docs): drop the OG description when the title wraps past two lines</li>
<li><a href="https://github.com/colinhacks/zod/commit/e6b6ab347675cd2bd54b1bdbed16f98c59be82a9"><code>e6b6ab3</code></a> docs(blog): widen the z.compile example to a 20-property schema</li>
<li><a href="https://github.com/colinhacks/zod/commit/9a193aa24b4efa3b315b91d4c56c8bc385b8513f"><code>9a193aa</code></a> 4.5.2</li>
<li>Additional commits viewable in <a href="https://github.com/colinhacks/zod/compare/v4.4.3...v4.5.4">compare view</a></li>
</ul>
</details>
<br />

Updates `pdfjs-dist` from 6.2.108 to 6.3.289
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/mozilla/pdf.js/releases">pdfjs-dist's releases</a>.</em></p>
<blockquote>
<h2>v6.3.289</h2>
<p>This release contains improvements for accessibility, annotation editing, annotation rendering, font conversion, image decoding, performance, text selection and the viewer.</p>
<h2>Changes since v6.2.108</h2>
<ul>
<li>Bump the stable version in <code>pdfjs.config</code> by <a href="https://github.com/timvandermeij"><code>@​timvandermeij</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21655">mozilla/pdf.js#21655</a></li>
<li>[Editor] Restore pinch-to-resize on an editor which came back from an undo by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21644">mozilla/pdf.js#21644</a></li>
<li>Use more more optional chaining in the <code>src/</code> folder by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21661">mozilla/pdf.js#21661</a></li>
<li>Avoid duplicate shared object clones by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21658">mozilla/pdf.js#21658</a></li>
<li>Avoid mutating source widget parents by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21660">mozilla/pdf.js#21660</a></li>
<li>Fix the selection rendering when a page has been destroyed and rendered again (bug 2054348) by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21666">mozilla/pdf.js#21666</a></li>
<li>l10n: Update locale files by <a href="https://github.com/sync-l10n-for-pdf-js"><code>@​sync-l10n-for-pdf-js</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21669">mozilla/pdf.js#21669</a></li>
<li>Sync the viewer chrome with the Firefox design system by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21665">mozilla/pdf.js#21665</a></li>
<li>[api-minor] Convert <code>getJSActions</code> to return data in a Map by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21664">mozilla/pdf.js#21664</a></li>
<li>Use the client coordinates for the pinch-zoom origin by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21659">mozilla/pdf.js#21659</a></li>
<li>Re-factor the <code>EventBus</code> to use Map/Set internally by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21673">mozilla/pdf.js#21673</a></li>
<li>Replace simple return <code>if</code> statements with ternary operators by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21672">mozilla/pdf.js#21672</a></li>
<li>Let pointerup/cancel propagate in TouchManager by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21674">mozilla/pdf.js#21674</a></li>
<li>Shorten the <code>ViewHistory</code> class a little bit by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21678">mozilla/pdf.js#21678</a></li>
<li>Don't throw on an invalid XML character reference by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21682">mozilla/pdf.js#21682</a></li>
<li>Fix the regex used to normalize css fonts in XFA by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21680">mozilla/pdf.js#21680</a></li>
<li>Trim the response headers with a backward scan by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21684">mozilla/pdf.js#21684</a></li>
<li>Find the PDF filename in a URL hash in two linear steps by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21685">mozilla/pdf.js#21685</a></li>
<li>Scan backwards to delete a word in a text field by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21687">mozilla/pdf.js#21687</a></li>
<li>Add scripts correctly in <code>Field.prototype.setAction</code> (PR 12569 follow-up) by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21691">mozilla/pdf.js#21691</a></li>
<li>Update dependencies to the most recent versions by <a href="https://github.com/timvandermeij"><code>@​timvandermeij</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21689">mozilla/pdf.js#21689</a></li>
<li>Exclude &quot;&amp;&quot; from the XML entity names by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21692">mozilla/pdf.js#21692</a></li>
<li>[api-minor] Convert <code>getFieldObjects</code> to return data in a Map by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21671">mozilla/pdf.js#21671</a></li>
<li>Anchor the regex used to extract the XFA path positions by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21686">mozilla/pdf.js#21686</a></li>
<li>Don't write numbers in exponential notation when saving a pdf by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21683">mozilla/pdf.js#21683</a></li>
<li>Bound the email parts in the autolinker regex by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21693">mozilla/pdf.js#21693</a></li>
<li>Safely serialize CSS font family names by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21694">mozilla/pdf.js#21694</a></li>
<li>Add a go to first/last menu-item helper method in the <code>Menu</code> class by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21690">mozilla/pdf.js#21690</a></li>
<li>Document how to use the viewer to open files by <a href="https://github.com/martinthomson"><code>@​martinthomson</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21695">mozilla/pdf.js#21695</a></li>
<li>Add integration tests for the Home/End keys in the <code>Menu</code> class by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21706">mozilla/pdf.js#21706</a></li>
<li>Bump undici from 7.28.0 to 7.29.0 by <a href="https://github.com/dependabot"><code>@​dependabot</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21701">mozilla/pdf.js#21701</a></li>
<li>Bump github/codeql-action/analyze from 4.37.2 to 4.37.3 by <a href="https://github.com/dependabot"><code>@​dependabot</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21705">mozilla/pdf.js#21705</a></li>
<li>Bump github/codeql-action/init from 4.37.2 to 4.37.3 by <a href="https://github.com/dependabot"><code>@​dependabot</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21704">mozilla/pdf.js#21704</a></li>
<li>Bump github/codeql-action/autobuild from 4.37.2 to 4.37.3 by <a href="https://github.com/dependabot"><code>@​dependabot</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21703">mozilla/pdf.js#21703</a></li>
<li>Shorten the <code>Menu</code> constructor a tiny bit by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21700">mozilla/pdf.js#21700</a></li>
<li>Enable the <code>regexp/no-super-linear-move</code> ESLint rule by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21708">mozilla/pdf.js#21708</a></li>
<li>Bump fast-uri from 3.1.4 to 3.1.5 by <a href="https://github.com/dependabot"><code>@​dependabot</code></a>[bot] in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21712">mozilla/pdf.js#21712</a></li>
<li>Remove the ambiguity from the PostScript number regex by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21709">mozilla/pdf.js#21709</a></li>
<li>Avoid an infinite loop on cyclic field Parent chains by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21699">mozilla/pdf.js#21699</a></li>
<li>Enable a few more <code>eslint-plugin-regexp</code> rules by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21710">mozilla/pdf.js#21710</a></li>
<li>Give copied annotations distinct references by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21707">mozilla/pdf.js#21707</a></li>
<li>Use the <code>MathClamp</code> helper in the <code>src/core/annotation.js</code> file by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21715">mozilla/pdf.js#21715</a></li>
<li>Update <code>PDFViewerApplication._initializeAutoPrint</code> to handle <code>getJSActions</code> returning a Map (PR 21664 follow-up) by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21716">mozilla/pdf.js#21716</a></li>
<li>Move <code>SCALE_MATRIX</code> into <code>CanvasGraphics</code> and initialize its <code>DOMMatrix</code> lazily (issue 21720) by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21721">mozilla/pdf.js#21721</a></li>
<li>Convert <code>TranslatedFont.prototype.loadType3Data</code> to an asynchronous method by <a href="https://github.com/Snuffleupagus"><code>@​Snuffleupagus</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21719">mozilla/pdf.js#21719</a></li>
<li>Don't re-encode the <code>file</code> parameter in the viewer by <a href="https://github.com/calixteman"><code>@​calixteman</code></a> in <a href="https://redirect.github.com/mozilla/pdf.js/pull/21718">mozilla/pdf.js#21718</a></li>
</ul>
<!-- raw HTML omitted -->
</blockquote>
<p>... (truncated)</p>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/mozilla/pdf.js/commit/1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56"><code>1c8020a</code></a> Merge pull request <a href="https://redirect.github.com/mozilla/pdf.js/issues/21841">#21841</a> from Snuffleupagus/src-core-misc-fixes</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/67c035f451867ada7994b4720fb9a319c6ca45ef"><code>67c035f</code></a> Inline the <code>PDFDocument.prototype._parseHasJSActions</code> method</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/c58a2758f73480f46bce8769e5392d3f2ff3e08d"><code>c58a275</code></a> Move some <code>WorkerTask</code> class field definitions out of the constructor</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/d1725aba54ad7110e369c9d7fad404a480f2ab0a"><code>d1725ab</code></a> Merge pull request <a href="https://redirect.github.com/mozilla/pdf.js/issues/21837">#21837</a> from Snuffleupagus/rm-ColorSpace-getoutputlength</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/159dca9e0efd96915246be019877d220abe1d62a"><code>159dca9</code></a> Remove the unused <code>getOutputLength</code> method from the <code>ColorSpace</code> classes (PR ...</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/8801a6a644655ad0d09027d29bb45892610598f6"><code>8801a6a</code></a> Merge pull request <a href="https://redirect.github.com/mozilla/pdf.js/issues/21835">#21835</a> from Snuffleupagus/getViewerPreferences-tests</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/08a06008468a3ffa626b9fab9e95e6223f7c943b"><code>08a0600</code></a> Merge pull request <a href="https://redirect.github.com/mozilla/pdf.js/issues/21834">#21834</a> from Snuffleupagus/markInfo-Map</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/289592267e605d79ead0450318f6b8a5b22fd37e"><code>2895922</code></a> Improve unit-test coverage for the <code>getViewerPreferences</code> functionality</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/16b94d1565482f34a7726adc713516418f5a8714"><code>16b94d1</code></a> [api-minor] Convert <code>markInfo</code> to return data in a Map</li>
<li><a href="https://github.com/mozilla/pdf.js/commit/c3257df8db58845021faea9642b0237f7c2e5101"><code>c3257df</code></a> Merge pull request <a href="https://redirect.github.com/mozilla/pdf.js/issues/21833">#21833</a> from mozilla/update-locales</li>
<li>Additional commits viewable in <a href="https://github.com/mozilla/pdf.js/compare/v6.2.108...v6.3.289">compare view</a></li>
</ul>
</details>
<br />

