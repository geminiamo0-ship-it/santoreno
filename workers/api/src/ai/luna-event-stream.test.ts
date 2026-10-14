import { describe, expect, it, vi } from "vitest";

import { GroundedAiError } from "./errors";
import { collectLunaEventStream, previewStructuredAnswer } from "./luna-event-stream";

function sse(events: unknown[], split = 24): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("");
  const bytes = encoder.encode(frames);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + split));
      offset += split;
    },
  });
}

describe("native Luna Responses SSE collector", () => {
  it("shows only a plain answer draft as providers emit chunks, then returns full JSON", async () => {
    const output = '{"answer":"Atrial flutter 🫀: sawtooth waves","citation_ids":["s1"]}';
    const events = [
      { type: "response.created" },
      ...Array.from({ length: Math.ceil(output.length / 7) }, (_, index) => ({
        type: "response.output_text.delta",
        delta: output.slice(index * 7, index * 7 + 7),
      })),
      { type: "response.completed" },
    ];
    const progress = vi.fn();
    await expect(collectLunaEventStream(sse(events), progress)).resolves.toBe(output);
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls.at(-1)?.[0]).toBe("Atrial flutter 🫀: sawtooth waves");
    for (const [draft] of progress.mock.calls) {
      expect(String(draft)).not.toContain("citation_ids");
      expect(String(draft)).not.toContain("s1");
    }
  });

  it("does not expose provider citations or unparsed JSON as a preview", () => {
    expect(previewStructuredAnswer('{"citation_ids":["s1"]}')).toBe("");
    expect(previewStructuredAnswer('{"answer":"Hello')).toBe("Hello");
    expect(previewStructuredAnswer('{"answer":"Hello\\u')).toBe("Hello");
  });

  it("fails closed when stream ends without a completed event", async () => {
    const progress = vi.fn();
    await expect(
      collectLunaEventStream(
        sse([{ type: "response.output_text.delta", delta: '{"answer":"draft"}' }]),
        progress,
      ),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  });

  it("maps explicit provider error to a stable code", async () => {
    await expect(
      collectLunaEventStream(
        sse([{ type: "response.failed", response: { error: { message: "token" } } }]),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
  });

  it("does not print provider secret details in error responses", () => {
    const error = new GroundedAiError(502, "MODEL_FAILED", "Provider streaming request failed");
    expect(error.message).not.toContain("token");
  });
});
