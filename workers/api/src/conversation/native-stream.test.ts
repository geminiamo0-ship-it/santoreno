import { describe, expect, it, vi } from "vitest";

import type { ConversationAnswer } from "@santo/contracts/conversation";
import { ConversationServiceError } from "./service";
import { streamProvisionalConversationAnswer } from "./native-stream";

const answer: ConversationAnswer = {
  requestId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  answer: "Verified evidence.",
  citations: [{ sourceId: "amboss:1", title: "AMBOSS", page: null }],
  usage: { unitsCharged: 1, remaining: 3 },
};

function events(
  raw: string,
): Array<{ type: string; text?: string; response?: unknown; code?: string }> {
  return raw
    .trim()
    .split("\n\n")
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error("missing SSE payload");
      return JSON.parse(data.slice(6)) as {
        type: string;
        text?: string;
        response?: unknown;
        code?: string;
      };
    });
}

describe("native provisional conversation SSE (staging only)", () => {
  it("sends the first provisional SSE event before the verified reply is ready", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      emit("First");
      await waiting; // Simulates a provider that keeps generating.
      emit("First word");
      return answer; // Persistence/citations are finished ONLY here.
    }, "delta");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const block = new TextDecoder().decode(first.value);
    expect(block).toContain('"type":"draft"');
    expect(block).toContain('"text":"First"');
    expect(block).not.toContain('"type":"complete"');
    finish();
    const rest: Uint8Array[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      rest.push(result.value);
    }
    const remainingText = rest.map((chunk) => new TextDecoder().decode(chunk)).join("");
    expect(remainingText).toContain('"type":"draft_delta"');
    expect(remainingText).toContain('"type":"complete"');
  });

  it("emits provisional text before source-verified persisted completion", async () => {
    const persist = vi.fn(async () => undefined);
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      emit("Unverified first tokens");
      emit("Unverified first tokens ... more");
      await persist();
      return answer;
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const frames = events(await stream.text());
    expect(frames.map((frame) => frame.type)).toEqual(["draft", "draft", "complete"]);
    expect(frames[0]).toEqual({ type: "draft", text: "Unverified first tokens" });
    expect(frames[2]?.response).toEqual(answer);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("fails after draft without ever emitting a forged verified complete", async () => {
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      emit("Not verified");
      throw new ConversationServiceError(502, "MODEL_FAILED");
    });
    const frames = events(await stream.text());
    expect(frames).toEqual([
      { type: "draft", text: "Not verified" },
      { type: "error", code: "MODEL_FAILED" },
    ]);
  });

  it("rejects invalid verified final payload and emits a safe error", async () => {
    const stream = streamProvisionalConversationAnswer(async () => ({
      ...answer,
      citations: [],
    }));
    const frames = events(await stream.text());
    expect(frames).toEqual([{ type: "error", code: "SANTO_UNAVAILABLE" }]);
  });

  it("streams 12k characters in true deltas without a fake replay", async () => {
    const final = "a".repeat(12000);
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      // Simulates provider emitting very small cumulative tokens.
      for (let length = 5; length <= final.length; length += 5) {
        emit(final.slice(0, length));
      }
      return { ...answer, answer: final };
    }, "delta");
    const raw = await stream.text();
    expect(new TextEncoder().encode(raw).length).toBeLessThan(300_000);
    const frames = events(raw);
    expect(frames[0]).toEqual({ type: "draft", text: "aaaaa" });
    expect(frames.some((event) => event.type === "draft_delta")).toBe(true);
    let preview = "";
    for (const event of frames) {
      if (event.type === "draft") preview = event.text ?? "";
      if (event.type === "draft_delta") preview += event.text ?? "";
    }
    expect(preview).toBe(final);
    expect(frames.at(-1)?.type).toBe("complete");
  });

  it("resets the delta stream when fallback withdraws its previous draft", async () => {
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      emit("first");
      emit("first half");
      emit("");
      emit("replacement");
      return answer;
    }, "delta");
    const frames = events(await stream.text());
    expect(frames.slice(0, 4)).toEqual([
      { type: "draft", text: "first" },
      { type: "draft_delta", text: " half" },
      { type: "draft", text: "" },
      { type: "draft", text: "replacement" },
    ]);
    expect(frames.at(-1)?.type).toBe("complete");
  });

  it("does not double-emit duplicate cumulative provider drafts", async () => {
    const stream = streamProvisionalConversationAnswer(async (emit) => {
      emit("same");
      emit("same");
      emit("");
      return answer;
    });
    expect(events(await stream.text()).map((event) => event.type)).toEqual([
      "draft",
      "draft",
      "complete",
    ]);
  });
});
