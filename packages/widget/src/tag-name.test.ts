import { describe, expect, it } from "vitest";

import { SANTO_WIDGET_TAG } from "./tag-name";

describe("Santo widget tag", () => {
  it("uses the public custom-element name", () => {
    expect(SANTO_WIDGET_TAG).toBe("santo-ai");
  });
});
