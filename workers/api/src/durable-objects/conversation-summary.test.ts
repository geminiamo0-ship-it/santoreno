import { describe, expect, it } from "vitest";

import { appendVerifiedTurnSummary, SUMMARY_MAX_CHARS } from "./conversation-summary";

describe("bounded deterministic verified conversation summary", () => {
  it("retains only normalized excerpts of completed grounded turns", () => {
    const first = appendVerifiedTurnSummary("", "  What   is serum sodium? ", " 135–145   mmol/L ");
    expect(first).toBe("Q: What is serum sodium? | Verified A: 135–145 mmol/L");
    expect(
      appendVerifiedTurnSummary(first, "And chloride?", "Reference applies to chloride."),
    ).toContain("Q: And chloride? | Verified A: Reference applies to chloride.");
  });

  it("stays within 1,200 characters through 200 turns without growing history", () => {
    let summary = "";
    for (let i = 0; i < 200; i += 1) {
      summary = appendVerifiedTurnSummary(
        summary,
        `Clinical question ${i}: ${"Q".repeat(150)}`,
        `Verified grounded evidence ${i}: ${"A".repeat(250)}`,
      );
      expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    }
    expect(summary).toContain("Clinical question 199");
    expect(summary).not.toContain("Clinical question 0:");
    expect(summary.split("\n").every((line) => line.startsWith("Q:"))).toBe(true);
  });

  it("drops malformed legacy summary lines and bounds oversized content", () => {
    const hostile = "not-verified-line\n" + "Q: X".repeat(1000);
    const summary = appendVerifiedTurnSummary(hostile, "Valid question", "Trusted answer");
    expect(summary).toBe("Q: Valid question | Verified A: Trusted answer");
  });
});
