import { describe, expect, it } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import { acceptMedicalRewrite, rewriteMedicalSearchQuery } from "./medical-query-rewrite";

describe("staging Qwen3 medical query rewriter", () => {
  it("makes exactly one small model call, preserving the old topic for a short follow-up", async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const ai: WorkersAiLike = {
      run: async (model, input) => {
        calls.push({ model, input });
        return {
          choices: [{ message: { content: "aortic stenosis management and treatment" } }],
        };
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
    expect(calls[0]?.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(calls[0]?.input).toMatchObject({
      max_tokens: 512,
      temperature: 0.4,
      top_p: 0.8,
      stream: false,
    });
    const inputText = JSON.stringify(calls[0]?.input);
    expect(inputText).toContain("Latest student question: management");
    expect(inputText).not.toContain("unrelated past answer");
    expect(inputText).toContain("/no_think");
  });

  it("accepts Arabic translation and typo repair despite changed original tokens", () => {
    expect(acceptMedicalRewrite("علاج ضيق الصمام الأورطي", "aortic stenosis management")).toBe(
      "aortic stenosis management",
    );
    expect(acceptMedicalRewrite("aortic stnosis", "aortic stenosis")).toBe("aortic stenosis");
    expect(acceptMedicalRewrite("aortic stenosis", "query: aortic stenosis")).toBe(null);
    expect(acceptMedicalRewrite("aortic stenosis", "aortic stenosis\nFMF")).toBe(null);
    expect(acceptMedicalRewrite("ضيق الصمام", "ضيق الصمام")).toBe(null);
  });

  it("accepts a Qwen3 response with empty thinking tags", async () => {
    const ai: WorkersAiLike = {
      run: async () => ({
        choices: [{ message: { content: "<think>\n\n</think>\naortic stenosis diagnosis" } }],
      }),
    };
    expect(
      await rewriteMedicalSearchQuery(ai, "تشخيص ضيق الصمام الأورطي", "تشخيص ضيق الصمام الأورطي"),
    ).toBe("aortic stenosis diagnosis");
  });

  it("falls back on model outage or syntactically invalid output", async () => {
    const focused = "management and treatment of aortic stenosis";
    const failed: WorkersAiLike = {
      run: async () => {
        throw new Error("429");
      },
    };
    const malformed: WorkersAiLike = { run: async () => ({ response: "query: aortic stenosis" }) };
    expect(await rewriteMedicalSearchQuery(failed, "management", focused)).toBe(focused);
    expect(await rewriteMedicalSearchQuery(malformed, "management", focused)).toBe(focused);
    expect(await rewriteMedicalSearchQuery(undefined, "management", focused)).toBe(focused);
  });

  it("never calls a model for missing topic or oversized input", async () => {
    let calls = 0;
    const ai: WorkersAiLike = {
      run: async () => {
        calls++;
        return { response: "aortic stenosis" };
      },
    };
    expect(await rewriteMedicalSearchQuery(ai, "management", "management")).toBe("management");
    const oversized = "aortic stenosis " + "patient ".repeat(180);
    expect(await rewriteMedicalSearchQuery(ai, oversized, oversized)).toBe(oversized);
    expect(calls).toBe(0);
  });
});
