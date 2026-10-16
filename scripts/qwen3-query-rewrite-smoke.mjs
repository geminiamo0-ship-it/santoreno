import process from "node:process";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Missing Workers AI smoke credentials");

const model = "@cf/qwen/qwen3-30b-a3b-fp8";
const system =
  "You are a medical-search query normalizer. Translate Arabic medical questions into precise English; repair spelling, expand clear abbreviations, and keep the latest disease, management/diagnosis intent, negation, severity, population and timing. For follow-ups use ONLY the supplied resolved topic. Never introduce unrelated diagnoses or treatments. Output ONE compact English search query (prefer under 25 words), no explanation, list, tags, or JSON. /no_think";
const cases = [
  { name: "Aortic follow-up", latest: "management",
    focused: "management and treatment of aortic stenosis",
    required: [/aortic/i, /stenosis/i, /(?:management|treatment|therapy)/i],
    forbidden: [/familial/i, /\bfmf\b/i] },
  { name: "New FMF disease", latest: "Familial Mediterranean fever",
    focused: "Familial Mediterranean fever",
    required: [/familial/i, /mediterranean/i, /fever/i], forbidden: [/aortic/i] },
  { name: "Severe asymptomatic qualifier", latest: "management severe asymptomatic aortic stenosis",
    focused: "management severe asymptomatic aortic stenosis",
    required: [/aortic/i, /stenosis/i, /severe/i, /asymptomatic/i], forbidden: [/familial/i] },
  { name: "Arabic medical translation", latest: "علاج ضيق الصمام الأورطي",
    focused: "علاج ضيق الصمام الأورطي",
    required: [/aortic/i, /stenosis/i, /(?:management|treatment|therapy)/i], forbidden: [/\p{Script=Arabic}/u] },
  { name: "Medical typo correction", latest: "aortic stnosis treatment",
    focused: "aortic stnosis treatment",
    required: [/aortic/i, /stenosis/i, /(?:management|treatment|therapy)/i], forbidden: [/stnosis/i] },
];

for (const item of cases) {
  const started = Date.now();
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" +
      encodeURIComponent(account) + "/ai/run/" + model,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Latest student question: " + item.latest +
              "\nResolved medical topic and clinical intent: " + item.focused },
        ],
        temperature: 0.4, top_p: 0.8, max_tokens: 512, stream: false,
      }),
      signal: AbortSignal.timeout(18000),
    },
  );
  if (!response.ok) throw new Error("Qwen Workers AI request failed (HTTP " + response.status + ")");
  const payload = await response.json();
  if (payload.success === false) throw new Error("Qwen Workers AI rejected inference");
  const raw = String(payload.result?.choices?.[0]?.message?.content ?? payload.result?.response ?? "");
  const candidate = raw.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
  const success =
    candidate.length >= 3 && candidate.length <= 220 &&
    !/[\n\r{}<>]/.test(candidate) &&
    item.required.every((re) => re.test(candidate)) &&
    item.forbidden.every((re) => !re.test(candidate));
  const latencyMs = Date.now() - started;
  console.log(item.name + " | clinical search query passed=" + success +
    " | time_ms=" + latencyMs + " | chars=" + candidate.length);
  if (!success) {
    throw new Error("Qwen multilingual query normalizer failed expected clinical qualifiers: " + item.name);
  }
}
console.log("Qwen3 bilingual/typo clinical rewrite live smoke PASS (5 synthetic cases).");
