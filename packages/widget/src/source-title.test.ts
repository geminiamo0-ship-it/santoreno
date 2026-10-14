import { describe, expect, it } from "vitest";
import { readableMedicalSourceTitle } from "./source-title";

describe("Medical citation labels", () => {
  it("hides raw R2 paths without inventing clinical article names", () => {
    expect(readableMedicalSourceTitle("medical-search/v1/pastest/pastest-3385/s-0008.md"))
      .toBe("Pastest · Article pastest-3385 · Section 8");
    expect(readableMedicalSourceTitle("medical-search/v1/one-examination/one-exam-library-7959/s-0001.md"))
      .toBe("One Examination · Article one-exam-library-7959 · Section 1");
  });
  it("leaves verified human titles and non-canonical IDs unmodified", () => {
    expect(readableMedicalSourceTitle("Acute aortic dissection"))
      .toBe("Acute aortic dissection");
    expect(readableMedicalSourceTitle("medical-search/v1/../../secrets"))
      .toBe("medical-search/v1/../../secrets");
  });
});
