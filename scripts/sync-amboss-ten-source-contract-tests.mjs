// One-time, guard-railed migration of three existing regression fixtures.
// The underlying schemas and retrieval implementation are edited separately.
// Idempotent, and fails rather than silently changing unexpected source text.
import { readFileSync, writeFileSync } from "node:fs";

const changes = [
  {
    path: "workers/api/src/ai/prompt.test.ts",
    old: 'buildGroundedPrompt("test", Array(9).fill(evidence))',
    next: 'buildGroundedPrompt("test", Array(16).fill(evidence))',
  },
  {
    path: "packages/contracts/src/ai.test.ts",
    old: "accepts eight verified cited sources and rejects nine",
    next: "accepts fifteen verified cited sources and rejects sixteen",
  },
  {
    path: "packages/contracts/src/ai.test.ts",
    old: "Array.from({ length: 8 },",
    next: "Array.from({ length: 15 },",
  },
  {
    path: "workers/api/src/ai/plain-luna.ts",
    old: "citation markers [[1]] through [[8]]",
    next: "citation markers [[1]] through [[15]]",
  },
];
for (const change of changes) {
  const current = readFileSync(change.path, "utf8");
  if (current.includes(change.next) && !current.includes(change.old)) continue;
  if (!current.includes(change.old)) {
    throw new Error("Fixture drift: " + change.path + " missing anchor");
  }
  writeFileSync(change.path, current.replace(change.old, change.next));
}
