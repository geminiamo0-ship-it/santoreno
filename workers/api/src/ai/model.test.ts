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
  LUNA_STAGING_COMPLETION_BUDGET,
  groundedSchemaForCitationIds,
  stripInternalCitationLinks,
  createLunaCitationAliases,
  redactKnownSourceIds,
} from "./model";

describe("medical citation presentation", () => {
  it("removes raw search ID link targets without changing teaching prose or authentic citations", () => {
    const id = "one-examination-isolated:10a236b9772d5f3add5c93e77";
    const draft =
      "Aortic stenosis is obstructive. [Valve obstruction raises afterload](" +
      id +
      ") and normal [clinical reference](https://example.edu/reference).";
    expect(stripInternalCitationLinks(draft, [id])).toBe(
      "Aortic stenosis is obstructive. Valve obstruction raises afterload and normal " +
        "[clinical reference](https://example.edu/reference).",
    );
    expect(stripInternalCitationLinks(draft, [])).toBe(draft);
    const withBare = [
      "Aortic stenosis [one-examination-isolated:chunk-2]",
      "and documented [passmedicine:chunk-5].",
    ].join(" ");
    const cleaned = stripInternalCitationLinks(withBare, [
      "one-examination-isolated:chunk-2",
      "passmedicine:chunk-5",
    ]);
    expect(cleaned).toBe("Aortic stenosis and documented.");
    expect(stripInternalCitationLinks(withBare, ["other:chunk"])).toBe(withBare);
    expect(stripInternalCitationLinks(draft, ["different:source"])).toBe(draft);
  });
});

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

describe("Staging-only compact citation mapping", () => {
  const rawId = "amboss:bc5678eef0c033a2211a911efabc124911ef0deeddad019ab987";
  const otherId = "usmle:ef01c2ff787a0ea116af8042c563388ad96d97e122";
  it("replaces private RAG identifiers in the model prompt but restores verified IDs afterward", async () => {
    const frames = [
      {
        type: "response.output_text.delta",
        delta: JSON.stringify({
          answer: "Clinical teaching. cite" + rawId + " and " + otherId,
          citation_ids: ["SANTO_REF_1", "SANTO_REF_2"],
        }),
      },
      { type: "response.completed", response: { status: "completed" } },
    ]
      .map((event) => "data: " + JSON.stringify(event) + "\\n\\n")
      .join("");
    const text = new TextEncoder().encode(frames.replaceAll("\\n", "\n"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    });
    const ai: WorkersAiLike = { run: vi.fn(async () => stream) };
    const previews: string[] = [];
    const model = new CloudflareLunaModel(ai, true);
    const result = await model.generate(
      'USER_QUESTION_JSON:"aortic stenosis"\\nEVIDENCE_JSON:' +
        JSON.stringify([{ source_id: rawId }, { source_id: otherId }]),
      (x) => previews.push(x),
      [rawId, otherId],
    );
    expect(result.citationIds).toEqual([rawId, otherId]);
    expect(result.answer).toBe("Clinical teaching.  and ");
    expect(previews).toHaveLength(1);
    expect(previews[0]).not.toContain(rawId);
    expect(previews[0]).not.toContain("cite");
    expect(ai.run).toHaveBeenCalledTimes(1);
    const body = vi.mocked(ai.run).mock.calls[0]![1] as {
      input: string;
      text: { format: { schema: { properties: { citation_ids: { items: { enum: string[] } } } } } };
    };
    expect(body.input).toContain("SANTO_REF_1");
    expect(body.input).toContain("SANTO_REF_2");
    expect(body.input).not.toContain(rawId);
    expect(body.input).not.toContain(otherId);
    expect(body.text.format.schema.properties.citation_ids.items.enum).toEqual([
      "SANTO_REF_1",
      "SANTO_REF_2",
    ]);
  });

  it("never removes ordinary clinical writing while deleting known machine source markers", () => {
    const input =
      "Severe aortic stenosis can cause angina. cite" +
      rawId +
      "\\n[s1]\\n" +
      otherId +
      "\\nAnd syncope.";
    const cleaned = redactKnownSourceIds(input.replaceAll("\\n", "\n"), [rawId, otherId]);
    expect(cleaned).toContain("angina");
    expect(cleaned).toContain("syncope");
    expect(cleaned).not.toContain(rawId);
    expect(cleaned).not.toContain(otherId);
    const refs = createLunaCitationAliases("source_id: " + rawId, [rawId]);
    expect(refs.resolve("SANTO_REF_1")).toBe(rawId);
    expect(refs.prompt).not.toContain(rawId);
  });

  it("leaves the legacy model's real source IDs unchanged when aliasing is off", () => {
    const ai: WorkersAiLike = { run: vi.fn() };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "production",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_COMPACT_CITATION_ALIASES_V1: "true",
      SANTO_AI_MODEL: "@cf/test/llama",
    });
    expect(model).toBeInstanceOf(CloudflareWorkersAiModel);
  });
});

describe("Staging cost protection: exactly one paid provider generation per attempt", () => {
  it("uses Luna once and never invokes Llama after a transient Luna error", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async (_model: string) => {
        throw new Error("provider offline");
      }),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_AI_MODEL: "@cf/test/llama",
    });
    expect(model).toBeInstanceOf(CloudflareLunaModel);
    await expect(model.generate("Medical prompt")).rejects.toMatchObject({ code: "MODEL_FAILED" });
    expect(vi.mocked(ai.run)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ai.run).mock.calls[0]?.[0]).toBe("openai/gpt-6-luna");
  });

  it("does not re-generate after a malformed Luna JSON response", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({ output_text: '{"bad":"output"}' })),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_AI_MODEL: "@cf/test/llama",
    });
    await expect(model.generate("Evidence")).rejects.toMatchObject({
      code: "MODEL_RESPONSE_INVALID",
    });
    expect(vi.mocked(ai.run)).toHaveBeenCalledTimes(1);
  });

  it("does not affect production and respects disabled flag", () => {
    const ai: WorkersAiLike = { run: vi.fn() };
    expect(
      createGroundedModel({
        AI: ai,
        SANTO_ENV: "production",
        SANTO_LUNA_PREVIEW: "true",
        SANTO_SINGLE_PASS_GENERATION_V1: "true",
        SANTO_AI_MODEL: "@cf/test/llama",
      }),
    ).toBeInstanceOf(CloudflareWorkersAiModel);
    expect(
      createGroundedModel({
        AI: ai,
        SANTO_ENV: "staging",
        SANTO_LUNA_PREVIEW: "true",
        SANTO_SINGLE_PASS_GENERATION_V1: "false",
        SANTO_AI_MODEL: "@cf/test/llama",
      }),
    ).toBeInstanceOf(FallbackGroundedModel);
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

  it("keeps a fixed single-pass output budget without buying additional model tokens", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        output_text:
          '{"answer":"Relevant mechanisms and management.","citation_ids":["amboss:chunk-123"]}',
      })),
    };
    const model = new CloudflareLunaModel(ai);
    await model.generate("Aortic stenosis", undefined, trusted);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith(
      "openai/gpt-6-luna",
      expect.objectContaining({
        max_output_tokens: 5000,
        text: { format: expect.objectContaining({ type: "json_schema", strict: true }) },
        instructions: expect.stringContaining(LUNA_STAGING_COMPLETION_BUDGET),
      }),
    );
    expect(LUNA_STAGING_COMPLETION_BUDGET).toContain("finish JSON immediately");
    expect(LUNA_STAGING_COMPLETION_BUDGET).toContain("citation_ids");
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
