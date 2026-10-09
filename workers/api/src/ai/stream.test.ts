import {
  GroundedAiStreamEventSchema,
  type GroundedAiQueryResponse,
  type GroundedAiStreamEvent,
} from "@santo/contracts/ai";
import { describe, expect, it } from "vitest";

import { streamValidatedGroundedAnswer } from "./stream";

const response: GroundedAiQueryResponse = {
  requestId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  answer: "Grounded answer 🫀 ".repeat(60),
  citations: [{ sourceId: "mrcp:chapter-1", title: "Chapter 1", page: 1 }],
  usage: { unitsCharged: 1, remaining: 4 },
};

describe("validated SSE response delivery", () => {
  it("streams ordered Unicode-safe deltas followed by a validated complete response", async () => {
    const result = streamValidatedGroundedAnswer(response);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.headers.get("cache-control")).toBe("no-store");

    const blocks = (await result.text()).trim().split("\n\n");
    const events: GroundedAiStreamEvent[] = blocks.map((block) => {
      const [name, payload] = block.split("\n");
      const parsed = GroundedAiStreamEventSchema.parse(JSON.parse(payload.slice("data: ".length)));
      expect(name).toBe("event: " + parsed.type);
      return parsed;
    });
    const deltas = events.slice(0, -1);
    expect(deltas.length).toBeGreaterThan(2);
    expect(deltas.every((event) => event.type === "delta")).toBe(true);
    expect(deltas.map((event) => (event.type === "delta" ? event.index : -1))).toEqual(
      deltas.map((_, index) => index),
    );
    expect(deltas.map((event) => (event.type === "delta" ? event.text : "")).join("")).toBe(
      response.answer,
    );
    expect(events.at(-1)).toEqual({ type: "complete", response });
    expect(blocks.slice(0, -1).join("\n")).not.toContain("citation");
  });

  it("refuses to stream an unvalidated answer contract", () => {
    expect(() => streamValidatedGroundedAnswer({ ...response, citations: [] })).toThrow();
  });
});
