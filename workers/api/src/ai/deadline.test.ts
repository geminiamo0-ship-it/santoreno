import { describe, expect, it, vi } from "vitest";

import { withAiDeadline } from "./deadline";

describe("bounded AI operations", () => {
  it("returns successful work without changing its result", async () => {
    await expect(
      withAiDeadline(async () => "complete", undefined, 1000, "MODEL_TIMEOUT"),
    ).resolves.toBe("complete");
  });

  it("does not begin work for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => "should not run");
    await expect(
      withAiDeadline(work, controller.signal, 1000, "MODEL_TIMEOUT"),
    ).rejects.toMatchObject({ status: 499, code: "REQUEST_CANCELLED" });
    expect(work).not.toHaveBeenCalled();
  });

  it("times out an unresolved operation, ignoring late output", async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: string) => void = () => {};
      const work = () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        });
      const pending = withAiDeadline(work, undefined, 10, "MODEL_TIMEOUT");
      const observed = pending.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await observed).toMatchObject({ status: 504, code: "MODEL_TIMEOUT" });
      finish("late content");
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels work before its deadline and ignores a late completion", async () => {
    const controller = new AbortController();
    let finish: (value: string) => void = () => {};
    const pending = withAiDeadline(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      controller.signal,
      1000,
      "SEARCH_TIMEOUT",
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499, code: "REQUEST_CANCELLED" });
    finish("too late");
  });
});
