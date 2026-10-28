#!/usr/bin/env python3
"""Immutable Quran asset importer for Noor; does not read user data or credentials."""
import argparse, concurrent.futures, hashlib, json, subprocess, time, urllib.request
from pathlib import Path

VERSION="v1.1.1"
PREFIX=f"quran/hafs/{VERSION}"
GIT_PIN="9fc0c87"
PAGE_BASE=f"https://raw.githubusercontent.com/quran-ws/quran-svg/{GIT_PIN}/mushafs/hafs/kfqc"
TEXT_BASE="https://quran-json.risanb.com/text/uthmani/chapters"


def fetch(url):
    for attempt in range(5):
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"NoorQuranSourceSync/1.0"})
            with urllib.request.urlopen(req,timeout=45) as r:return r.read()
        except (OSError,TimeoutError) as exc:
            if attempt==4:raise RuntimeError("Source download failed: "+url) from exc
            time.sleep(2**attempt)

def plans():
    yield ("indexes/surah.json",f"{PAGE_BASE}/json/surah.json","json")
    yield ("indexes/markers.json",f"{PAGE_BASE}/json/markers.json","json")
    for n in range(1,605):
        p=f"{n:03d}"
        yield (f"pages/{p}.svg",f"{PAGE_BASE}/svg/{p}.svg","svg")
        yield (f"pages/{p}.json",f"{PAGE_BASE}/json/{p}.json","json")
    for n in range(1,115):
        yield (f"text/chapters/{n:03d}.json",f"{TEXT_BASE}/{n}.json","text")

def pull(spec,root):
    key,url,kind=spec
    body=fetch(url)
    if kind=="svg":
        data=body.lower()
        if b"<svg" not in data[:5000] or len(body)<500 or b"<script" in data or b"<foreignobject" in data:
            raise ValueError("Invalid SVG "+key)
    else:
        obj=json.loads(body)
        if not isinstance(obj,(dict,list)) or not obj:raise ValueError("Empty metadata "+key)
        if kind=="text":
            if not isinstance(obj,dict) or not isinstance(obj.get("verses"),list) or not obj["verses"]:
                raise ValueError("Invalid chapter "+key)
            if not all(isinstance(v.get("text"),str) and v["text"].strip() for v in obj["verses"]):
                raise ValueError("Empty verse text "+key)
    p=root/PREFIX/key;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body)
    return {"key":key,"source":url,"sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}

def prepare(root):
    specs=list(plans())
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        assets=list(pool.map(lambda x:pull(x,root),specs))
    if len(assets)!=1324:raise RuntimeError("Incomplete Quran source set")
    surahs=json.loads((root/PREFIX/"indexes/surah.json").read_text(encoding="utf-8"))
    if len(surahs)!=114 or sum(x["ayahCount"] for x in surahs)!=6236:
        raise ValueError("Expected 114 surahs and 6236 Hafs ayat; refusing upload")
    manifest={"schema_version":"1","source_git_revision":GIT_PIN,"edition":"hafs-kfqc","version":VERSION,
      "page_count":604,"chapter_count":114,
      "source_page_artwork":"KFGQPC via Quran.ws SVG v1.1.1",
      "source_text":"risan/quran-json Uthmani Hafs",
      "license_urls":["https://quran.ws/docs/reference/licensing/",
      "https://github.com/risan/quran-json","https://qurancomplex.gov.sa/quran-dev/"],
      "assets":assets}
    (root/PREFIX/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False),encoding="utf-8")
    (root/PREFIX/"NOTICE.txt").write_text(
      "Hafs Quran SVG pages: original page artwork from KFGQPC; Quran.ws polygons CC BY 4.0.\n"
      "Text: risan/quran-json CC BY-SA 4.0; upstream rights retained.\n"
      "Sources: https://quran.ws/docs/reference/licensing/ and https://github.com/risan/quran-json\n",
      encoding="utf-8")
    print("Validated 604 SVG pages, 604 metadata pages and 114 Quran chapters",flush=True)

def send(root,bucket,p):
    key=p.relative_to(root).as_posix()
    ct="image/svg+xml" if p.suffix==".svg" else "application/json" if p.suffix==".json" else "text/plain"
    cmd=["./node_modules/.bin/wrangler","r2","object","put",f"{bucket}/{key}",
       "--file",str(p),"--content-type",ct,"--remote"]
    for attempt in range(3):
        result=subprocess.run(cmd,text=True,capture_output=True)
        if result.returncode==0:return key
        if attempt==2:raise RuntimeError("Upload failed: "+key+" "+result.stderr[-500:])
        time.sleep(2**attempt)

def upload(root,bucket):
    if bucket!="noor-quran-hafs-v1":raise ValueError("Refusing a non-Noor bucket")
    paths=[p for p in (root/PREFIX).rglob("*") if p.is_file()
           and p.name not in ("manifest.json","NOTICE.txt")]
    if len(paths)!=1324:raise ValueError("Upload set incomplete; manifest NOT published")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for n,_ in enumerate(pool.map(lambda p:send(root,bucket,p),paths),1):
            if n%100==0:print(f"Uploaded {n}/{len(paths)}",flush=True)
    # Commit marker is published last.
    send(root,bucket,root/PREFIX/"NOTICE.txt")
    send(root,bucket,root/PREFIX/"manifest.json")
    print("Complete edition manifest published last",flush=True)

if __name__=="__main__":
    a=argparse.ArgumentParser()
    a.add_argument("mode",choices=["prepare","upload"])
    a.add_argument("--output",required=True,type=Path)
    a.add_argument("--bucket",default="noor-quran-hafs-v1")
    args=a.parse_args()
    if args.mode=="prepare":prepare(args.output)
    else:upload(args.output,args.bucket)
