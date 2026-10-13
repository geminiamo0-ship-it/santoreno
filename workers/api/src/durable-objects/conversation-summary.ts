/**
 * Deterministic, extractive memory of completed (already grounded and validated)
 * conversation turns. No additional model summarizer, fabricated citations,
 * or unbounded history are introduced by this policy.
 */
export const SUMMARY_MAX_CHARS = 1200;
const QUESTION_CHARS = 90;
const ANSWER_CHARS = 155;
const SUMMARY_MARKER = "Q:";

function compact(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function appendVerifiedTurnSummary(
  previous: string,
  question: string,
  verifiedAnswer: string,
): string {
  const entry = `Q: ${compact(question, QUESTION_CHARS)} | Verified A: ${compact(verifiedAnswer, ANSWER_CHARS)}`;
  const segments = previous
    .split("\n")
    .filter((line) => line.startsWith(SUMMARY_MARKER) && line.length <= 270);
  segments.push(entry);
  while (segments.length > 1 && segments.join("\n").length > SUMMARY_MAX_CHARS) {
    segments.shift();
  }
  return segments.join("\n").slice(0, SUMMARY_MAX_CHARS);
}
