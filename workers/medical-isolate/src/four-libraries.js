/** Temporary staging-only R2 copier with strict one-library scope.
 * Destination is separately bound at deploy time. No public data access.
 */
const COUNTS = Object.freeze({
  "amboss":33724, "usmle":13499, "passmedicine":8580, "pastest":10704
});
const MAX_ITEMS = 10;
function ctx(env) {
  const lib=env.LIBRARY;
  if (!Object.prototype.hasOwnProperty.call(COUNTS,lib)) return null;
  return {
    prefix:`medical-search/v1/${lib}/`,
    valid: new RegExp(`^medical-search/v1/${lib}/[a-z0-9-]{1,96}/s-[0-9]{4}\\.md$`),
    lib,expected:COUNTS[lib]
  };
}
function authorized(req, token) {
  const header=req.headers.get("authorization")||"";
  if (!/^[a-f0-9]{64}$/.test(token||"")||!/^Bearer [a-f0-9]{64}$/.test(header))return false;
  let mask=0;for(let i=0;i<64;i++)mask|=header.charCodeAt(7+i)^token.charCodeAt(i);
  return mask===0;
}
const out=(data,code=200)=>Response.json(data,{status:code,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
export default {
  async fetch(req,env){
    if(!authorized(req,env.SANTO_ISOLATION_TOKEN))return out({error:"UNAUTHORIZED"},401);
    if(!env.SOURCE_BUCKET||!env.DEST_BUCKET)return out({error:"R2_UNAVAILABLE"},503);
    const conf=ctx(env);
    if(!conf)return out({error:"WRONG_LIBRARY"},503);
    const url=new URL(req.url);
    if(req.method==="GET"&&url.pathname==="/list"){
      const bucket=url.searchParams.get("bucket");
      if(bucket!=="source"&&bucket!=="destination")return out({error:"BAD_BUCKET"},400);
      const store=bucket==="source"?env.SOURCE_BUCKET:env.DEST_BUCKET;
      try{
        const result=await store.list({prefix:conf.prefix,limit:1000,cursor:url.searchParams.get("cursor")||undefined});
        if(result.objects.some(o=>!conf.valid.test(o.key)))return out({error:"UNEXPECTED_KEY"},409);
        return out({keys:result.objects.map(o=>o.key),cursor:result.truncated?result.cursor:null});
      }catch{return out({error:"R2_LIST_FAILED"},503);}
    }
    if(req.method==="GET"&&url.pathname==="/verify"){
      const key=url.searchParams.get("key")||"";
      if(!conf.valid.test(key))return out({error:"BAD_KEY"},400);
      const [a,b]=await Promise.all([env.SOURCE_BUCKET.get(key),env.DEST_BUCKET.get(key)]);
      if(!a||!b)return out({error:"MISSING"},404);
      const [aBytes,bBytes]=await Promise.all([a.arrayBuffer(),b.arrayBuffer()]);
      const [ah,bh]=await Promise.all([crypto.subtle.digest("SHA-256",aBytes),crypto.subtle.digest("SHA-256",bBytes)]);
      const hex=hash=>[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,"0")).join("");
      const same=hex(ah)===hex(bh);
      return out({key,identical:same,sha256:hex(ah),size:aBytes.byteLength},same?200:409);
    }
    if(req.method!=="POST"||url.pathname!=="/copy")return out({error:"NOT_FOUND"},404);
    let data;
    try{data=await req.json();}catch{return out({error:"BAD_JSON"},400);}
    if(!data||!Array.isArray(data.keys)||data.keys.length<1||data.keys.length>MAX_ITEMS||
       data.keys.some(k=>typeof k!=="string"||!conf.valid.test(k))||
       new Set(data.keys).size!==data.keys.length)return out({error:"BAD_KEYS"},400);
    const results=await Promise.allSettled(data.keys.map(async k=>{
      const source=await env.SOURCE_BUCKET.get(k);
      if(!source)throw Error("SOURCE_MISSING");
      const bytes=await source.arrayBuffer();
      if(bytes.byteLength>2_000_000)throw Error("BODY_TOO_LARGE");
      await env.DEST_BUCKET.put(k,bytes,{httpMetadata:{contentType:"text/markdown; charset=utf-8",cacheControl:"private, no-store"}});
      const head=await env.DEST_BUCKET.head(k);
      if(!head||head.size!==bytes.byteLength)throw Error("R2_NOT_PERSISTED");
      return k;
    }));
    return out({
      copied:results.flatMap((r,i)=>r.status==="fulfilled"?[data.keys[i]]:[]),
      failed:results.flatMap((r,i)=>r.status==="rejected"?[data.keys[i]]:[])
    },results.some(x=>x.status==="rejected")?207:200);
  }
};
