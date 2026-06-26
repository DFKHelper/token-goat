import { describe, it, expect, vi } from "vitest";
import type { HintItem } from "../src/hints.js";
import {
  slimHintText,
  applyHintPriorityLimit,
  dedupHints,
  computeStaleThreshold,
  buildBashDedupHint,
  buildPackageManifestHint,
  HINT_PRIORITY_CRITICAL,
  HINT_PRIORITY_HIGH,
  HINT_PRIORITY_MEDIUM,
  HINT_PRIORITY_LOW,
  STALE_READ_AGE_SECONDS,
} from "../src/hints.js";

describe("slimHintText", () => {
  it("returns unchanged text for cool tier", () => {
    const text = "This is a hint\n\nWith multiple paragraphs";
    expect(slimHintText(text, "cool")).toBe(text);
  });

  it("returns unchanged text when warm and below threshold", () => {
    const text = "Short hint";
    expect(slimHintText(text, "warm")).toBe(text);
  });

  it("trims to first paragraph at warm tier when above threshold", () => {
    const text = "First paragraph\n\n" + "X".repeat(600);
    const result = slimHintText(text, "warm");
    expect(result).toBe("First paragraph");
  });

  it("trims and caps at hot tier", () => {
    const longPara = "A".repeat(300) + "\nLine 2\nLine 3";
    const result = slimHintText(longPara, "hot");
    expect(result).toContain("…");
    expect(result.length).toBeLessThanOrEqual(230);
  });

  it("keeps single-line first paragraph without capping at hot tier", () => {
    const text = "Single line first paragraph\n\nSecond paragraph";
    const result = slimHintText(text, "hot");
    expect(result).toBe("Single line first paragraph");
  });

  it("returns original text when first paragraph is empty", () => {
    const text = "\n\nSecond paragraph";
    expect(slimHintText(text, "warm")).toBe(text);
  });
});

describe("applyHintPriorityLimit", () => {
  it("returns empty array for empty hints", () => {
    expect(applyHintPriorityLimit([])).toEqual([]);
  });

  it("sorts hints by priority", () => {
    const hints: HintItem[] = [
      { text: "low priority", hint_priority: HINT_PRIORITY_LOW },
      { text: "critical priority", hint_priority: HINT_PRIORITY_CRITICAL },
      { text: "medium priority", hint_priority: HINT_PRIORITY_MEDIUM },
    ];

    const result = applyHintPriorityLimit(hints, 10);
    expect(result).toEqual([
      "critical priority",
      "medium priority",
      "low priority",
    ]);
  });

  it("applies max hints limit", () => {
    const hints: HintItem[] = [
      { text: "hint 1", hint_priority: HINT_PRIORITY_CRITICAL },
      { text: "hint 2", hint_priority: HINT_PRIORITY_HIGH },
      { text: "hint 3", hint_priority: HINT_PRIORITY_MEDIUM },
      { text: "hint 4", hint_priority: HINT_PRIORITY_LOW },
    ];

    const result = applyHintPriorityLimit(hints, 2);
    expect(result.length).toBe(2);
    expect(result[1]).toContain("(+2 suppressed)");
  });

  it("applies slim text at hot tier", () => {
    const hints: HintItem[] = [
      {
        text: "Short hint",
        hint_priority: HINT_PRIORITY_HIGH,
      },
      {
        text: "A".repeat(300) + "\n\nSecond paragraph",
        hint_priority: HINT_PRIORITY_MEDIUM,
      },
    ];

    const result = applyHintPriorityLimit(hints, 10, { tier: "hot" });
    expect(result[1]).not.toContain("Second paragraph");
  });

  it("returns empty array when maxHints is 0 (no out-of-bounds write)", () => {
    const hints: HintItem[] = [
      { text: "hint 1", hint_priority: HINT_PRIORITY_CRITICAL },
      { text: "hint 2", hint_priority: HINT_PRIORITY_HIGH },
    ];
    const result = applyHintPriorityLimit(hints, 0);
    expect(result).toEqual([]);
  });
});

