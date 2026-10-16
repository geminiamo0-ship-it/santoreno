import process from "node:process";
import { appendFile } from "node:fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) throw new Error("Missing read-only Cloudflare AI Search credentials");

const instances = ["amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated"];
const trials = [
  {
    label: "Aortic stenosis management",
    original: "management and treatment of aortic stenosis",
    expanded: "management and treatment of aortic stenosis aortic valve stenosis",
    expected: /aortic\s+(?:valve\s+)?stenosis/i,
    wrong: /familial mediterranean fever|recurrent polyserositis|\bfmf\b/i,
  },
  {
    label: "FMF management",
    original: "management and treatment of fmf",
    expanded: "management and treatment of fmf familial mediterranean fever",
    expected: /familial mediterranean fever|recurrent polyserositis|\bfmf\b/i,
    wrong: /aortic\s+(?:valve\s+)?stenosis/i,
  },
];

async function search(instance, query, expanded) {
  const endpoint = [
    "https://api.cloudflare.com/client/v4/accounts",
    encodeURIComponent(accountId),
    "ai-search/namespaces/default/instances",
    encodeURIComponent(instance),
    "search",
  ].join("/");
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          match_threshold: 0.4,
          max_num_results: 24,
          fusion_method: "rrf",
          ...(expanded ? { keyword_match_mode: "or" } : {}),
        },
        reranking: { enabled: true, model: "@cf/baai/bge-reranker-base" },
        query_rewrite: { enabled: false },
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error("Cloudflare AI Search HTTP " + response.status);
  const json = await response.json();
  if (json?.success === false || !Array.isArray(json?.result?.chunks)) {
    throw new Error("Cloudflare AI Search returned invalid chunks");
  }
  return { chunks: json.result.chunks, durationMs: Date.now() - started };
}

function report(chunks, test) {
  const matches = chunks.map((item) => {
    // Raw source text is accessed only in-process for aggregate metrics.
    const text = [item.item?.metadata?.title ?? "", item.text ?? ""].join(" ");
    return { relevant: test.expected.test(text), wrong: test.wrong.test(text) };
  });
  return {
    returned: matches.length,
    relevantTop3: matches.slice(0, 3).filter((item) => item.relevant).length,
    relevantAll: matches.filter((item) => item.relevant).length,
    wrongTopic: matches.filter((item) => item.wrong).length,
  };
}

const lines = [
  "## MeSH Medical Query Expansion — Staging A/B",
  "",
  "Read-only experiment on the two pilot concepts. Text matches are **lexical proxies**, not clinician relevance gold labels; no student conversation, Luna generation, or verified citations were evaluated.",
  "",
  "| Topic | Version | Returned | Relevant top-3 per index (aggregate) | Relevant all | Wrong-topic mentions | Avg API latency |",
  "|---|---|---:|---:|---:|---:|---:|",
];
let callCount = 0;
for (const test of trials) {
  for (const expanded of [false, true]) {
    const results = await Promise.all(
      instances.map((instance) => search(instance, expanded ? test.expanded : test.original, expanded)),
    );
    callCount += results.length;
    const totals = results.map((result) => report(result.chunks, test)).reduce(
      (sum, current) => ({
        returned: sum.returned + current.returned,
        relevantTop3: sum.relevantTop3 + current.relevantTop3,
        relevantAll: sum.relevantAll + current.relevantAll,
        wrongTopic: sum.wrongTopic + current.wrongTopic,
      }),
      { returned: 0, relevantTop3: 0, relevantAll: 0, wrongTopic: 0 },
    );
    const mean = Math.round(results.reduce((sum, value) => sum + value.durationMs, 0) / results.length);
    lines.push(
      "| " + test.label + " | " + (expanded ? "MeSH expansion" : "baseline") +
      " | " + totals.returned + " | " + totals.relevantTop3 +
      " | " + totals.relevantAll + " | " + totals.wrongTopic +
      " | " + mean + "ms |",
    );
  }
}
lines.push("", "Cloudflare AI Search calls in this A/B test: " + callCount + ". Zero Luna calls. No index changes or licensed text printed. A real clinical gold set is still required.", "");
const output = lines.join("\n");
process.stdout.write(output);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output);
