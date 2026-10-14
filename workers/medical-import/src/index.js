/* Temporary, authenticated Cloudflare R2 batch-ingest gateway.
 * This separate Worker is staging-only, bound only to santo-content-staging.
 * No public GET objects; token stays in GitHub Actions / Worker secret, not Git.
 */
const LIBS = "(?:amboss|usmle|passmedicine|pastest|one-examination)";
const ARTICLE = new RegExp("^medical-articles/v1/" + LIBS + "/[a-z0-9-]{1,90}\\.json$");
const SEARCH = new RegExp("^medical-search/v1/" + LIBS + "/[a-z0-9-]{1,90}/s-[0-9]{4}\\.md$");
const CATALOG = /^medical-library-catalog\/v1\/(?:catalog|amboss|usmle|passmedicine|pastest|one-examination)\.json$/;
const MAX_BODY = 3_600_000;
const MAX_FILE = 2_000_000;
const MAX_ITEMS = 20;

function allowedKey(key) {
  return typeof key === "string" && key.length <= 200 &&
    (ARTICLE.test(key) || SEARCH.test(key) || CATALOG.test(key));
}
function validToken(given, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (typeof given !== "string") return false;
  const prefix = "Bearer ";
  const user = given.startsWith(prefix) ? given.slice(prefix.length) : "";
  if (!/^[a-f0-9]{64}$/.test(user)) return false;
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= user.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
function respond(payload, status) {
  return Response.json(payload, { status, headers: {
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"
  }});
}
async function decodeBase64(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_FILE * 4 / 3) + 4 ||
      !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) throw Error("INVALID_BODY");
  const bin = atob(value);
  if (bin.length > MAX_FILE) throw Error("INVALID_BODY");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!validToken(request.headers.get("authorization"), env.SANTO_IMPORT_TOKEN)) {
      return respond({ error: "UNAUTHORIZED" }, 401);
    }
    if (!env.CONTENT_BUCKET) return respond({ error: "R2_UNAVAILABLE" }, 503);
    if (request.method === "GET" && url.pathname === "/verify") {
      const key = url.searchParams.get("key");
      if (!allowedKey(key)) return respond({ error: "INVALID_KEY" }, 400);
      try {
        const item = await env.CONTENT_BUCKET.get(key);
        if (!item) return respond({ error: "MISSING_OBJECT" }, 404);
        const bytes = await item.arrayBuffer();
        if (bytes.byteLength > MAX_FILE) return respond({ error: "INVALID_SIZE" }, 502);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
        return respond({ key, sha256: hash, size: bytes.byteLength }, 200);
      } catch {
        return respond({ error: "R2_VERIFY_FAILED" }, 503);
      }
    }
    if (request.method !== "POST" || url.pathname !== "/batch") {
      return respond({ error: "NOT_FOUND" }, 404);
    }
    const length = Number(request.headers.get("content-length"));
    if (length > MAX_BODY) return respond({ error: "PAYLOAD_TOO_LARGE" }, 413);
    let entries;
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_BODY) throw Error("PAYLOAD_TOO_LARGE");
      const body = JSON.parse(new TextDecoder().decode(buffer));
      if (!body || !Array.isArray(body.files) || !body.files.length ||
          body.files.length > MAX_ITEMS) throw Error("INVALID_BODY");
      if (new Set(body.files.map(x => x?.key)).size !== body.files.length) throw Error("INVALID_KEY");
      entries = await Promise.all(body.files.map(async (file) => {
        if (!allowedKey(file?.key)) throw Error("INVALID_KEY");
        return {
          key: file.key,
          body: await decodeBase64(file.body)
        };
      }));
    } catch {
      return respond({ error: "INVALID_BATCH" }, 400);
    }
    const results = await Promise.allSettled(entries.map(async ({key,body}) => {
      await env.CONTENT_BUCKET.put(key, body, {httpMetadata: {
        contentType: key.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
        cacheControl: "private, no-store"
      }});
      return key;
    }));
    const uploaded = [], failed = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") uploaded.push(entries[i].key);
      else failed.push(entries[i].key);
    }
    return respond({ uploaded, failed }, failed.length ? 207 : 200);
  },
};
