import { describe, it, expect } from "vitest";
import { buildPackageManifestHint } from "../src/hints.js";

// Provenance: HAND-DERIVED. Inputs are literal paths; the expected commands name the displayed path the caller passes, and their exit codes are asserted against the built bundle in tests/hook_hint_commands_run.test.ts.
describe("buildPackageManifestHint", () => {
  it("returns a hint for package.json", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", shown: "package.json" });
    expect(result).not.toBeNull();
  });

  it("returns null for a file that is not a recognized manifest", () => {
    const result = buildPackageManifestHint({ file_path: "package-lock.json", shown: "package-lock.json" });
    expect(result).toBeNull();
  });

  it("matches case-insensitively", () => {
    const result = buildPackageManifestHint({ file_path: "PACKAGE.JSON", shown: "PACKAGE.JSON" });
    expect(result).not.toBeNull();
  });

  it("matches after stripping a directory prefix (forward slash)", () => {
    const result = buildPackageManifestHint({ file_path: "some/nested/dir/package.json", shown: "some/nested/dir/package.json" });
    expect(result).not.toBeNull();
  });

  it("matches after stripping a directory prefix (backslash, Windows path)", () => {
    const result = buildPackageManifestHint({ file_path: "C:\\projects\\app\\package.json", shown: "C:/projects/app/package.json" });
    expect(result).not.toBeNull();
  });

  it("reports HINT_PRIORITY_MEDIUM (3) as the hint priority", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", shown: "package.json" });
    expect(result?.hint_priority).toBe(3);
  });

  it("names the basename in prose but the displayed path in every suggested command, with commands that read JSON", () => {
    const result = buildPackageManifestHint({ file_path: "some/dir/package.json", shown: "some/dir/package.json" });
    expect(result?.text).toContain("`package.json`");
    expect(result?.text).toContain('`token-goat json-query "some/dir/package.json" "dependencies"`');
    expect(result?.text).toContain('`token-goat json-outline "some/dir/package.json"`');
    // `section` finds headings only and prints "has no headings" for JSON, so it must never be suggested here.
    expect(result?.text).not.toContain("token-goat section");
  });

  it("still matches when a trailing NUL byte is stripped down to an exact basename match (sanitize runs before the match check)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json\u0000", shown: "package.json" });
    expect(result).not.toBeNull();
  });

  it("does not match when NUL-stripping still leaves a different basename", () => {
    const result = buildPackageManifestHint({ file_path: "package.json\u0000evil", shown: "package.json" });
    expect(result).toBeNull();
  });
});
