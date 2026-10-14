// Ephemeral authenticated staging migration Worker.
// Only copies One Examination search documents from canonical R2 to a fresh
// isolated AI Search source bucket. No public reads, no deletes, no writes to source.
const PREFIX = "medical-search/v1/one-examination/";
const KEY = /^medical-search\/v1\/one-examination\/[a-z0-9-]{1,96}\/s-[0-9]{4}\.md$/;
const MAX = 10;

function authorized(request, token) {
  const given = request.headers.get("authorization") || "";
  if (!/^[a-f0-9]{64}$/.test(token || "") || !/^Bearer [a-f0-9]{64}$/.test(given)) return false;
  let xor = 0;
  const received = given.slice(7);
  for (let i = 0; i < 64; i++) xor |= received.charCodeAt(i) ^ token.charCodeAt(i);
  return xor === 0;
}
function json(body, status=200) {
  return Response.json(body, {
    status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
  });
}
export default {
  async fetch(req, env) {
    if (!authorized(req, env.SANTO_ISOLATION_TOKEN)) return json({error:"UNAUTHORIZED"},401);
    const uri = new URL(req.url);
    if (!env.SOURCE_BUCKET || !env.DEST_BUCKET) return json({error:"BUCKET_BINDING_MISSING"},503);
    if (req.method === "GET" && uri.pathname === "/count") {
      const prefix = uri.searchParams.get("prefix") || PREFIX;
      if (prefix !== PREFIX) return json({error:"BAD_PREFIX"},400);
      const kind = uri.searchParams.get("bucket");
      if (!["source","destination"].includes(kind)) return json({error:"BAD_BUCKET"},400);
      const binding = kind === "source" ? env.SOURCE_BUCKET : env.DEST_BUCKET;
      const cursor = uri.searchParams.get("cursor") || undefined;
      try {
        const listing = await binding.list({prefix:PREFIX, limit:100, cursor});
        if (listing.objects.some(x => !KEY.test(x.key))) return json({error:"UNEXPECTED_KEY"},400);
        return json({keys:listing.objects.map(x=>x.key),cursor:listing.truncated?listing.cursor:null});
      } catch(e){return json({error:"LIST_FAILED"},503);}
    }
    if (req.method === "GET" && uri.pathname === "/verify") {
      const key = uri.searchParams.get("key");
      if (!KEY.test(key || "")) return json({error:"BAD_KEY"},400);
      const [src,dst]=await Promise.all([env.SOURCE_BUCKET.get(key),env.DEST_BUCKET.get(key)]);
      if (!src||!dst) return json({error:"MISSING"},404);
      const [a,b]=await Promise.all([src.arrayBuffer(),dst.arrayBuffer()]);
      const bytes=await Promise.all([crypto.subtle.digest("SHA-256",a),crypto.subtle.digest("SHA-256",b)]);
      const toHex=(v)=>[...new Uint8Array(v)].map(n=>n.toString(16).padStart(2,"0")).join("");
      const same=toHex(bytes[0])===toHex(bytes[1]);
      return json({key,identical:same,sha256:toHex(bytes[0]),size:a.byteLength},same?200:409);
    }
    if (req.method !== "POST" || uri.pathname !== "/copy") return json({error:"NOT_FOUND"},404);
    let body;
    try {body=await req.json();}catch{return json({error:"BAD_JSON"},400);}
    if (!body || !Array.isArray(body.keys) || body.keys.length<1 || body.keys.length>MAX ||
        new Set(body.keys).size!==body.keys.length || body.keys.some(k=>typeof k!=="string"||!KEY.test(k)))
      return json({error:"UNAPPROVED_KEYS"},400);
    const results=await Promise.allSettled(body.keys.map(async key=>{
      const source=await env.SOURCE_BUCKET.get(key);
      if(!source) throw Error("SOURCE_MISSING");
      // Use bytes to avoid holding a live R2 GET stream open across destination PUT.
      const bytes=await source.arrayBuffer();
      if (bytes.byteLength>2_000_000) throw Error("TOO_LARGE");
      await env.DEST_BUCKET.put(key,bytes,{
        httpMetadata:{contentType:"text/markdown; charset=utf-8",cacheControl:"private, no-store"}
      });
      const copy=await env.DEST_BUCKET.head(key);
      if(!copy||copy.size!==bytes.byteLength)throw Error("DEST_READBACK_MISMATCH");
      return key;
    }));
    return json({
      copied:results.flatMap((r,i)=>r.status==="fulfilled"?[body.keys[i]]:[]),
      failed:results.flatMap((r,i)=>r.status==="rejected"?[body.keys[i]]:[]),
    },results.some(r=>r.status==="rejected")?207:200);
  }
};
