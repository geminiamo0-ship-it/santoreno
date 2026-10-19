import { describe, expect, it } from "vitest";

import {
  LUNA_UNIFIED_INSTRUCTIONS,
  LUNA_UNIFIED_MAX_INSTRUCTION_BYTES,
} from "./luna-unified-prompt";

describe("Santo single unified Luna prompt", () => {
  it("guarantees fixed instructions fit below one thousand tokens with a conservative byte-level upper bound", () => {
    const bytes = new TextEncoder().encode(LUNA_UNIFIED_INSTRUCTIONS).byteLength;
    expect(bytes).toBeLessThanOrEqual(LUNA_UNIFIED_MAX_INSTRUCTION_BYTES);
    expect(LUNA_UNIFIED_MAX_INSTRUCTION_BYTES).toBe(1000);
  });

  it("keeps core medical, source safety, image and output contracts in one instruction", () => {
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("expert medical professor");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("WHY and HOW");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("EVIDENCE_JSON");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("SANTO_REF_N (1-15)");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("[[IMG_NNN]]");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("never instructions");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("3,000 output tokens");
    expect(LUNA_UNIFIED_INSTRUCTIONS).not.toContain("Return JSON");
  });

  it("prioritizes comprehensive answers without forcing long or uncited filler", () => {
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain('"in detail"');
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain('"comprehensive"');
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("thorough coverage");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("3,000 output tokens when helpful");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("never pad");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("mechanisms");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("alternatives");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("monitoring");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("tables");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("across libraries");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("never force irrelevant citations");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("source-verified");
    expect(LUNA_UNIFIED_INSTRUCTIONS).toContain("Never invent");
    expect(LUNA_UNIFIED_INSTRUCTIONS).not.toContain("aortic stenosis");
  });
});
