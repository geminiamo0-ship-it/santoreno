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

  it("parses actual provider CRLF SSE even with CR and LF split across every network byte", async () => {
    const payload =
      '{"answer":"Valve obstruction causes LV pressure overload.","citation_ids":["amboss:1"]}';
    const raw = [
      { type: "response.created" },
      ...Array.from({ length: Math.ceil(payload.length / 9) }, (_, i) => ({
        type: "response.output_text.delta",
        delta: payload.slice(i * 9, i * 9 + 9),
      })),
      { type: "response.completed", response: { status: "completed" } },
    ]
      .map((value) => "event: " + value.type + "\r\ndata:" + JSON.stringify(value) + "\r\n\r\n")
      .join("");
    const bytes = new TextEncoder().encode(raw);
    let cursor = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(cursor, cursor + 1));
        cursor++;
      },
    });
    const progress = vi.fn();
    await expect(collectLunaEventStream(stream, progress)).resolves.toBe(payload);
    expect(progress.mock.calls.at(-1)?.[0]).toBe("Valve obstruction causes LV pressure overload.");
  });

  it("adopts a canonical completed JSON text from the same paid response, not a new model call", async () => {
    const full = '{"answer":"Evidence-based management.","citation_ids":["s1"]}';
    const events = [
      { type: "response.output_text.delta", delta: '{"answer":"Evidence' },
      { type: "response.output_text.done", text: full },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: full }] }],
        },
      },
    ];
    await expect(collectLunaEventStream(sse(events), vi.fn())).resolves.toBe(full);
  });

  it("recovers actual completed Markdown deltas if the provider sends empty final fields", async () => {
    const clinicalText =
      "## Aortic stenosis\\nValve narrowing causes LV pressure overload.\\nManagement depends on severity.";
    const events = [
      { type: "response.output_text.delta", delta: clinicalText },
      { type: "response.output_text.done", text: "" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output_text: "",
          output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
        },
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(collectLunaEventStream(sse(events), vi.fn(), "plain")).resolves.toBe(
        clinicalText,
      );
      expect(warn).not.toHaveBeenCalledWith(
        "santo_luna_stream_failure",
        expect.objectContaining({ stage: "completed_delta_missing_json_end" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still fails if completion is missing, even when the final text is blank", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "Potential clinical answer." },
      { type: "response.output_text.done", text: "" },
    ];
    await expect(collectLunaEventStream(sse(events), vi.fn(), "plain")).rejects.toMatchObject({
      code: "MODEL_STREAM_UNFINISHED",
    });
  });

  it("rejects a provider response declared incomplete even when it contains plausible clinical text", async () => {
    const events = [
      { type: "response.output_text.delta", delta: '{"answer":"partial"}' },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ];
    await expect(collectLunaEventStream(sse(events), vi.fn())).rejects.toMatchObject({
      code: "MODEL_OUTPUT_TRUNCATED",
    });
  });

  it("does not validate a completed event whose response explicitly says it is incomplete", async () => {
    await expect(
      collectLunaEventStream(
        sse([
          { type: "response.output_text.delta", delta: '{"answer":"unfinished"}' },
          { type: "response.completed", response: { status: "incomplete" } },
        ]),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_INCOMPLETE" });
  });

  it("fails closed when stream ends without a completed event", async () => {
    const progress = vi.fn();
    await expect(
      collectLunaEventStream(
        sse([{ type: "response.output_text.delta", delta: '{"answer":"draft"}' }]),
        progress,
      ),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_UNFINISHED" });
  });

  it("maps explicit provider error to a stable code", async () => {
    await expect(
      collectLunaEventStream(
        sse([{ type: "response.failed", response: { error: { message: "token" } } }]),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_FAILED" });
  });

  it("records a token-limit failure without exposing medical content or sources", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        collectLunaEventStream(
          sse([
            { type: "response.output_text.delta", delta: '{"answer":"Clinical text' },
            {
              type: "response.incomplete",
              response: {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
              },
            },
          ]),
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED" });
      expect(warn).toHaveBeenCalledWith(
        "santo_luna_stream_failure",
        expect.objectContaining({
          stage: "max_output_tokens",
          outputChars: 24,
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Clinical text");
    } finally {
      warn.mockRestore();
    }
  });

  it("distinguishes provider incompletion from interrupted SSE", async () => {
    await expect(
      collectLunaEventStream(
        sse([
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
            },
          },
        ]),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_INCOMPLETE" });
    await expect(
      collectLunaEventStream(
        sse([{ type: "response.output_text.delta", delta: '{"answer":"preview"}' }]),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_UNFINISHED" });
  });

  it("does not print provider secret details in error responses", () => {
    const error = new GroundedAiError(502, "MODEL_FAILED", "Provider streaming request failed");
    expect(error.message).not.toContain("token");
  });
});
