# Token-Goat approval demo

Open `demo/index.html` through a local static server or GitHub Pages. The presentation has seven
captured Copilot Chat workflows, including a page-scoped PDF extraction and a representative
read-only database schema-catalog query. The recorded workflow evidence lives in `demo/evidence/`.

![Approval demo preview](./screenshots/approval-demo.webp)

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
node scripts\generate-demo-evidence.mjs
node scripts\generate-demo-features.mjs
```

The page intentionally makes no universal token-savings claim. Its evidence pane displays recorded
local output and a per-workflow input-token comparison. The comparisons use Token-Goat's built-in
text estimator, `floor(characters / 3) + 1`, against an explicit broad-input baseline named in the
presentation. It also bundles those captures into `demo/evidence.js`, so opening `demo/index.html`
directly from Windows Explorer works without a local web server. The PDF is generated from the
versioned review-brief source; the database example uses representative sanitized schema data and
never opens a production database connection.

`demo/features.js` is generated from the built CLI command manifest. Regenerate it after adding,
removing, or renaming a command so the catalog remains complete.
