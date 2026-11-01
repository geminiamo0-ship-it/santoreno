import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyntheticLearnerLookup } from "../scripts/noor_staging_browser_lookup.mjs";

test("signed synthetic learner lookup compiles and preserves Arabic/quoted labels", async () => {
  for (const name of [
    "طالب تجريبي ذو اسم عربي طويل لقياس العرض",
    'Owner\'s child — اسم "مركّب"',
    "');globalThis.injected=true;//",
  ]) {
    const expression = buildSyntheticLearnerLookup(name);
    const execute = new Function("fetch", `return ${expression}`);
    const mockFetch = async (url, options) => {
      assert.equal(url, "/v1/me/learners");
      assert.deepEqual(options, { cache: "no-store" });
      const learners = [
        { name: "Other", id: "other" },
        { name, id: "expected" },
      ];
      return { json: async () => ({ learners }) };
    };
    assert.equal(await execute(mockFetch), "expected");
  }
});

test("invalid learner labels cannot form an evaluator expression", () => {
  for (const name of ["", "   ", "x".repeat(121), null, 12]) {
    assert.throws(() => buildSyntheticLearnerLookup(name), TypeError);
  }
});