describe("dedupHints", () => {
  it("returns hints unchanged when no cache provided", () => {
    const hints: HintItem[] = [
      { text: "hint 1", hint_priority: HINT_PRIORITY_MEDIUM },
      { text: "hint 2", hint_priority: HINT_PRIORITY_MEDIUM },
    ];

    const result = dedupHints(hints);
    expect(result).toEqual(hints);
  });

  it("deduplicates identical content", () => {
    const mockCache = {
      get_hint_content_summary: vi.fn((_hash: string) => {
        return "prior hint";
      }),
      record_hint_content_seen: vi.fn(),
    };

    const hints: HintItem[] = [
      { text: "Same hint text", hint_priority: HINT_PRIORITY_MEDIUM },
    ];

    const result = dedupHints(hints, mockCache as never);
    expect(result[0].text).toContain("[tg: dup]");
  });

  it("does not overwrite stored summary when emitting a dup stub", () => {
    // When a hint is a duplicate, record_hint_content_seen must NOT be called again
    // — calling it would overwrite the original stored summary with the current item's text.
    const mockCache = {
      get_hint_content_summary: vi.fn((_hash: string) => "original stored summary"),
      record_hint_content_seen: vi.fn(),
    };

    const hints: HintItem[] = [
      { text: "duplicate hint with different phrasing", hint_priority: HINT_PRIORITY_MEDIUM },
    ];

    dedupHints(hints, mockCache as never);
    expect(mockCache.record_hint_content_seen).not.toHaveBeenCalled();
  });

  it("keeps first occurrence of unique hints", () => {
    const mockCache = {
      get_hint_content_summary: vi.fn(),
      record_hint_content_seen: vi.fn(),
    };

    const hints: HintItem[] = [
      { text: "unique hint", hint_priority: HINT_PRIORITY_MEDIUM },
    ];

    const result = dedupHints(hints, mockCache as never);
    expect(result[0].text).toBe("unique hint");
    expect(mockCache.record_hint_content_seen).toHaveBeenCalled();
  });
});

describe("computeStaleThreshold", () => {
  it("returns floor (900s) for very short sessions", () => {
    const result = computeStaleThreshold(100);
    expect(result).toBe(900);
  });

  it("returns adaptive threshold in mid-range", () => {
    const sessionAge = 3600;
    const result = computeStaleThreshold(sessionAge);
    expect(result).toBeGreaterThanOrEqual(900);
    expect(result).toBeLessThanOrEqual(STALE_READ_AGE_SECONDS);
  });

  it("returns ceiling (STALE_READ_AGE_SECONDS) for very long sessions", () => {
    const result = computeStaleThreshold(STALE_READ_AGE_SECONDS * 4);
    expect(result).toBe(STALE_READ_AGE_SECONDS);
  });

  it("applies formula: clamp(session_age * 0.25, 900, 1800)", () => {
    expect(computeStaleThreshold(4000)).toBeLessThanOrEqual(STALE_READ_AGE_SECONDS);
  });
});

describe("buildBashDedupHint", () => {
  it("returns null when session_id is missing", () => {
    const result = buildBashDedupHint({
      session_id: "",
      command: "echo test",
    });
    expect(result).toBeNull();
  });

  it("returns null when command is missing", () => {
    const result = buildBashDedupHint({
      session_id: "test-session",
      command: "",
    });
    expect(result).toBeNull();
  });

  it("returns null when cache is missing", () => {
    const result = buildBashDedupHint({
      session_id: "test-session",
      command: "echo test",
    });
    expect(result).toBeNull();
  });

  it("returns hint for valid inputs with cache", () => {
    const mockCache = {
      get_file_access_count: vi.fn(() => 3),
    };

    const result = buildBashDedupHint({
      session_id: "test-session",
      command: "echo test",
      cache: mockCache as never,
    });

    expect(result).not.toBeNull();
    if (result) {
      expect(result).toContain("echo");
      expect(result).toContain("cached");
    }
  });

  it("truncates long bash commands", () => {
    const mockCache = {
      get_file_access_count: vi.fn(() => 3),
    };

    const longCmd = "pytest " + "x".repeat(100) + " --verbose --extra --options";
    const result = buildBashDedupHint({
      session_id: "test-session",
      command: longCmd,
      cache: mockCache as never,
    });

    expect(result).not.toBeNull();
    if (result) {
      expect(result.length).toBeLessThan(longCmd.length);
      expect(result).toContain("…");
    }
  });
});

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
});
