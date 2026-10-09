import { describe, expect, it, vi } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import { GroundedAiError } from "./errors";
import { CloudflareWorkersAiModel, createGroundedModel, GROUNDED_MODEL_POLICY } from "./model";

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
