#!/usr/bin/env python3
"""Read-only exact-article provider smoke. No model calls, quota, or user data."""
import re
import urllib.request

PMCID = "12444256"
urls = [
    ("NCBI", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=" + PMCID + "&retmode=xml"),
    ("EuropePMC", "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC" + PMCID + "/fullTextXML"),
]

for provider, url in urls:
    try:
        req = urllib.request.Request(url, headers={
            "Accept": "application/xml",
            "User-Agent": "SantoResearchStagingSmoke/1.0 (clinical evidence verification)",
        })
        with urllib.request.urlopen(req, timeout=18) as resp:
            xml = resp.read(1_500_001)
        if len(xml) > 1_500_000:
            raise RuntimeError("PMC article exceeds configured provider response limit")
        decoded = xml.decode("utf-8")
        pattern = r"<article-id\b[^>]*\bpub-id-type=['\"]pmc['\"][^>]*>\s*(?:PMC)?" + PMCID + r"\s*</article-id>"
        if not re.search(pattern, decoded, re.I):
            ids = re.findall(r"<article-id\b[^>]*>[^<]{0,85}</article-id>", decoded, re.I)
            alternate = re.findall(r"<articleid\b[^>]*>[^<]{0,85}</articleid>", decoded, re.I)
            print("PMC_ID_DIAGNOSTIC", {"provider": provider, "bytes": len(xml),
                                        "xml_head": decoded[:90].replace("\\n", " "),
                                        "article_ids": ids[:7], "alternate_ids": alternate[:4]},
                  flush=True)
            raise RuntimeError("PMC identity missing or invalid JATS structure")
        readable = re.sub(r"<[^>]+>", " ", decoded).lower()
        missing = [term for term in ("pregnan", "insulin", "potassium", "kidney", "heart failure", "children")
                   if term not in readable]
        if missing:
            raise RuntimeError("PMC text missing expected categories: " + ",".join(missing))
        if "250" not in readable:
            raise RuntimeError("Expected renal volume detail not found in PMC article")
        print("REAL_PMC_FULLTEXT_AVAILABLE", {"provider": provider, "bytes": len(xml),
                                             "has_renal_fluid_detail": True,
                                             "has_multiple_special_conditions": True})
        break
    except Exception as exc:
        print("PMC_PROVIDER_UNAVAILABLE", {"provider": provider, "reason": type(exc).__name__, "detail": str(exc)[:180]}, flush=True)
else:
    raise SystemExit("Neither NCBI nor Europe PMC returned the complete, identified clinical article")
