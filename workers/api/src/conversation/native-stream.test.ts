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
