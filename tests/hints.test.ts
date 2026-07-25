import { describe, it, expect } from "vitest";
import { buildPackageManifestHint } from "../src/hints.js";

describe("buildPackageManifestHint", () => {
  it("returns a hint for package.json with no offset/limit", () => {
    const result = buildPackageManifestHint({ file_path: "package.json" });
    expect(result).not.toBeNull();
  });

  it("suppresses hint when offset alone is provided (|| fix)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", offset: 0 });
    expect(result).toBeNull();
  });

  it("suppresses hint when limit alone is provided (|| fix)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", limit: 50 });
    expect(result).toBeNull();
  });

  it("suppresses hint when both offset and limit are provided", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", offset: 10, limit: 50 });
    expect(result).toBeNull();
  });

  it("returns null for a file that is not a recognized manifest", () => {
    const result = buildPackageManifestHint({ file_path: "package-lock.json" });
    expect(result).toBeNull();
  });

  it("matches case-insensitively", () => {
    const result = buildPackageManifestHint({ file_path: "PACKAGE.JSON" });
    expect(result).not.toBeNull();
  });

  it("matches after stripping a directory prefix (forward slash)", () => {
    const result = buildPackageManifestHint({ file_path: "some/nested/dir/package.json" });
    expect(result).not.toBeNull();
  });

  it("matches after stripping a directory prefix (backslash, Windows path)", () => {
    const result = buildPackageManifestHint({ file_path: "C:\\projects\\app\\package.json" });
    expect(result).not.toBeNull();
  });

  it("still shows the hint for a negative offset (only offset >= 0 counts as provided)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", offset: -1 });
    expect(result).not.toBeNull();
  });

  it("still shows the hint for a zero limit (only limit > 0 counts as provided)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json", limit: 0 });
    expect(result).not.toBeNull();
  });

  it("reports HINT_PRIORITY_MEDIUM (3) as the hint priority", () => {
    const result = buildPackageManifestHint({ file_path: "package.json" });
    expect(result?.hint_priority).toBe(3);
  });

  it("embeds the actual basename (not the full path) in the hint text", () => {
    const result = buildPackageManifestHint({ file_path: "some/dir/package.json" });
    expect(result?.text).toContain("`package.json`");
    expect(result?.text).not.toContain("some/dir");
  });

  it("still matches when a trailing NUL byte is stripped down to an exact basename match (sanitize runs before the match check)", () => {
    const result = buildPackageManifestHint({ file_path: "package.json\u0000" });
    expect(result).not.toBeNull();
  });

  it("does not match when NUL-stripping still leaves a different basename", () => {
    const result = buildPackageManifestHint({ file_path: "package.json\u0000evil" });
    expect(result).toBeNull();
  });
});
