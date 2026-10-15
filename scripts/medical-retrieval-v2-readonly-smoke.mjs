import process from "node:process";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) {
  throw new Error("Cloudflare credentials are required for a read-only search smoke");
}

const instances = ["amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated"];
const cases = [
  {
    name: "Aortic stenosis mechanism",
    query: "aortic stenosis pathophysiology",
    expected: /aortic\s+stenosis/i,
    wrongTopic: /familial\s+mediterranean\s+fever|\bFMF\b/i,
  },
  {
    name: "Familial Mediterranean fever",
    query: "Familial Mediterranean fever",
    expected: /familial\s+mediterranean\s+fever|\bFMF\b/i,
    wrongTopic: /aortic\s+stenosis/i,
  },
];

async function readOnlySearch(index, query, v2) {
  const path = [
    "https://api.cloudflare.com/client/v4/accounts",
    encodeURIComponent(accountId),
    "ai-search/namespaces/default/instances",
    encodeURIComponent(index),
    "search",
  ].join("/");
  const started = Date.now();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          match_threshold: 0.4,
          max_num_results: v2 ? 24 : 3,
        },
        ...(v2
          ? { reranking: { enabled: true, model: "@cf/baai/bge-reranker-base" } }
          : {}),
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  // Deliberately do not print response body (may include licensed source content).
  if (!response.ok) throw new Error("Cloudflare search failed HTTP " + response.status);
  const body = await response.json();
  if (body?.success === false || !Array.isArray(body?.result?.chunks)) {
    throw new Error("Cloudflare search returned invalid chunks structure");
  }
  return { chunks: body.result.chunks, elapsed: Date.now() - started };
}

function summarize(chunks, test) {
  const matches = chunks.map((part) => {
    const text = [part.item?.metadata?.title ?? "", part.text ?? ""].join(" ");
    return {
      relevant: test.expected.test(text),
      wrongTopic: test.wrongTopic.test(text),
    };
  });
  return {
    returned: matches.length,
    relevantTop3: matches.slice(0, 3).filter((part) => part.relevant).length,
    relevantAll: matches.filter((part) => part.relevant).length,
    wrongTopicAll: matches.filter((part) => part.wrongTopic).length,
  };
}

const output = [
  "# Cloudflare Medical Retrieval v2 — read-only smoke",
  "",
  "Only two synthetic medical queries were checked. These are **not** clinical gold labels, source accuracy, or a proven improvement.",
  "",
  "| Query | Mode | Returned | Matching top 3 | Matching all | Wrong-topic chunks | Mean API latency |",
  "|---|---|---:|---:|---:|---:|---:|",
];
for (const test of cases) {
  for (const v2 of [false, true]) {
    const results = await Promise.all(
      instances.map((instance) => readOnlySearch(instance, test.query, v2)),
    );
    const all = results.flatMap((result) => result.chunks);
    const stat = summarize(all, test);
    const mean = Math.round(
      results.reduce((sum, result) => sum + result.elapsed, 0) / instances.length,
    );
    output.push(
      "| " +
        test.name +
        " | " +
        (v2 ? "wider native rerank" : "legacy top-3") +
        " | " +
        stat.returned +
        " | " +
        stat.relevantTop3 +
        " | " +
        stat.relevantAll +
        " | " +
        stat.wrongTopicAll +
        " | " +
        mean +
        "ms |",
    );
  }
}
output.push(
  "",
  "Read-only: 20 AI Search calls. Zero Luna calls; no source identifiers or licensed text logged; no index mutations.",
);
const summary = output.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
process.stdout.write("Read-only Cloudflare search smoke completed for 2 topics across 5 allowed instances.\n");
