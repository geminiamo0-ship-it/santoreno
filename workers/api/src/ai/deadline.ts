import { GroundedAiError } from "./errors";

export const AI_STAGE_TIMEOUTS = {
  retrievalMs: 15_000,
  modelMs: 90_000,
} as const;

type DeadlineCode = "SEARCH_TIMEOUT" | "MODEL_TIMEOUT";

export function withAiDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  code: DeadlineCode,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new GroundedAiError(499, "REQUEST_CANCELLED", "Request was cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancel = () =>
      finish(() =>
        reject(new GroundedAiError(499, "REQUEST_CANCELLED", "Request was cancelled")),
      );
    const timer = setTimeout(
      () => finish(() => reject(new GroundedAiError(504, code, "AI operation timed out"))),
      timeoutMs,
    );

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      action();
    }

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }

    Promise.resolve()
      .then(() => {
        if (settled) return undefined;
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value as T)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
