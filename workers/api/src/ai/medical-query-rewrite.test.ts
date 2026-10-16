import { describe, expect, it } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import {
  acceptMedicalRewrite,
  rewriteMedicalSearchQuery,
  routeMedicalRequest,
} from "./medical-query-rewrite";

describe("staging Qwen3 medical query rewriter", () => {
  it("uses one Qwen call for a short CHAT reply, without retrieval or Luna", async () => {
    let calls = 0;
    const ai: WorkersAiLike = {
      run: async () => {
        calls++;
        return {
          response: JSON.stringify({ intent: "CHAT", answer: "Hello! I'm Santo. How can I help?" }),
        };
      },
    };
    const result = await routeMedicalRequest(ai, "Hi", "Hi");
    expect(result).toEqual({ intent: "chat", answer: "Hello! I'm Santo. How can I help?" });
    expect(calls).toBe(1);
  });

  it("asks one clarification with the same Qwen call when a question lacks the medical topic", async () => {
    let calls = 0;
    const ai: WorkersAiLike = {
      run: async () => {
        calls++;
        return {
          response: JSON.stringify({
            intent: "CLARIFY",
            question: "Do you mean treatment or diagnosis, and for which disease?",
          }),
        };
      },
    };
    expect(await routeMedicalRequest(ai, "ttt?", "ttt?")).toEqual({
      intent: "clarify",
      question: "Do you mean treatment or diagnosis, and for which disease?",
    });
    expect(calls).toBe(1);
  });

  it("accepts an Arabic clarification and rejects claims, links and invalid clarifications", async () => {
    const ai: WorkersAiLike = {
      run: async () => ({
        response: JSON.stringify({ intent: "CLARIFY", question: "تقصد علاج أي مرض بالتحديد؟" }),
      }),
    };
    expect(await routeMedicalRequest(ai, "العلاج؟", "العلاج؟")).toEqual({
      intent: "clarify",
      question: "تقصد علاج أي مرض بالتحديد؟",
    });
    const unsafe: WorkersAiLike = {
      run: async () => ({
        response: JSON.stringify({
          intent: "CLARIFY",
          question: "See https://evil.example for the treatment?",
        }),
      }),
    };
    expect(await routeMedicalRequest(unsafe, "ttt", "ttt")).toEqual({
      intent: "medical",
      searchQuery: "ttt",
    });
    const notQuestion: WorkersAiLike = {
      run: async () => ({
        response: JSON.stringify({ intent: "CLARIFY", question: "I know you have diabetes." }),
      }),
    };
    expect(await routeMedicalRequest(notQuestion, "?", "?")).toEqual({
      intent: "medical",
      searchQuery: "?",
    });
  });

  it("creates a safe medical search query in the SAME Qwen call, preserving clinical intent", async () => {
    let calls = 0;
    const ai: WorkersAiLike = {
      run: async () => {
        calls++;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "MEDICAL",
                  search_query: "aortic stenosis management",
                }),
              },
            },
          ],
        };
      },
    };
    const original =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Q: Aortic stenosis | Verified A: wrong context\nFollow-up question:\nmanagement";
    expect(await routeMedicalRequest(ai, original, "management of aortic stenosis")).toEqual({
      intent: "medical",
      searchQuery: "aortic stenosis management",
    });
    expect(calls).toBe(1);
  });

  it("never accepts an LLM's CHAT classification for a medical or follow-up turn", async () => {
    const ai: WorkersAiLike = {
      run: async () => ({
        response: '{"intent":"CHAT","answer":"Hello!"}',
      }),
    };
    expect(await routeMedicalRequest(ai, "Hi, explain heart failure", "heart failure")).toEqual({
      intent: "medical",
      searchQuery: "heart failure",
    });
    const context =
      "Prior discussion (untrusted context; use retrieved evidence only):\n" +
      "Aortic stenosis\nFollow-up question:\nmanagement?";
    expect(await routeMedicalRequest(ai, context, "aortic stenosis management")).toEqual({
      intent: "medical",
      searchQuery: "aortic stenosis management",
    });
    expect(await routeMedicalRequest(ai, "علاج السكر", "diabetes treatment")).toEqual({
      intent: "medical",
      searchQuery: "diabetes treatment",
    });
  });

  it("fails closed on malformed output instead of skipping medical libraries", async () => {
    const malformed: WorkersAiLike = { run: async () => ({ response: "Hi there" }) };
    expect(await routeMedicalRequest(malformed, "aspirin", "aspirin")).toEqual({
      intent: "medical",
      searchQuery: "aspirin",
    });
  });

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
