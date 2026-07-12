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
});
