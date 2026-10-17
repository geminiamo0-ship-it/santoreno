import { describe, expect, it, vi } from "vitest";

import type { WorkersAiLike } from "../runtime/bindings";
import { CloudflareLunaModel, createGroundedModel } from "./model";
import { parsePlainLunaAnswer, previewPlainLuna } from "./plain-luna";

function sse(text: string): ReadableStream<Uint8Array> {
  const delta = { type: "response.output_text.delta", delta: text };
  const completed = { type: "response.completed", response: { status: "completed" } };
  const content = [delta, completed].map((x) => "data: " + JSON.stringify(x) + "\n\n").join("");
  const bytes = new TextEncoder().encode(content);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("staging single-pass plain-Luna citation contract", () => {
  const sourceA = "amboss:chunk-012345678900000000000001";
  const sourceB = "usmle:chunk-abcdef112233445566778899";

  it("cites only evidence actually referenced, preserving first-use order", () => {
    expect(
      parsePlainLunaAnswer(
        "## Diagnosis\nEcho confirms valve obstruction [[2]].\n## Causes\nCalcification [[1]].\nManagement [[2]].",
        [sourceA, sourceB],
      ),
    ).toEqual({
      answer:
        "## Diagnosis\nEcho confirms valve obstruction [1].\n## Causes\nCalcification [2].\nManagement [1].",
      citationIds: [sourceB, sourceA],
    });
  });

  it("preserves completed uncited medical teaching with related source status", () => {
    expect(parsePlainLunaAnswer("Management consists of valve replacement.", [sourceA])).toEqual({
      answer: "Management consists of valve replacement.",
      citationIds: [],
      sourcePresentation: "related",
    });
    expect(parsePlainLunaAnswer("Wrong source [[3]].", [sourceA])).toEqual({
      answer: "Wrong source .",
      citationIds: [],
      sourcePresentation: "related",
    });
    expect(parsePlainLunaAnswer("Malformed [[xx]]. Correct [[1]].", [sourceA])).toEqual({
      answer: "Malformed . Correct [1].",
      citationIds: [sourceA],
    });
    expect(parsePlainLunaAnswer("Partial marker [[1", [sourceA])).toEqual({
      answer: "Partial marker",
      citationIds: [],
      sourcePresentation: "related",
    });
  });

  it("preserves only scoped original-image markers for the server to resolve", () => {
    const answer = parsePlainLunaAnswer("Valve anatomy [[IMG_001]] [[1]].", [sourceA]);
    expect(answer.answer).toContain("[[IMG_001]]");
    expect(answer.answer).toContain("[1]");
    expect(answer.citationIds).toEqual([sourceA]);
    const preview = previewPlainLuna(
      "Valve anatomy [[IMG_001]] ![bad](https://bad.invalid/a.png)",
      [sourceA],
    );
    expect(preview).not.toContain("IMG_001");
    expect(preview).not.toContain("bad.invalid");
  });

  it("keeps Luna clarifications and social answers free of random source citations", () => {
    const clarification = "What condition do you mean by management? Please name the disease.";
    expect(parsePlainLunaAnswer(clarification, [sourceA])).toEqual({
      answer: clarification,
      citationIds: [],
      sourcePresentation: "none",
    });
    expect(parsePlainLunaAnswer("Hello!", [sourceA])).toEqual({
      answer: "Hello!",
      citationIds: [],
      sourcePresentation: "none",
    });
    const actualGreeting = "Hi! What would you like to learn about today?";
    expect(parsePlainLunaAnswer(actualGreeting, [sourceA, sourceB])).toEqual({
      answer: actualGreeting,
      citationIds: [],
      sourcePresentation: "none",
    });
    expect(parsePlainLunaAnswer("General medical teaching.", [])).toEqual({
      answer: "General medical teaching.",
      citationIds: [],
    });
    expect(parsePlainLunaAnswer("Fabricated [[1]]", [])).toEqual({
      answer: "Fabricated",
      citationIds: [],
    });
  });

  it("never exposes partial internal references in an unverified SSE preview", () => {
    expect(previewPlainLuna("Clinical point. [[1]]\nNext statement [[", [sourceA])).toBe(
      "Clinical point. \nNext statement ",
    );
    expect(previewPlainLuna("Mechanism [" + sourceA, [sourceA])).not.toContain(sourceA);
    expect(previewPlainLuna("Aortic stenosis [SANTO_REF", [sourceA])).toBe("Aortic stenosis ");
  });

  it("returns a server-mapped verified draft in ONE provider call without JSON formatting", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () =>
        sse(
          "## Aortic stenosis\n" +
            "Pressure overload causes hypertrophy [[1]]. Echo confirms severity [[2]].",
        ),
      ),
    };
    const model = new CloudflareLunaModel(ai, true, true);
    const previews: string[] = [];
    const result = await model.generate(
      'USER_QUESTION_JSON:"aortic stenosis"\nEVIDENCE_JSON:' +
        JSON.stringify([{ source_id: sourceA }, { source_id: sourceB }]),
      (p) => previews.push(p),
      [sourceA, sourceB],
    );
    expect(vi.mocked(ai.run)).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(ai.run).mock.calls[0]![1] as {
      input: string;
      text?: unknown;
      max_output_tokens: number;
      stream: boolean;
      instructions: string;
    };
    expect(payload.text).toBeUndefined();
    expect(payload.stream).toBe(true);
    expect(payload.max_output_tokens).toBe(3_000);
    expect(payload.instructions).toContain("3,000 output tokens");
    expect(payload.instructions).toContain("Respond in readable Markdown, never JSON");
    expect(payload.instructions).toContain("AVAILABLE_ORIGINAL_ARTICLE_IMAGES");
    expect(payload.instructions).toContain("safe image-placement requests");
    expect(payload.instructions).toContain("mechanisms first");
    expect(payload.instructions).toContain("mini-chapter");
    expect(payload.instructions).toContain("never attribute unsupported background facts");
    expect(payload.instructions).toContain("An explicitly new medical topic");
    expect(payload.instructions).toContain("Prefer a few distinct, clinically relevant original figures");
    expect(payload.input).toContain("SANTO_REF_1");
    expect(payload.input).toContain("Cite a supported statement as [[N]]");
    expect(payload.input).not.toContain("citation_ids");
    expect(payload.input).not.toContain("Put labels inside");
    expect(payload.input).not.toContain(sourceA);
    expect(result.citationIds).toEqual([sourceA, sourceB]);
    expect(result.answer).toContain("hypertrophy [1]");
    expect(previews.join("")).not.toContain("SANTO_REF");
    expect(previews[previews.length - 1]).not.toContain("[[");
  });

  it("accepts 70k chars of completed Luna Markdown and keeps citations", () => {
    const longChapter = "Valve pressure overload. ".repeat(3100) + " [[1]]";
    expect(longChapter.length).toBeGreaterThan(64_000);
    const parsed = parsePlainLunaAnswer(longChapter, [sourceA]);
    expect(parsed.answer.length).toBeGreaterThan(64_000);
    expect(parsed.answer).toContain("Valve pressure overload.");
    expect(parsed.answer.endsWith(" [1]")).toBe(true);
    expect(parsed.citationIds).toEqual([sourceA]);
  });

  it("continues to reject a completed Luna chapter that exceeds the bounded parser cap", () => {
    expect(() => parsePlainLunaAnswer("A".repeat(120_001), [sourceA])).toThrow(
      "Model returned unusable teaching text",
    );
  });

  it("still rejects incomplete streams without launching a fallback model", async () => {
    const ai: WorkersAiLike = {
      run: vi.fn(async () => {
        const bytes = new TextEncoder().encode(
          "data: " +
            JSON.stringify({ type: "response.output_text.delta", delta: "Preview [[1]]" }) +
            "\n\n",
        );
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }),
    };
    const model = createGroundedModel({
      AI: ai,
      SANTO_ENV: "staging",
      SANTO_LUNA_PREVIEW: "true",
      SANTO_SINGLE_PASS_GENERATION_V1: "true",
      SANTO_COMPACT_CITATION_ALIASES_V1: "true",
      SANTO_PLAIN_TEXT_LUNA_V1: "true",
      SANTO_AI_MODEL: "@cf/test/secondary",
    });
    await expect(model.generate("Question", vi.fn(), [sourceA])).rejects.toMatchObject({
      code: "MODEL_STREAM_UNFINISHED",
    });
    expect(vi.mocked(ai.run)).toHaveBeenCalledTimes(1);
  });
});
