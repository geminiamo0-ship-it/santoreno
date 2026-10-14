#!/usr/bin/env python3
"""Convert a licensed local medical SQLite dataset into private Santo R2 objects.
No network access, public publishing, source code copies or private credentials.
Usage: python scripts/export_medical_libraries.py --db all_libraries.sqlite --out ./export
"""
import argparse
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3

from medical_article_html import MEDIA, media_url, sanitize_medical_html
LIB = {
    "amboss": "amboss", "usmle": "usmle", "1exam_notes": "one-examination",
    "passmedicine": "passmedicine", "pm_diagrams": "passmedicine",
    "pm_library_part_2": "passmedicine", "pm_index": "passmedicine",
    "pastest": "pastest", "pastest_2": "pastest",
}
NAME = {"amboss": "AMBOSS", "usmle": "USMLE", "one-examination": "One Examination",
        "passmedicine": "PassMedicine", "pastest": "Pastest"}

class TextSections(HTMLParser):
    """Never forward HTML, scripts, svg, interactive frames or embedded code."""
    OMIT = {"script", "style", "svg", "iframe", "object", "embed", "noscript", "form"}
    BREAK = {"br", "p", "div", "li", "tr", "table", "section", "article",
             "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections=[]; self.heading="Overview"; self.text=[]; self.images=[]
        self.omit=0; self.header=0; self.heading_text=[]
    def handle_starttag(self, tag, attrs):
        tag=tag.lower()
        if self.omit:
            if tag in self.OMIT: self.omit += 1
            return
        if tag in self.OMIT: self.omit=1; return
        if tag in {"h1","h2","h3","h4","h5","h6"}: self.flush(); self.header += 1; return
        if tag=="img":
            data=dict(attrs); url=media_url(data.get("src"))
            if url and len(self.images)<40:
                self.images.append({"src":url,"alt":html.unescape(data.get("alt") or "")[:250]})
            return
        if tag in self.BREAK: self.text.append("\n")
        if tag=="td": self.text.append(" | ")
    def handle_endtag(self,tag):
        if self.omit:
            if tag in self.OMIT: self.omit -= 1
            return
        if tag in {"h1","h2","h3","h4","h5","h6"} and self.header:
            self.header -= 1
            heading=" ".join("".join(self.heading_text).split())[:300]
            if heading:self.heading=heading
            self.heading_text=[]
            return
        if tag in self.BREAK:self.text.append("\n")
    def handle_data(self,data):
        if self.omit:return
        (self.heading_text if self.header else self.text).append(data)
    def flush(self):
        source=html.unescape("".join(self.text))
        source="\n".join(" ".join(line.split()) for line in source.splitlines())
        source=re.sub(r"\n{3,}","\n\n",source).strip()
        if source or self.images:
            self.sections.append({"heading":self.heading,"text":source,"images":self.images})
        self.text=[];self.images=[]
    def finish(self):
        self.flush()
        return self.sections or [{"heading":"Overview","text":"","images":[]}]

def chunks(section):
    text=section["text"]
    if not text:yield section;return
    offset=0;part=0
    while offset<len(text):
        end=min(offset+20000,len(text))
        if end<len(text):
            split=text.rfind("\n",offset+500,end)
            if split>offset:end=split+1
        part+=1
        yield {"heading":section["heading"] if part==1 else f'{section["heading"]} (part {part})',
               "text":text[offset:end],"images":section["images"] if part==1 else []}
        offset=end

def save(path,payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload,ensure_ascii=False,separators=(",",":")),encoding="utf-8")

def main(db_path,out_path,limit):
    db=sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro",uri=True)
    if db.execute("PRAGMA quick_check(1)").fetchone()[0]!="ok":raise ValueError("SQLite integrity failed")
    out=Path(out_path);index={k:[] for k in NAME};count=0
    tables=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            if row[0].startswith("library_")]
    for table in tables:
        for ident,name,category,raw,source in db.execute(
            f'SELECT id,name,category,content_html,source FROM "{table}" ORDER BY id'
        ):
            if source not in LIB:raise ValueError(f"Unknown source: {source}")
            library=LIB[source]
            article_id=re.sub("[^a-z0-9-]","-",f'{table.removeprefix("library_").replace("_","-")}-{ident}'.lower())[:90]
            title=" ".join((name or "Untitled").split())[:500]
            category=" ".join((category or "").split())[:300]
            rich_html=sanitize_medical_html(raw or "")
            parsed=TextSections();parsed.feed(raw or "")
            sections=[]
            for part in parsed.finish():
                for section in chunks(part):
                    sid=f"s-{len(sections)+1:04d}"
                    sections.append({"id":sid,**section})
            if len(sections)>300:raise ValueError(f"Too many sections in {article_id}")
            article={"schemaVersion":1,"libraryId":library,"articleId":article_id,
                     "title":title,"category":category,"source":source,"sections":sections,
                     "contentHtml":rich_html}
            target=out/f"medical-articles/v1/{library}/{article_id}.json"
            save(target,article)
            if target.stat().st_size>2_000_000:raise ValueError(f"Article too large: {article_id}")
            index[library].append({"id":article_id,"title":title,"category":category})
            for section in sections:
                key=out/f'medical-search/v1/{library}/{article_id}/{section["id"]}.md'
                key.parent.mkdir(parents=True,exist_ok=True)
                key.write_text(f'# {title}\n\nLibrary: {NAME[library]}\nCategory: {category}\n'
                               f'Section: {section["heading"]}\n\n{section["text"]}\n',encoding="utf-8")
            count+=1
            if limit and count>=limit:break
        if limit and count>=limit:break
    catalog=[]
    for lib,items in index.items():
        save(out/f"medical-library-catalog/v1/{lib}.json",
             {"schemaVersion":1,"libraryId":lib,"title":NAME[lib],"articles":items})
        if items:catalog.append({"id":lib,"title":NAME[lib],"count":len(items)})
    save(out/"medical-library-catalog/v1/catalog.json",{"schemaVersion":1,"libraries":catalog})
    save(out/"export-report.json",{"articles":count,"libraries":catalog,"mediaBase":MEDIA})
    print(json.dumps({"articles":count,"libraries":catalog},indent=2))

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",required=True);ap.add_argument("--out",required=True)
    ap.add_argument("--limit",type=int)
    args=ap.parse_args()
    main(args.db,args.out,args.limit)
