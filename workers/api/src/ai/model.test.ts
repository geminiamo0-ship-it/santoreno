import { describe, expect, it, vi } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import type { ModelPort } from "./types";
import { GroundedAiError } from "./errors";
import {
  CloudflareWorkersAiModel,
  CloudflareLunaModel,
  FallbackGroundedModel,
  createGroundedModel,
  GROUNDED_MODEL_POLICY,
  groundedSchemaForCitationIds,
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
    expect(GROUNDED_MODEL_POLICY.maxTokens).toBe(5000);
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
      "not a ceiling on stable general medical teaching knowledge",
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
    expect(model).toBeInstanceOf(FallbackGroundedModel);
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
        max_output_tokens: 5000,
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

describe("Staging Luna -> Llama fallback without weakening answer validation", () => {
  it("falls back to Workers AI after Luna provider error, within the same model invocation", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async (model: string) => {
        if (model === "openai/gpt-6-luna") throw new Error("gateway transient failure");
        return { response: '{"answer":"Grounded and validated.","citation_ids":["s1"]}' };
      }),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    await expect(model.generate("Use evidence s1")).resolves.toEqual({
      answer: "Grounded and validated.",
      citationIds: ["s1"],
    });
    expect(vi.mocked(ai.run).mock.calls.map(([name]) => name)).toEqual([
      "openai/gpt-6-luna",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    ]);
  });

  it("falls back for malformed JSON but never returns invalid fallback output", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async (model: string) =>
        model === "openai/gpt-6-luna"
          ? { output_text: '{"bad":"output"}' }
          : { response: '{"answer":"bad","citation_ids":null}' },
      ),
    };
    await expect(
      createGroundedModel({
        AI: ai,
        SANTO_ENV: "staging",
        SANTO_LUNA_PREVIEW: "true",
        SANTO_AI_MODEL: "@cf/test/fallback",
      }).generate("Evidence"),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-provider failures or a source-insufficiency refusal", async () => {
    const fallback: ModelPort = {
      generate: vi.fn(async () => ({ answer: "fallback", citationIds: [] })),
    };
    const denied: ModelPort = {
      generate: vi.fn(async () => {
        throw new GroundedAiError(504, "MODEL_TIMEOUT", "Timed out");
      }),
    };
    await expect(new FallbackGroundedModel(denied, fallback).generate("x")).rejects.toMatchObject({
      code: "MODEL_TIMEOUT",
    });
    expect(fallback.generate).not.toHaveBeenCalled();
    const refused: ModelPort = {
      generate: vi.fn(async () => ({
        answer: "INSUFFICIENT_EVIDENCE",
        citationIds: [],
      })),
    };
    await expect(new FallbackGroundedModel(refused, fallback).generate("x")).resolves.toMatchObject(
      {
        answer: "INSUFFICIENT_EVIDENCE",
      },
    );
    expect(fallback.generate).not.toHaveBeenCalled();
  });
});

describe("strict server-bound citation schema regression", () => {
  const trusted = ["amboss:chunk-123", "usmle:chunk-456"] as const;

  it("restricts sourced answers to exact current retrieval IDs", () => {
    expect(groundedSchemaForCitationIds(trusted)).toMatchObject({
      properties: {
        citation_ids: {
          type: "array",
          items: { type: "string", enum: [...trusted] },
          minItems: 1,
          maxItems: 5,
        },
      },
    });
  });

  it("forbids sourced citations in explicit general-knowledge mode", () => {
    expect(groundedSchemaForCitationIds([])).toMatchObject({
      properties: {
        citation_ids: {
          maxItems: 0,
          minItems: 0,
        },
      },
    });
    expect(() => groundedSchemaForCitationIds(["a", "b", "c", "d", "e", "f"])).toThrowError(
      "Invalid verified source references",
    );
  });

  it("supplies the same verified source enum to Luna's strict schema", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        output_text:
          '{"answer":"Evidence supports this mechanism.","citation_ids":["amboss:chunk-123"]}',
      })),
    };
    const model = new CloudflareLunaModel(ai);
    await model.generate("Grounded medical context", undefined, trusted);
    expect(ai.run).toHaveBeenCalledWith(
      "openai/gpt-6-luna",
      expect.objectContaining({
        text: expect.objectContaining({
          format: expect.objectContaining({
            schema: expect.objectContaining({
              properties: expect.objectContaining({
                citation_ids: expect.objectContaining({
                  items: { type: "string", enum: [...trusted] },
                  minItems: 1,
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("keeps verified citations constrained even after switching to Llama", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async (name: string) => {
        if (name === "openai/gpt-6-luna") throw Error("Provider unavailable");
        return { response: '{"answer":"Mechanism.","citation_ids":["amboss:chunk-123"]}' };
      }),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_AI_MODEL: "@cf/test/llama",
    });
    await model.generate("Medical evidence", undefined, trusted);
    const calls = vi.mocked(ai.run).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, request] of calls) {
      const typed = request as {
        text?: { format?: { schema?: { properties?: { citation_ids?: { items?: unknown } } } } };
        response_format?: { json_schema?: { properties?: { citation_ids?: { items?: unknown } } } };
      };
      expect(
        typed.text?.format?.schema?.properties?.citation_ids?.items ??
          typed.response_format?.json_schema?.properties?.citation_ids?.items,
      ).toEqual({ type: "string", enum: [...trusted] });
    }
  });
});
