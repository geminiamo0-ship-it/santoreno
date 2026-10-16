import process from "node:process";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Missing test Workers AI credentials");
const model = "@cf/ibm-granite/granite-4.0-h-micro";
const prompt =
  "Rewrite the latest medical question into ONE concise English library search query using the resolved topic for follow-ups; preserve diagnosis, intent, negation and clinical qualifiers, never add unrelated diseases or treatments, and output ONLY the query.";
const tests = [
  {
    name: "Aortic stenosis follow-up",
    student: "management",
    focused: "management and treatment of aortic stenosis",
    required: [/aortic/i, /stenosis/i],
    forbidden: [/familial/i, /\bfmf\b/i],
  },
  {
    name: "New FMF topic",
    student: "Familial Mediterranean fever",
    focused: "Familial Mediterranean fever",
    required: [/familial/i, /mediterranean/i, /fever/i],
    forbidden: [/aortic/i],
  },
  {
    name: "Preserve severity and symptoms",
    student: "management of severe asymptomatic aortic stenosis",
    focused: "management of severe asymptomatic aortic stenosis",
    required: [/aortic/i, /stenosis/i, /severe/i, /asymptomatic/i],
    forbidden: [/familial/i],
  },
];
for (const test of tests) {
  const started = Date.now();
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(account) +
      "/ai/run/" + model,
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content:
              "Latest student question: " + test.student +
              "\nResolved medical topic and clinical intent: " + test.focused,
          },
        ],
        temperature: 0,
        max_tokens: 64,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error("Granite API failed: HTTP " + response.status);
  const payload = await response.json();
  if (payload.success === false) throw new Error("Workers AI inference rejected");
  const result = payload.result;
  if (typeof result !== "object" || result === null || typeof result.response !== "string" || result.response.length === 0) {
    console.log("Granite output shape (synthetic test only): " + JSON.stringify({
      outerKeys: Object.keys(payload),
      resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
      resultSample: JSON.stringify(result).slice(0, 600),
    }));
  }
  const answer = String(result?.response ?? "");
  const passes = test.required.every((term) => term.test(answer)) &&
    test.forbidden.every((term) => !term.test(answer));
  console.log(test.name + " | matched clinical intent: " + passes +
    " | latency: " + (Date.now() - started) + "ms" +
    " | length: " + answer.length + " characters");
  if (!passes) throw new Error("Granite query failed clinical anchor smoke: " + test.name);
}
console.log("Granite small-model smoke passed (three queries; no student data or citations).");
