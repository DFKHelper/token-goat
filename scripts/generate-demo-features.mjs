import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "dist", "token-goat.mjs");

const categoryByCommand = new Map([
  ["symbol", "Find and read code"], ["read", "Find and read code"], ["brief", "Find and read code"],
  ["section", "Find and read code"], ["semantic", "Find and read code"], ["skeleton", "Find and read code"],
  ["outline", "Find and read code"], ["refs", "Find and read code"], ["exports", "Find and read code"],
  ["imports", "Find and read code"], ["find", "Find and read code"], ["grep", "Find and read code"],
  ["callers", "Understand a change"], ["call-chain", "Understand a change"], ["impact", "Understand a change"],
  ["dead", "Understand a change"], ["deps", "Understand a change"], ["types", "Understand a change"],
  ["scope", "Understand a change"], ["similar", "Understand a change"], ["context-for", "Understand a change"],
  ["test-for", "Understand a change"], ["coverage-gaps", "Understand a change"], ["arch", "Understand a change"],
  ["blame", "Understand a change"], ["ask", "Understand a change"], ["changed", "Understand a change"],
  ["diff", "Understand a change"], ["log", "Understand a change"], ["baseline", "Understand a change"],
  ["map", "Measure and reduce context"], ["pack", "Measure and reduce context"], ["tokens", "Measure and reduce context"],
  ["budget", "Measure and reduce context"], ["compress-text", "Measure and reduce context"], ["retrieve", "Measure and reduce context"],
  ["compress", "Measure and reduce context"], ["compact-doc", "Measure and reduce context"], ["compact-hint", "Measure and reduce context"], ["cost", "Measure and reduce context"],
  ["failures", "Debug and review"], ["todo", "Debug and review"], ["trace", "Debug and review"],
  ["logfold", "Debug and review"], ["lockdeps", "Debug and review"], ["dep-docs", "Debug and review"],
  ["coverage-report-gaps", "Debug and review"], ["conflicts", "Debug and review"],
  ["index", "Run and maintain Token-Goat"], ["worker", "Run and maintain Token-Goat"], ["install", "Run and maintain Token-Goat"],
  ["uninstall", "Run and maintain Token-Goat"], ["doctor", "Run and maintain Token-Goat"], ["config", "Run and maintain Token-Goat"],
  ["config-get", "Run and maintain Token-Goat"], ["project", "Run and maintain Token-Goat"], ["commands", "Run and maintain Token-Goat"], ["version", "Run and maintain Token-Goat"],
  ["help", "Run and maintain Token-Goat"], ["bridges-status", "Run and maintain Token-Goat"], ["mcp-serve", "Run and maintain Token-Goat"],
  ["hook", "Run and maintain Token-Goat"], ["statusline", "Run and maintain Token-Goat"],
  ["stats", "Remember and monitor work"], ["context-stats", "Remember and monitor work"], ["bootstrap-audit", "Remember and monitor work"],
  ["memory", "Remember and monitor work"], ["waste", "Remember and monitor work"], ["session-outline", "Remember and monitor work"],
  ["session-slice", "Remember and monitor work"], ["mcp-audit", "Remember and monitor work"], ["recall", "Remember and monitor work"],
  ["hint-stats", "Remember and monitor work"], ["hot", "Remember and monitor work"], ["recent", "Remember and monitor work"],
  ["resume", "Remember and monitor work"], ["session-summary", "Remember and monitor work"], ["note", "Remember and monitor work"],
  ["note-add", "Remember and monitor work"], ["note-get", "Remember and monitor work"], ["note-list", "Remember and monitor work"],
  ["bash-output", "Manage cached results"], ["web-output", "Manage cached results"], ["mcp-output", "Manage cached results"],
  ["bash-history", "Manage cached results"], ["web-history", "Manage cached results"], ["mcp-history", "Manage cached results"],
  ["history", "Manage cached results"], ["reclaim-index", "Manage cached results"], ["clean-cache", "Manage cached results"],
  ["prune-cache", "Manage cached results"], ["cache-audit", "Manage cached results"],
  ["handoff-create", "Share compact handoffs"], ["handoff-resolve", "Share compact handoffs"],
  ["skill-body", "Work with skills"], ["skill-compact", "Work with skills"], ["skill-list", "Work with skills"],
  ["skill-size", "Work with skills"], ["skill-history", "Work with skills"], ["skill-diff", "Work with skills"],
  ["skill-section", "Work with skills"],
  ["pdf-extract", "Read documents, data, and media"], ["pdf-outline", "Read documents, data, and media"], ["pdf-meta", "Read documents, data, and media"],
  ["xlsx-sheets", "Read documents, data, and media"], ["xlsx-head", "Read documents, data, and media"], ["xlsx-range", "Read documents, data, and media"],
  ["xlsx-query", "Read documents, data, and media"], ["pptx-outline", "Read documents, data, and media"], ["pptx-slide", "Read documents, data, and media"],
  ["pptx-notes", "Read documents, data, and media"], ["pptx-text", "Read documents, data, and media"], ["docx-outline", "Read documents, data, and media"],
  ["docx-text", "Read documents, data, and media"], ["transcript-outline", "Read documents, data, and media"], ["transcript", "Read documents, data, and media"],
  ["csv-query", "Read documents, data, and media"], ["csv-profile", "Read documents, data, and media"], ["json-outline", "Read documents, data, and media"],
  ["json-query", "Read documents, data, and media"], ["yaml-outline", "Read documents, data, and media"], ["yaml-query", "Read documents, data, and media"],
  ["openapi-outline", "Read documents, data, and media"], ["openapi-op", "Read documents, data, and media"], ["zip-list", "Read documents, data, and media"],
  ["zip-read", "Read documents, data, and media"], ["sqlite-schema", "Read documents, data, and media"], ["sqlite-query", "Read documents, data, and media"],
  ["sharepoint-resolve", "Read documents, data, and media"], ["video-chapters", "Read documents, data, and media"], ["gdrive-sections", "Read documents, data, and media"],
  ["pr-slice", "Read documents, data, and media"], ["screenshot", "Read documents, data, and media"],
  ["fetch-image", "Work with files and images"], ["write-file", "Work with files and images"], ["replace", "Work with files and images"],
  ["insert-section", "Work with files and images"], ["ignores", "Work with files and images"],
]);

const commands = JSON.parse(execFileSync(process.execPath, [cli, "commands", "--json"], {
  cwd: root,
  encoding: "utf8",
})).map(({ name, description }) => ({
  category: categoryByCommand.get(name) ?? "Other registered features",
  name,
  description,
})).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

writeFileSync(
  resolve(root, "demo", "features.js"),
  `window.tokenGoatFeatures = ${JSON.stringify(commands, null, 2)};\n`,
);
