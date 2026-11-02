// Dedicated med2 assets are uploaded by its own GitHub Actions job using OIDC.
// This Worker has no credentials and no bindings to any other project.
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "med2-anatomy-upload-v1";
const ALLOWED_WORKFLOWS = new Set(["geminiamo0-ship-it/med2/.github/workflows/deploy-r2.yml@refs/heads/main", "geminiamo0-ship-it/med2/.github/workflows/optimize-skull-presentations.yml@refs/heads/main"]);
let jwksCache = null;
let manifestCache = null;

function unbase64(value) {
  const raw = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")), c => c.charCodeAt(0));
}
async function authorizeGithubOidc(request) {
  const raw = request.headers.get("Authorization") || "";
  if (!raw.startsWith("Bearer ")) return false;
  const jwt = raw.slice(7);
  const parts = jwt.split(".");
  if (parts.length !== 3 || jwt.length > 12000) return false;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unbase64(parts[1])));
  } catch { return false; }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
  if (claims.iss !== OIDC_ISSUER || claims.aud !== OIDC_AUDIENCE) return false;
  if (claims.repository !== "geminiamo0-ship-it/med2" ||
      String(claims.repository_id) !== "1256497156" ||
      String(claims.repository_owner_id) !== "250896197" ||
      claims.ref !== "refs/heads/main" ||
      ![
        "repo:geminiamo0-ship-it/med2:ref:refs/heads/main",
        "repo:geminiamo0-ship-it@250896197/med2@1256497156:ref:refs/heads/main"
      ].includes(claims.sub) ||
      !ALLOWED_WORKFLOWS.has(claims.workflow_ref)) return false;
  if (!Number.isFinite(claims.exp) || claims.exp < now ||
      !Number.isFinite(claims.nbf) && claims.nbf !== undefined ||
      (claims.nbf !== undefined && claims.nbf > now + 30) ||
      !Number.isFinite(claims.iat) || claims.iat > now + 30 ||
      now - claims.iat > 600) return false;
  if (!jwksCache || jwksCache.expires < Date.now()) {
    const response = await fetch(OIDC_ISSUER + "/.well-known/jwks");
    if (!response.ok) return false;
    jwksCache = {data: await response.json(), expires: Date.now() + 300000};
  }
  const jwk = jwksCache.data.keys.find(k => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unbase64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return false; }
}
async function upload(request, env) {
  if (!await authorizeGithubOidc(request)) return new Response("Unauthorized", {status: 401});
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/__upload/" + VERSION + "/")) return new Response("Bad upload path", {status: 400});
  const path = pathname.slice(("/__upload/" + VERSION + "/").length);
  if (!path || path.includes("..") || path.includes("//") || path.includes("\\") ||
      /%2f|%5c|%00|%2e/i.test(path)) return new Response("Bad upload key", {status: 400});
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > 25 * 1024 * 1024) return new Response("Invalid content length", {status: 413});
  if (!request.body) return new Response("Missing body", {status: 400});
  const key = VERSION + "/" + path;
  await env.ASSETS.put(key, request.body, {httpMetadata: {contentType: typeOf(path)}});
  manifestCache = null;
  return new Response(JSON.stringify({ok:true}), {status: 201, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
}
async function loadSplitManifest(env) {
  if (manifestCache && manifestCache.expires > Date.now()) return manifestCache.data;
  const blob = await env.ASSETS.get(VERSION + "/__large_files.json");
  if (!blob) return {};
  const data = JSON.parse(await blob.text());
  manifestCache = {data, expires: Date.now() + 60000};
  return data;
}


let gzipManifestCache = null;
async function getGzipManifest(env) {
  if (gzipManifestCache && gzipManifestCache.expires > Date.now()) return gzipManifestCache.data;
  const obj = await env.ASSETS.get("202510141308/__gzip_files.json");
  if (!obj) return {};
  const data = JSON.parse(await obj.text());
  gzipManifestCache = {data, expires:Date.now()+60000};
  return data;
}
async function maybeGzipAsset(env, request, path) {
  if (!path.endsWith(".oex") && !path.endsWith(".xbin")) return null;
  // Lossless gzip was verified byte-identical to the original R2 geometry and
  // presentation assets. Make it the browser default, retain cookie opt-out
  // and always use raw identity for Range or clients without gzip support.
  if (request.headers.has("Range") ||
      !/\bgzip\b/i.test(request.headers.get("Accept-Encoding") || "") ||
      /(?:^|;\s*)med2_mesh_gzip=0(?:;|$)/.test(request.headers.get("Cookie") || "")) return null;
  const manifest = await getGzipManifest(env);
  const spec = manifest[path];
  if (!spec || !Array.isArray(spec.pieces) || !spec.pieces.length) return null;
  const asset = await chunked(env, request.method, path, spec.pieces, null);
  if (asset.status !== 200) return asset;
  const headers = new Headers(asset.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Vary", "Accept-Encoding, Cookie");
  headers.set("X-Med2-Encoded-Transport", "gzip-lossless");
  headers.delete("Accept-Ranges");
  return new Response(asset.body, {status:200, headers, encodeBody:"manual"});
}


const VERSION = "202510141308";
const BUCKET_PREFIX = VERSION + "/";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".dat": "application/octet-stream", ".dds": "image/vnd-ms.dds",
  ".xbin": "application/octet-stream", ".oex": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".mp4": "video/mp4", ".ico": "image/x-icon",
};
function typeOf(path) {
  const ext = path.match(/(\.[a-z0-9]+)$/i);
  return ext ? (MIME[ext[1].toLowerCase()] || "application/octet-stream") : "application/octet-stream";
}
function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return {start, end: Math.min(end, size - 1), partial: true};
}
function baseHeaders(path, length) {
  const html = path.endsWith(".html");
  return {
    "Content-Type": typeOf(path),
    "Content-Length": String(length),
    "Cache-Control": html ? "no-store" : "public, max-age=604800",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Accept-Ranges": "bytes"
  };
}
function filePath(request) {
  const pathname = new URL(request.url).pathname;
  if (/%2f|%5c|%00|%2e/i.test(pathname)) return null;
  let path;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  if (path.includes("\\") || path.split("/").some(x => x === "." || x === "..")) return null;
  path = path.replace(/^\/+/, "");
  if (!path || path === VERSION || path === VERSION + "/") path = "index.html";
  if (path.startsWith(BUCKET_PREFIX)) path = path.slice(BUCKET_PREFIX.length);
  if (path.startsWith("/") || path.includes("//") || !path) return null;
  return path;
}
async function chunked(env, method, path, pieces, rangeHeader) {
  const size = pieces.reduce((a, p) => a + p.size, 0);
  const r = parseRange(rangeHeader, size);
  if (!r) return new Response(null, {status: 416, headers: {"Content-Range": "bytes */" + size}});
  const h = baseHeaders(path, r.end - r.start + 1);
  if (r.partial) h["Content-Range"] = "bytes " + r.start + "-" + r.end + "/" + size;
  if (method === "HEAD") return new Response(null, {status: r.partial ? 206 : 200, headers: h});
  // Pull-based streaming: never buffer a whole geometry/data file in Worker memory.
  // An async start() that eagerly enqueues every chunk would delay first byte and risk OOM.
  async function* readPieces() {
    let pos = 0;
    for (const piece of pieces) {
      const left = Math.max(r.start, pos);
      const right = Math.min(r.end, pos + piece.size - 1);
      if (left <= right) {
        const object = await env.ASSETS.get(piece.key, {
          range: {offset: left - pos, length: right - left + 1}
        });
        if (!object) throw new Error("Missing owned R2 piece: " + piece.key);
        const reader = object.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            yield result.value;
          }
        } finally { reader.releaseLock(); }
      }
      pos += piece.size;
      if (pos > r.end) break;
    }
  }
  const iterator = readPieces();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); }
  });
  return new Response(stream, {status: r.partial ? 206 : 200, headers: h});
}
async function normal(env, method, path, rangeHeader) {
  const key = BUCKET_PREFIX + path;
  let r = null;
  if (rangeHeader) {
    const meta = await env.ASSETS.head(key);
    if (!meta) return new Response("Not found", {status: 404});
    r = parseRange(rangeHeader, meta.size);
    if (!r) return new Response(null, {status: 416, headers: {"Content-Range": "bytes */" + meta.size}});
  }
  if (method === "HEAD") {
    const obj = await env.ASSETS.head(key);
    if (!obj) return new Response("Not found", {status: 404});
    const h = baseHeaders(path, r ? r.end - r.start + 1 : obj.size);
    if (r && r.partial) h["Content-Range"] = "bytes " + r.start + "-" + r.end + "/" + obj.size;
    return new Response(null, {status: r && r.partial ? 206 : 200, headers: h});
  }
  const obj = await env.ASSETS.get(key, r ? {range: {offset:r.start, length:r.end-r.start+1}} : undefined);
  if (!obj) return new Response("Not found", {status: 404});
  const h = baseHeaders(path, r ? r.end - r.start + 1 : obj.size);
  if (r && r.partial) h["Content-Range"] = "bytes " + r.start + "-" + r.end + "/" + obj.size;
  if (obj.httpEtag) h["ETag"] = obj.httpEtag;
  return new Response(obj.body, {status: r && r.partial ? 206 : 200, headers: h});
}
export default {
  async fetch(request, env) {
    if (request.method === "PUT") {
      try { return await upload(request, env); } catch (error) {
        console.error("med2 upload error", String(error));
        return new Response("Upload unavailable", {status: 503});
      }
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", {status: 405});
    const path = filePath(request);
    if (!path) return new Response("Bad path", {status: 400});
    try {
      const compressed = await maybeGzipAsset(env, request, path);
      if (compressed) return compressed;
      const SPLIT = await loadSplitManifest(env);
      const asset = SPLIT[path]
        ? await chunked(env, request.method, path, SPLIT[path], request.headers.get("Range"))
        : await normal(env, request.method, path, request.headers.get("Range"));
      if (path !== "index.html") return asset;
      const toggle = new URL(request.url).searchParams.get("fast_mesh");
      if (toggle !== "1" && toggle !== "0") return asset;
      const headers = new Headers(asset.headers);
      headers.set("Set-Cookie", "med2_mesh_gzip=" + (toggle === "1" ? "1" : "0") +
        "; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax");
      headers.set("Cache-Control", "no-store");
      return new Response(asset.body, {status:asset.status, headers});
    } catch (error) {
      console.error("med2 asset error", String(error));
      return new Response("Asset unavailable", {status: 503});
    }
  }
};
