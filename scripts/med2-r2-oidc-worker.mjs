// Dedicated med2 assets are uploaded by its own GitHub Actions job using OIDC.
// This Worker has no credentials and no bindings to any other project.
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "med2-anatomy-upload-v1";
const ALLOWED_WORKFLOWS = new Set(["geminiamo0-ship-it/med2/.github/workflows/deploy-r2.yml@refs/heads/main", "geminiamo0-ship-it/med2/.github/workflows/optimize-skull-presentations.yml@refs/heads/main", "geminiamo0-ship-it/med2/.github/workflows/optimize-brotli-skull.yml@refs/heads/main"]);
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


const encodedManifests = new Map();
async function getEncodedManifest(env, suffix) {
  const now = Date.now();
  const cached = encodedManifests.get(suffix);
  if (cached && cached.expires > now) return cached.data;
  const obj = await env.ASSETS.get("202510141308/" + suffix);
  if (!obj) return {};
  const data = JSON.parse(await obj.text());
  encodedManifests.set(suffix, {data, expires:now+60000});
  return data;
}
async function maybeEncodedAsset(env, request, path) {
  if (!path.endsWith(".oex") && !path.endsWith(".xbin")) return null;
  const accepts = request.headers.get("Accept-Encoding") || "";
  // Preserve identity for ranges, explicit opt-outs and unsupported clients.
  if (request.headers.has("Range") ||
      /(?:^|;\s*)med2_mesh_gzip=0(?:;|$)/.test(request.headers.get("Cookie") || "")) return null;
  const candidates = [
    {encoding:"br", manifest:"__br_files.json"},
    {encoding:"gzip", manifest:"__gzip_files.json"}
  ];
  for (const candidate of candidates) {
    if (!(new RegExp("(?:^|[,\\s])" + candidate.encoding + "(?:[,;\\s]|$)", "i")).test(accepts)) continue;
    const manifest = await getEncodedManifest(env, candidate.manifest);
    const spec = manifest[path];
    if (!spec || !Array.isArray(spec.pieces) || spec.pieces.length < 1) continue;
    const asset = await chunked(env, request.method, path, spec.pieces, null);
    if (asset.status !== 200) return asset;
    const headers = new Headers(asset.headers);
    headers.set("Content-Encoding", candidate.encoding);
    headers.set("Vary", "Accept-Encoding, Cookie");
    headers.set("X-Med2-Encoded-Transport", candidate.encoding + "-lossless");
    headers.delete("Accept-Ranges");
    return new Response(asset.body, {status:200, headers, encodeBody:"manual"});
  }
  return null;
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
function missingAsset() {
  // Negative-cache only versioned med2 assets, briefly, to prevent
  // repeated missing thumbnail / optional texture re-fetches on reload.
  // Newly uploaded licensed files become visible after this short TTL.
  return new Response(null, {status:404, headers:{
    "Cache-Control":"public, max-age=120",
    "X-Content-Type-Options":"nosniff",
    "X-Robots-Tag":"noindex, nofollow"
  }});
}
async function normal(env, method, path, rangeHeader) {
  const key = BUCKET_PREFIX + path;
  let r = null;
  if (rangeHeader) {
    const meta = await env.ASSETS.head(key);
    if (!meta) return missingAsset();
    r = parseRange(rangeHeader, meta.size);
    if (!r) return new Response(null, {status: 416, headers: {"Content-Range": "bytes */" + meta.size}});
  }
  if (method === "HEAD") {
    const obj = await env.ASSETS.head(key);
    if (!obj) return missingAsset();
    const h = baseHeaders(path, r ? r.end - r.start + 1 : obj.size);
    if (r && r.partial) h["Content-Range"] = "bytes " + r.start + "-" + r.end + "/" + obj.size;
    return new Response(null, {status: r && r.partial ? 206 : 200, headers: h});
  }
  const obj = await env.ASSETS.get(key, r ? {range: {offset:r.start, length:r.end-r.start+1}} : undefined);
  if (!obj) return missingAsset();
  const h = baseHeaders(path, r ? r.end - r.start + 1 : obj.size);
  if (r && r.partial) h["Content-Range"] = "bytes " + r.start + "-" + r.end + "/" + obj.size;
  if (obj.httpEtag) h["ETag"] = obj.httpEtag;
  return new Response(obj.body, {status: r && r.partial ? 206 : 200, headers: h});
}

// Read-only profiling page on the med2 Worker origin. Nothing is uploaded.
const MED2_PROFILE_PAGE = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Med2 — اختبار سرعة التشريح ثلاثي الأبعاد</title>
<style>body{margin:0;background:#0d1725;color:#f3f7fa;font:15px system-ui,Tahoma}
header{padding:12px 16px;background:#16283b;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{border:0;border-radius:9px;background:#247a77;color:white;padding:10px 15px;font:inherit;cursor:pointer}
#stats{display:flex;gap:14px;flex-wrap:wrap;font-size:13px}
b{color:#b5f2de}iframe{border:0;display:block;width:100%;height:calc(100dvh - 95px);background:#080808}
footer{position:fixed;bottom:0;left:0;right:0;background:#16283be8;text-align:center;padding:6px;font-size:11px}
</style></head><body>
<header><strong>Med2 3D — قياس التحميل</strong><span id="mode">الوضع العادي</span><span id="stats">بدء الاختبار...</span>
<button id="toggle">تجربة وضع Lite</button><button id="mark">ظهر المجسم عندي</button><button id="copy">نسخ التقرير</button></header>
<iframe title="Med2 3D Skull" id="viewer" src="/?target=humanSkull&amp;flags=english"></iframe>
<footer>الاختبار داخل نفس موقع Med2 فقط؛ لا يتم إرسال القياسات إلى أي خادم.</footer>
<script>
(()=>{"use strict";
const started=performance.now(),stats=document.getElementById('stats'),iframe=document.getElementById('viewer');
const lite=new URLSearchParams(location.search).get('lite')==='1';
document.getElementById('mode').textContent=lite?'وضع Lite — اختبار':'الوضع العادي';
document.getElementById('toggle').textContent=lite?'العودة للوضع العادي':'تجربة وضع Lite';
document.getElementById('toggle').onclick=()=>{location.href='/__med2_diagnostics?lite='+(lite?'0':'1')};
iframe.src='/?target=humanSkull&flags=english&lite='+(lite?'1':'0');
let visibleAt=null,latest=null;
const mb=x=>(x/1048576).toFixed(1);
function allFrames(w,result,seen,meta){
 if(!w||seen.has(w))return; seen.add(w);
 try{
  if(w.location.pathname==='/app/oe/index.html')meta.engineDPR=w.devicePixelRatio;
  const entries=w.performance.getEntriesByType('resource');
  for(const x of entries)result.push({bytes:x.encodedBodySize||0,status:x.responseStatus||0,url:x.name,startSec:Math.round((x.startTime||0)/100)/10,endSec:Math.round((x.responseEnd||0)/100)/10,durationSec:Math.round((x.duration||0)/100)/10});
  for(let i=0;i<w.frames.length;i++)allFrames(w.frames[i],result,seen,meta);
 }catch(_){}
}
function sample(){
 const entries=[],meta={engineDPR:null};allFrames(iframe.contentWindow,entries,new Set(),meta);
 const encoded=entries.reduce((x,y)=>x+y.bytes,0);
 const errors=entries.filter(x=>x.status>=400).length;
 const seconds=Math.round((performance.now()-started)/1000);
 const big=entries.filter(x=>x.bytes>262144).sort((a,b)=>b.bytes-a.bytes).slice(0,6);
 const slow=entries.filter(x=>x.durationSec>0.5).sort((a,b)=>b.durationSec-a.durationSec).slice(0,6);
 const simple=x=>({asset:x.url.split('/').slice(-3).join('/').slice(-90),sizeMB:mb(x.bytes),startSec:x.startSec,endSec:x.endSec,durationSec:x.durationSec,status:x.status});
 latest={seconds,encodedMB:mb(encoded),resources:entries.length,httpErrors:errors,topBytes:big.map(simple),slowest:slow.map(simple),
  firstVisibleSec:visibleAt,deviceDPR:window.devicePixelRatio,
  engineDPR:meta.engineDPR,mode:lite?'lite':'normal',
  screen:screen.width+'x'+screen.height,
  connection:navigator.connection?.effectiveType||'unknown'};
 stats.innerHTML='<span>الوقت: <b>'+seconds+' ث</b></span>'+
 '<span>التنزيل: <b>'+latest.encodedMB+' MB</b></span>'+
 '<span>الملفات: <b>'+entries.length+'</b></span>'+
 '<span>الأخطاء: <b>'+errors+'</b></span>'+
 '<span>DPR المحرك: <b>'+(meta.engineDPR??'...')+'</b></span>';
}
document.getElementById('mark').onclick=()=>{visibleAt=Math.round((performance.now()-started)/1000);sample();document.getElementById('mark').textContent='تم تسجيل الظهور: '+visibleAt+' ث';};
document.getElementById('copy').onclick=async()=>{
 sample(); const data='Med2 3D performance: '+JSON.stringify(latest);
 try{await navigator.clipboard.writeText(data);document.getElementById('copy').textContent='تم نسخ التقرير';}
 catch(_){prompt('انسخ التقرير:',data)}
};
setInterval(sample,2000);sample();
})();
</script></body></html>`;

export default {
  async fetch(request, env) {
    if (request.method === "PUT") {
      try { return await upload(request, env); } catch (error) {
        console.error("med2 upload error", String(error));
        return new Response("Upload unavailable", {status: 503});
      }
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", {status: 405});
    if (request.method === "GET" && new URL(request.url).pathname === "/__med2_diagnostics") {
      return new Response(MED2_PROFILE_PAGE, {headers:{
        "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store",
        "X-Content-Type-Options":"nosniff", "X-Robots-Tag":"noindex, nofollow"
      }});
    }
    const path = filePath(request);
    if (!path) return new Response("Bad path", {status: 400});
    try {
      const compressed = await maybeEncodedAsset(env, request, path);
      if (compressed) return compressed;
      const SPLIT = await loadSplitManifest(env);
      const asset = SPLIT[path]
        ? await chunked(env, request.method, path, SPLIT[path], request.headers.get("Range"))
        : await normal(env, request.method, path, request.headers.get("Range"));
      if (path === "app/oe/index.html" && request.method === "GET" && asset.status === 200 &&
          /(?:^|;\s*)med2_lite=1(?:;|$)/.test(request.headers.get("Cookie") || "")) {
        // Explicit, reversible *canary* for mobile GPU fill-rate. Keep anatomical
        // geometry and textures unchanged; affect render resolution only.
        const originalHTML = await asset.text();
        const inject = '<script>(function(){try{' +
          'var nativeDpr=window.devicePixelRatio||1;' +
          'if(nativeDpr>1.5) Object.defineProperty(window,"devicePixelRatio",{configurable:true,get:function(){return 1.5;}});' +
          'window.__med2LiteDpr={original:nativeDpr,used:window.devicePixelRatio};' +
          '}catch(e){}})();</script>';
        if (!/<head\b[^>]*>/i.test(originalHTML)) return new Response(originalHTML, {status:200, headers:{"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"}});
        const html = originalHTML.replace(/<head\b[^>]*>/i, match => match + inject);
        const headers = new Headers(asset.headers);
        headers.delete("Content-Length");
        headers.delete("ETag");
        headers.set("Cache-Control","no-store");
        headers.set("X-Med2-Lite-Render","dpr-canary");
        return new Response(html,{status:200,headers});
      }
      // Experimental early fetch of the exact licensed Skull geometry while JS
      // initializes. Query-flag only; never change regular users automatically.
      if (path === "index.html" && request.method === "GET" && asset.status === 200 &&
          new URL(request.url).searchParams.get("early") === "1" &&
          new URL(request.url).searchParams.get("target") === "humanSkull") {
        const original = await asset.text();
        const preload = '<link rel="preload" as="fetch" crossorigin="anonymous" href="/app/oe/geometry/human/skull/humanSkull.oex">';
        if (/<head\\b[^>]*>/i.test(original)) {
          const html = original.replace(/<head\\b[^>]*>/i, match => match + preload);
          const headers = new Headers(asset.headers);
          headers.delete("Content-Length");
          headers.delete("ETag");
          headers.set("Cache-Control","no-store");
          headers.set("X-Med2-Early-Geometry","trial");
          return new Response(html,{status:200,headers});
        }
        return new Response(original,{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
      }
      if (path !== "index.html") return asset;
      const opts = new URL(request.url).searchParams;
      const toggle = opts.get("fast_mesh");
      const lite = opts.get("lite");
      if ((toggle !== "1" && toggle !== "0") && (lite !== "1" && lite !== "0")) return asset;
      const headers = new Headers(asset.headers);
      if (toggle === "0" || toggle === "1") {
        headers.append("Set-Cookie", "med2_mesh_gzip=" + toggle +
          "; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax");
      }
      if (lite === "0" || lite === "1") {
        headers.append("Set-Cookie", "med2_lite=" + lite +
          "; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax");
      }
      headers.set("Cache-Control", "no-store");
      return new Response(asset.body, {status:asset.status, headers});
    } catch (error) {
      console.error("med2 asset error", String(error));
      return new Response("Asset unavailable", {status: 503});
    }
  }
};
