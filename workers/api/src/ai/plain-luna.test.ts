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
  it("maps fifteen real inline references to their verified retrieval IDs without dropping claims", () => {
    const ids = Array.from({ length: 15 }, (_, index) => "amboss:r2-" + index);
    const answer = ids
      .map((_, index) => "Finding " + index + " [[" + (index + 1) + "]].")
      .join(" ");
    const result = parsePlainLunaAnswer(answer, ids);
    expect(result.citationIds).toEqual(ids);
    expect(result.answer).toContain("Finding 14 [15].");
    expect(result.answer).not.toContain("SANTO_REF");
  });

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

  it("repairs the exact surgical AVR preview [N10], [N11], [N1] and [N3] formats", () => {
    const ids = Array.from({ length: 15 }, (_, i) => "amboss:real-savr-" + i);
    const raw =
      "Surgical aortic valve replacement (SAVR). Surgical treatment [N10] [N11]. " +
      "Patient selection [N1]. Valve therapy [N3]. " +
      "Long-term anticoagulation [N3] and complications [N2].";
    const result = parsePlainLunaAnswer(raw, ids);
    expect(result.citationIds).toEqual([ids[9], ids[10], ids[0], ids[2], ids[1]]);
    expect(result.answer).toContain("Surgical treatment [1] [2].");
    expect(result.answer).toContain("Patient selection [3].");
    expect(result.answer).toContain("Valve therapy [4].");
    expect(result.answer).not.toMatch(/\[N\d+\]/);
    expect(previewPlainLuna(raw, ids)).not.toMatch(/\[N\d+\]/);
  });

  it("handles double brackets [[N10]], spaced markers and repeats but never invents a source", () => {
    const ids = Array.from({ length: 12 }, (_, i) => "amboss:safe-" + i);
    const raw =
      "Supported [[N10]], [[N 2]] and [N1]. Repeat [[N10]]. " +
      "Unknown [[N13]] [N99]. Real figure [[IMG_001]].";
    const result = parsePlainLunaAnswer(raw, ids);
    expect(result.citationIds).toEqual([ids[9], ids[1], ids[0]]);
    expect(result.answer).toContain("Supported [1], [2] and [3]. Repeat [1].");
    expect(result.answer).toContain("[[IMG_001]]");
    expect(result.answer).not.toContain("N13");
    expect(result.answer).not.toContain("N99");
    expect(previewPlainLuna(raw, ids)).not.toMatch(/\[\[N\s*\d+|\[N\s*\d+/);
  });

  it("never converts mismatched numeric marker/alias links into false citations", () => {
    const ids = Array.from({ length: 12 }, (_, i) => "amboss:allow-" + i);
    const result = parsePlainLunaAnswer(
      "Mismatch [[N10]](SANTO_REF_11). Matched [[N10]](SANTO_REF_10). Invalid [[N13]].",
      ids,
    );
    expect(result.citationIds).toEqual([ids[9]]);
    expect(result.answer).toContain("Matched [1].");
    expect(result.answer).not.toContain("SANTO_REF_11");
    expect(result.answer).not.toContain("N13");
    expect(result.answer).not.toContain("Mismatch [");
  });

  it("maps provider [[N]](SANTO_REF_4) syntax to an actual server-verified reference", () => {
    const ids = Array.from({ length: 15 }, (_, index) => "medical:verified-source-" + index);
    const raw =
      "## Aortic stenosis\\nMechanism [[N]](SANTO_REF_4). " +
      "Management [[N]](SANTO_REF_15) [[N]](SANTO_REF_4).";
    const parsed = parsePlainLunaAnswer(raw, ids);
    expect(parsed.citationIds).toEqual([ids[3], ids[14]]);
    expect(parsed.answer).toBe("## Aortic stenosis\\nMechanism [1]. Management [2] [1].");
    expect(parsed.answer).not.toContain("SANTO_REF");
    expect(parsed.answer).not.toContain("[[N]]");
  });

  it("rejects fabricated aliases, never invents citations, and hides streaming citation syntax", () => {
    const ids = ["amboss:real"];
    const result = parsePlainLunaAnswer(
      "Supported [[N]](SANTO_REF_1). Fabricated [[N]](SANTO_REF_15).",
      ids,
    );
    expect(result.citationIds).toEqual(ids);
    expect(result.answer).toBe("Supported [1]. Fabricated .");
    expect(parsePlainLunaAnswer("Unknown [[N]](SANTO_REF_13).", ids).citationIds).toEqual([]);
    expect(previewPlainLuna("Supported [[N]](SANTO_REF_1).", ids)).not.toContain("SANTO_REF");
    expect(previewPlainLuna("Supported [[N]](SANTO_", ids)).not.toContain("[[N]]");
  });

  it("recovers only verified single-bracket, spaced and three-digit citations", () => {
    const ids = Array.from({ length: 220 }, (_, index) => "amboss:verified-" + index);
    const draft = parsePlainLunaAnswer(
      "Pathophysiology [120]. Severity [[ 200 ]]. Management [[N]](SANTO_REF_220). " +
        "Untrusted [[221]] and [999].\n[1] This is a list, not a source.",
      ids,
    );
    expect(draft.citationIds).toEqual([ids[119], ids[199], ids[219]]);
    expect(draft.answer).toContain("Pathophysiology [1].");
    expect(draft.answer).toContain("Severity [2].");
    expect(draft.answer).toContain("Management [3].");
    expect(draft.answer).not.toContain("SANTO_REF_");
    expect(previewPlainLuna("Teaching [120] and [[200]]", ids)).not.toMatch(/\[120\]|\[\[200\]\]/);
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
    expect(payload.instructions).toContain(
      "Prefer a few distinct, clinically relevant original figures",
    );
    expect(payload.input).toContain("SANTO_REF_1");
    expect(payload.input).toContain("Cite SANTO_REF_10 as [[10]]");
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
