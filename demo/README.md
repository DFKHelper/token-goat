# Token-Goat approval demo

Open `demo/index.html` through a local static server or GitHub Pages. The presentation has seven
captured Copilot Chat workflows, including a page-scoped PDF extraction and a representative
read-only database schema-catalog query. The recorded workflow evidence lives in `demo/evidence/`.

![Approval demo preview](./screenshots/approval-demo.png)

Regenerate the local evidence after a meaningful code change:

```powershell
token-goat map --compact | Set-Content demo\evidence\01-project-map.txt
token-goat outline README.md | Set-Content demo\evidence\02-outline.txt
token-goat read "src/parser.ts::writeParseResult" | Set-Content demo\evidence\03-surgical-read.txt
token-goat semantic "Copilot CLI hook installation" | Set-Content demo\evidence\04-copilot-integration.txt
token-goat budget "src\**\*.ts" | Set-Content demo\evidence\05-budget.txt
token-goat section "README.md::Copilot CLI users" | Set-Content demo\evidence\06-copilot-setup.txt
python scripts\generate-demo-pdf.py
python scripts\generate-demo-pptx.py
token-goat pdf-meta demo\fixtures\token-goat-review-brief.pdf
token-goat pdf-outline demo\fixtures\token-goat-review-brief.pdf
token-goat pdf-extract demo\fixtures\token-goat-review-brief.pdf --pages 2-3
token-goat sqlite-query "C:\approved\schema_reference.db" "SELECT schema_name, table_name, column_name, data_type, description FROM columns WHERE table_name IN ('ASSET_ATTRIBUTES', 'REFERENCE_CODES') ORDER BY table_name, column_order" --head 12
token-goat pptx-outline demo\fixtures\large-single-slide-review.pptx
token-goat pptx-slide demo\fixtures\large-single-slide-review.pptx --slide 1
python scripts\generate-eval-capture.py --db ..\token-goat-eval\results.db
python scripts\generate-eval-pdf.py
node scripts\generate-demo-evidence.mjs
node scripts\generate-demo-features.mjs
```

## Checking the paired-evaluation numbers yourself

`demo/evidence/12-eval-paired.txt` reports median paired token ratios over six
tasks on one model and one repository, with the full spread, the per-pair rows
and the limitations printed beside them. Every figure on the page is
recomputable from data shipped in this repository.

**Recompute the published figures from the raw rows.** All 29 recorded runs are
in `demo/data/eval-runs.csv`; the tasks are in `demo/data/eval-tasks.csv`.

```bash
python scripts/generate-eval-capture.py   # rewrites the capture from the CSV
git diff --exit-code demo/evidence/12-eval-paired.txt
```

A clean diff means the published capture is exactly what the vendored data
produces. `scripts/generate-eval-pdf.py` renders the PDF from that capture alone
— never from a database — so the PDF cannot state a figure the evidence pane
does not.

**Check the arithmetic against a second implementation.**
`tests/eval_capture_matches_data.test.ts` recomputes every published number from
the same CSV in TypeScript, without calling the Python generator, and fails if
the two disagree. It also pins the spread, the per-pair rows, the discarded-run
counts and the statement that the result is about cost rather than capability,
so none of them can quietly leave the page. It runs in `npm test`.

**Inspect the tasks.** Each row's `sha` is a real commit in this repository, and
`parent_sha` is the state the model was given. `git show <sha>` is the bug and
its human fix; `git show <sha> -- <test_files>` is the test that decided whether
a run resolved.

The harness that collected the runs is a separate working tree and is not
vendored here, so the CSVs support re-deriving the analysis rather than
repeating the data collection.

The page intentionally makes no universal token-savings claim. Its evidence pane displays recorded
local output and a per-workflow input-token comparison. The comparisons use Token-Goat's built-in
text estimator, `floor(characters / 3) + 1`, against an explicit broad-input baseline named in the
presentation. It also bundles those captures into `demo/evidence.js`, so opening `demo/index.html`
directly from Windows Explorer works without a local web server. The PDF is generated from the
versioned review-brief source; the database example uses representative sanitized schema data and
never opens a production database connection.

`demo/features.js` is generated from the built CLI command manifest. Regenerate it after adding,
removing, or renaming a command so the catalog remains complete.
