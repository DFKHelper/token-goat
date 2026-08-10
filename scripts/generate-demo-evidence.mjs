import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const evidenceFiles = [
  "01-project-map.txt",
  "02-outline.txt",
  "03-surgical-read.txt",
  "04-copilot-integration.txt",
  "05-budget.txt",
  "06-copilot-setup.txt",
  "07-pdf-review.txt",
  "08-oracle-schema.txt",
  "09-compact-hint.txt",
  "10-web-output.txt",
  "11-powerpoint.txt",
];

const evidence = Object.fromEntries(
  evidenceFiles.map((file) => {
    const path = resolve(root, "demo", "evidence", file);
    return [`./evidence/${file}`, readFileSync(path, "utf8")];
  }),
);

function estimateTokens(text) {
  return Math.floor(text.length / 3) + 1;
}

function typeScriptPaths(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typeScriptPaths(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    });
}

function readTypeScriptFiles(directory) {
  return typeScriptPaths(directory)
    .sort()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function matchingLines(paths, query) {
  return paths.flatMap((path) =>
    readFileSync(resolve(root, path), "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.toLowerCase().includes(query))
      .map(({ line, index }) => `${path}:${index + 1}:${line}`),
  ).join("\n");
}

function representativeSchemaCatalog() {
  return Array.from({ length: 240 }, (_, index) => {
    const table = index % 2 === 0 ? "ASSET_ATTRIBUTES" : "REFERENCE_CODES";
    return `CATALOG,${table},FIELD_${index + 1},TEXT,Representative catalog field.`;
  }).join("\n");
}

const baselines = {
  map: {
    label: "Git-tracked file list",
    text: execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }),
  },
  outline: {
    label: "Full README",
    text: readFileSync(resolve(root, "README.md"), "utf8"),
  },
  read: {
    label: "Full src/parser.ts",
    text: readFileSync(resolve(root, "src", "parser.ts"), "utf8"),
  },
  semantic: {
    label: "Broad Copilot text search",
    text: matchingLines(["src/bridges/copilot_cli.ts", "src/bridges/copilot_cli_install.ts", "README.md"], "copilot"),
  },
  budget: {
    label: "All TypeScript source",
    text: readTypeScriptFiles(resolve(root, "src")),
  },
  pdf: {
    label: "Full 4-page PDF text",
    text: readFileSync(resolve(root, "demo", "fixtures", "token-goat-review-brief-full.txt"), "utf8"),
  },
  oracle: {
    label: "Full representative 240-column schema catalog",
    text: representativeSchemaCatalog(),
  },
  compact: {
    label: "Full project README",
    text: readFileSync(resolve(root, "README.md"), "utf8"),
  },
  web: {
    label: "Full cached web page",
    tokenCount: 2739,
  },
  pptx: {
    label: "24.3 MB raw deck payload estimate",
    tokenCount: Math.floor(24.3 * 1024 * 1024 / 3) + 1,
  },
};

const metrics = Object.fromEntries(
  Object.entries({
    map: "01-project-map.txt",
    outline: "02-outline.txt",
    read: "03-surgical-read.txt",
    semantic: "04-copilot-integration.txt",
    budget: "05-budget.txt",
    pdf: "07-pdf-review.txt",
    oracle: "08-oracle-schema.txt",
    compact: "09-compact-hint.txt",
    web: "10-web-output.txt",
    pptx: "11-powerpoint.txt",
  }).map(([workflow, file]) => {
    const baselineTokens = baselines[workflow].tokenCount ?? estimateTokens(baselines[workflow].text);
    const tokenGoatTokens = workflow === "compact" ? 197 : estimateTokens(evidence[`./evidence/${file}`]);
    return [workflow, {
      baselineLabel: baselines[workflow].label,
      baselineTokens,
      tokenGoatTokens,
      savedTokens: baselineTokens - tokenGoatTokens,
      savingsPercent: Math.min(99.9, Math.round((1 - tokenGoatTokens / baselineTokens) * 1000) / 10),
    }];
  }),
);

const outputPath = resolve(root, "demo", "evidence.js");
writeFileSync(
  outputPath,
  `window.tokenGoatEvidence = ${JSON.stringify(evidence, null, 2)};\n`
    + `window.tokenGoatMetrics = ${JSON.stringify(metrics, null, 2)};\n`,
);
