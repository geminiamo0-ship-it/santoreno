import { describe, expect, it } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import { acceptMedicalRewrite, rewriteMedicalSearchQuery } from "./medical-query-rewrite";

describe("staging Granite Micro medical query rewriter", () => {
  it("makes exactly one small model call, preserving the old topic for a short follow-up", async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const ai: WorkersAiLike = {
      run: async (model, input) => {
        calls.push({ model, input });
        return { response: "aortic stenosis management and treatment" };
      },
    };
    const envelope =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: unrelated past answer claims about FMF.\n" +
      "Follow-up question:\nmanagement";
    const rewritten = await rewriteMedicalSearchQuery(
      ai,
      envelope,
      "management and treatment of aortic stenosis",
    );
    expect(rewritten).toBe("aortic stenosis management and treatment");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    expect(calls[0]?.input).toMatchObject({
      max_tokens: 64,
      temperature: 0,
      stream: false,
    });
    const inputText = JSON.stringify(calls[0]?.input);
    expect(inputText).toContain("Latest student question: management");
    expect(inputText).not.toContain("unrelated past answer");
  });

  it("rejects stale disease switch, malformed output, and invented condition", () => {
    expect(acceptMedicalRewrite("Familial Mediterranean fever", "aortic stenosis management")).toBe(
      null,
    );
    expect(acceptMedicalRewrite("aortic stenosis", "query: aortic stenosis")).toBe(null);
    expect(acceptMedicalRewrite("aortic stenosis", "aortic stenosis\nFMF")).toBe(null);
    expect(acceptMedicalRewrite("aortic stenosis", "unrelated disease management")).toBe(null);
  });

  it("keeps clinical constraints instead of dropping negation or severity", () => {
    expect(
      acceptMedicalRewrite(
        "severe asymptomatic aortic stenosis management",
        "management of severe aortic stenosis",
      ),
    ).toBe(null);
    expect(
      acceptMedicalRewrite(
        "aortic stenosis without symptoms",
        "aortic stenosis management",
      ),
    ).toBe(null);
    expect(
      acceptMedicalRewrite(
        "severe asymptomatic aortic stenosis management",
        "management of severe asymptomatic aortic stenosis",
      ),
    ).toBe("management of severe asymptomatic aortic stenosis");
  });

  it("falls back to deterministic search on model outage, malformed and missing bindings", async () => {
    const focused = "management and treatment of aortic stenosis";
    const failed: WorkersAiLike = { run: async () => { throw new Error("429"); } };
    const malformed: WorkersAiLike = { run: async () => ({ response: "management of FMF" }) };
    expect(await rewriteMedicalSearchQuery(failed, "management", focused)).toBe(focused);
    expect(await rewriteMedicalSearchQuery(malformed, "management", focused)).toBe(focused);
    expect(await rewriteMedicalSearchQuery(undefined, "management", focused)).toBe(focused);
  });

  it("never calls a model for missing topic or oversized input", async () => {
    let calls = 0;
    const ai: WorkersAiLike = { run: async () => { calls++; return { response: "aortic stenosis" }; } };
    expect(await rewriteMedicalSearchQuery(ai, "management", "management")).toBe("management");
    const oversized = "aortic stenosis " + "patient ".repeat(180);
    expect(await rewriteMedicalSearchQuery(ai, oversized, oversized)).toBe(oversized);
    expect(calls).toBe(1);
  });
});
