import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../workers/medical-import/src/index.js", import.meta.url));
const imported = await import("data:text/javascript;base64," + source.toString("base64"));
const worker = imported.default;
const token = "a".repeat(64);
const url = "https://santo-medical-import-staging.example.invalid";
const records = new Map();
const env = {
  SANTO_IMPORT_TOKEN: token,
  CONTENT_BUCKET: {
    async put(key, bytes) { records.set(key, Uint8Array.from(bytes)); },
    async get(key) {
      const value = records.get(key);
      return value ? {arrayBuffer:async()=>Uint8Array.from(value).buffer} : null;
    },
  }
};
const request = (method, path, json, authorized = true) => new Request(url + path, {
  method,
  headers: {
    ...(authorized ? {authorization: "Bearer " + token} : {}),
    ...(json ? {"content-type": "application/json"} : {}),
  },
  ...(json ? {body: JSON.stringify(json)} : {}),
});
const file = (key, value) => ({key, body:Buffer.from(value).toString("base64")});

test("never reads or writes anything without the temporary secret", async () => {
  const read = await worker.fetch(request("GET", "/verify?key=medical-library-catalog/v1/catalog.json",null,false),env);
  assert.equal(read.status,401);
  const write = await worker.fetch(request("POST","/batch",{files:[
    file("medical-library-catalog/v1/catalog.json", "{}")
  ]},false),env);
  assert.equal(write.status,401);
});
test("rejects path traversal and arbitrary source keys before any R2 write",async()=>{
  const before=records.size;
  const result=await worker.fetch(request("POST","/batch",{files:[
    file("medical-search/v1/usmle/a/../../secret.md","secret")
  ]}),env);
  assert.equal(result.status,400);
  assert.equal(records.size,before);
});
test("uploads medical article/search keys in batches, returns exact private hash",async()=>{
  const keys=[
    "medical-articles/v1/usmle/unnamed-6.json",
    "medical-search/v1/usmle/unnamed-6/s-0001.md"
  ];
  const values=['{"schemaVersion":1}','medical test text'];
  const put=await worker.fetch(request("POST","/batch",{files:keys.map((k,i)=>file(k,values[i]))}),env);
  assert.equal(put.status,200);
  assert.deepEqual((await put.json()).uploaded,keys);
  const evidence=await worker.fetch(request("GET","/verify?key="+encodeURIComponent(keys[0])),env);
  assert.equal(evidence.status,200);
  const hashed=await evidence.json();
  assert.equal(hashed.size,Buffer.byteLength(values[0]));
  assert.match(hashed.sha256,/^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(hashed).includes(values[0]));
});
test("never serves the original article, even when authenticated",async()=>{
  const r=await worker.fetch(request("GET","/download?key=medical-articles/v1/usmle/unnamed-6.json"),env);
  assert.equal(r.status,404);
});
test("enforces batch size and duplicate-key protection",async()=>{
  const tooMany=Array.from({length:21},(_,i)=>file("medical-search/v1/usmle/abc/s-"+String(i+1).padStart(4,"0")+".md","test"));
  const r=await worker.fetch(request("POST","/batch",{files:tooMany}),env);
  assert.equal(r.status,400);
  const dup=await worker.fetch(request("POST","/batch",{files:[
    file("medical-library-catalog/v1/catalog.json","a"),
    file("medical-library-catalog/v1/catalog.json","b")
  ]}),env);
  assert.equal(dup.status,400);
});
