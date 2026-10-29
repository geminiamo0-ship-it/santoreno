import { describe, expect, it, vi } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import {
  CloudflareWorkersAiModel,
  CloudflareLunaModel,
  createGroundedModel,
  GROUNDED_MODEL_POLICY,
} from "./model";

describe("Cloudflare Workers AI model adapter", () => {
  it("selects the configured model and owns its generation policy", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          answer: "Sodium is 135–145 mmol/L.",
          citation_ids: ["medical:chunk-1"],
        }),
      })),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_AI_MODEL: "  @cf/test/grounded-model  ",
    });

    await expect(model.generate("Use only supplied evidence")).resolves.toEqual({
      answer: "Sodium is 135–145 mmol/L.",
      citationIds: ["medical:chunk-1"],
    });
    expect(GROUNDED_MODEL_POLICY.maxTokens).toBe(1500);
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/test/grounded-model",
      expect.objectContaining({
        temperature: GROUNDED_MODEL_POLICY.temperature,
        max_tokens: GROUNDED_MODEL_POLICY.maxTokens,
        response_format: expect.objectContaining({ type: "json_schema" }),
        messages: [
          expect.objectContaining({ role: "system" }),
          { role: "user", content: "Use only supplied evidence" },
        ],
      }),
    );
    const request = vi.mocked(ai.run).mock.calls[0]?.[1] as
      { messages?: { role: string; content: string }[] } | undefined;
    expect(request?.messages?.[0]?.content).toContain("source-grounded medical tutor");
    expect(request?.messages?.[0]?.content).toContain(
      "never introduce claims not supported by the provided evidence",
    );
  });

  it("requires both the AI binding and a nonempty model name", async () => {
    await expect(
      createGroundedModel({ SANTO_AI_MODEL: "@cf/test/grounded-model" }).generate("test"),
    ).rejects.toMatchObject({ status: 503, code: "AI_NOT_CONFIGURED" });
    await expect(
      new CloudflareWorkersAiModel({ run: vi.fn() }, "  ").generate("test"),
    ).rejects.toMatchObject({ status: 503, code: "AI_NOT_CONFIGURED" });
  });

  it("rejects malformed provider output without trusting provider-controlled fields", async () => {
    const model = new CloudflareWorkersAiModel(
      { run: vi.fn(async () => ({ response: '{"answer":"Uncited","citation_ids":null}' })) },
      "@cf/test/grounded-model",
    );
    await expect(model.generate("test")).rejects.toMatchObject({
      status: 502,
      code: "MODEL_RESPONSE_INVALID",
    });
  });

  it("maps unexpected provider errors to a stable structured code", async () => {
    const model = new CloudflareWorkersAiModel(
      {
        run: vi.fn(async () => {
          throw new Error("provider-sensitive-detail");
        }),
      },
      "@cf/test/grounded-model",
    );
    await expect(model.generate("test")).rejects.toMatchObject({
      status: 502,
      code: "MODEL_FAILED",
    });
    await expect(model.generate("test")).rejects.toBeInstanceOf(GroundedAiError);
  });
});

describe("GPT-6 Luna isolated Santo staging preview", () => {
  it("uses native Responses API and explicit nonreasoning fast tier only under staging flag", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        output: [
          { type: "reasoning", content: [] },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  answer: "Evidence-backed diagnosis.",
                  citation_ids: ["medical:chunk-1"],
                }),
              },
            ],
          },
        ],
      })),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
    });
    expect(model).toBeInstanceOf(CloudflareLunaModel);
    await expect(model.generate("Ground this answer")).resolves.toEqual({
      answer: "Evidence-backed diagnosis.",
      citationIds: ["medical:chunk-1"],
    });
    expect(ai.run).toHaveBeenCalledWith(
      "openai/gpt-6-luna",
      expect.objectContaining({
        input: "Ground this answer",
        reasoning: { effort: "none" },
        service_tier: "fast",
        store: false,
        max_output_tokens: 1500,
        text: expect.objectContaining({
          format: expect.objectContaining({ type: "json_schema", strict: true }),
        }),
      }),
    );
  });

  it("keeps existing Workers AI model in production and default staging", () => {
    const ai: WorkersAiLike = { run: vi.fn() };
    for (const config of [
      { SANTO_ENV: "production" as const, SANTO_LUNA_PREVIEW: "true" },
      { SANTO_ENV: "staging" as const, SANTO_LUNA_PREVIEW: "false" },
    ]) {
      expect(
        createGroundedModel({ ...config, AI: ai, SANTO_AI_MODEL: "@cf/test/model" }),
      ).toBeInstanceOf(CloudflareWorkersAiModel);
    }
  });

  it("rejects provider claims without a valid structured evidence-bound JSON draft", async () => {
    const bad = new CloudflareLunaModel({
      run: vi.fn(async () => ({
        output_text: '{"answer":"No cited evidence","citation_ids":null}',
      })),
    });
    await expect(bad.generate("test")).rejects.toMatchObject({
      status: 502,
      code: "MODEL_RESPONSE_INVALID",
    });
    const thrown = new CloudflareLunaModel({
      run: vi.fn(async () => {
        throw new Error("provider token");
      }),
    });
    await expect(thrown.generate("test")).rejects.toMatchObject({
      status: 502,
      code: "MODEL_FAILED",
    });
  });
});
