import { describe, expect, it, vi } from "vitest";
import type { WorkersAiLike } from "../runtime/bindings";
import { CloudflareGlmFlashModel, createGroundedModel } from "./model";

const trusted = ["amboss:verified-1", "santo-anking-step-v12:verified-2"];

function chatSse(text: string): ReadableStream<Uint8Array> {
  const frames = [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const bytes = new TextEncoder().encode(
    frames.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n",
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("Staging-only GLM-4.7-Flash adapter", () => {
  it("uses GLM Chat Completions, one inference, 3000 output tokens, real AnKing citations", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => chatSse("Aortic stenosis severity [[1]], high-yield [[2]].")),
    };
    const model = new CloudflareGlmFlashModel(ai);
    const drafts: string[] = [];
    const answer = await model.generate(
      'USER_QUESTION_JSON:\n"Aortic stenosis"\nEVIDENCE_JSON:\n' +
        JSON.stringify(trusted.map((source_id) => ({ source_id, text: "Medical evidence." }))),
      (s) => drafts.push(s),
      trusted,
    );
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [modelId, input] = vi.mocked(ai.run).mock.calls[0]!;
    expect(modelId).toBe("@cf/zai-org/glm-4.7-flash");
    expect(input).toMatchObject({
      messages: [
        { role: "system", content: expect.stringContaining("EVIDENCE_JSON") },
        { role: "user", content: expect.stringContaining("SANTO_REF_2") },
      ],
      stream: true,
      max_completion_tokens: 3000,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(JSON.stringify(input)).not.toContain("amboss:verified-1");
    expect(JSON.stringify(input)).not.toContain("santo-anking-step-v12:verified-2");
    expect(answer.citationIds).toEqual(trusted);
    expect(answer.answer).toBe("Aortic stenosis severity [1], high-yield [2].");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).not.toContain("SANTO_REF");
    expect(drafts[0]).not.toContain("[[");
  });

  it("routes to GLM in Staging only, leaves Luna and Production untouched", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async (id: string) => {
        if (id !== "@cf/zai-org/glm-4.7-flash") throw Error("Wrong provider selected");
        return { choices: [{ message: { content: "Clinically supported [[1]]." } }] };
      }),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_PLAIN_TEXT_LUNA_V1: "true",
      SANTO_LUNA_UNIFIED_PROMPT_V1: "true",
      SANTO_GLM_47_FLASH_V1: "true",
    });
    const answer = await model.generate("Evidence amboss:verified-1", undefined, [trusted[0]!]);
    expect(answer.citationIds).toEqual([trusted[0]]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("retains the existing Luna model when GLM rollback flag is off", () => {
    const ai: WorkersAiLike = { run: vi.fn() };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_PLAIN_TEXT_LUNA_V1: "true",
      SANTO_GLM_47_FLASH_V1: "false",
    });
    expect(model).not.toBeInstanceOf(CloudflareGlmFlashModel);
  });
});
