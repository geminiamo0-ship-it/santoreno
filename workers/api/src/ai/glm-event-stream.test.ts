import { describe, expect, it } from "vitest";
import { collectGlmEventStream } from "./glm-event-stream";

function chunks(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

function frame(data: unknown): string {
  return "data: " + JSON.stringify(data) + "\r\n\r\n";
}

const start = frame({
  choices: [{ delta: { reasoning_content: "Private model reasoning" }, finish_reason: null }],
});
const text = frame({
  choices: [{ delta: { content: "Valve obstruction [[1]]." }, finish_reason: null }],
});
const stop = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });

describe("GLM Workers AI Chat Completions SSE adapter", () => {
  it("emits only answer tokens and accepts stop + DONE across CRLF-split network chunks", async () => {
    const full = start + text + stop + "data: [DONE]\r\n\r\n";
    const raw = chunks([full.slice(0, 1), full.slice(1, 100), full.slice(100, 123), full.slice(123)]);
    const seen: string[] = [];
    const result = await collectGlmEventStream(raw, (delta) => seen.push(delta));
    expect(result).toBe("Valve obstruction [[1]].");
    expect(seen).toEqual(["Valve obstruction [[1]]."]);
    expect(seen.join("")).not.toContain("Private model reasoning");
  });

  it("never calls completion successful when provider ended without DONE", async () => {
    await expect(collectGlmEventStream(chunks([text + stop]), () => undefined)).rejects.toMatchObject({
      code: "MODEL_STREAM_UNFINISHED",
    });
  });

  it("never calls completion successful when DONE has no final stop", async () => {
    await expect(
      collectGlmEventStream(chunks([text + "data: [DONE]\n\n"]), () => undefined),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_UNFINISHED" });
  });

  it("rejects exhausted provider output instead of displaying partial medical answer", async () => {
    const truncated = frame({ choices: [{ delta: {}, finish_reason: "length" }] });
    await expect(
      collectGlmEventStream(chunks([text + truncated + "data: [DONE]\n\n"]), () => undefined),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
  });

  it("rejects provider error even when some provisional text was already received", async () => {
    await expect(
      collectGlmEventStream(chunks([text + frame({ error: { message: "provider error" } })]), () => undefined),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
  });
});
