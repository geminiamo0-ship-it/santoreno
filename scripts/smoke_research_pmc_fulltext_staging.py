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
        assert re.search(r"<article-id\s+pub-id-type=['\"]pmc['\"]>\s*(?:PMC)?" + PMCID + r"\s*</article-id>", decoded, re.I)
        readable = re.sub(r"<[^>]+>", " ", decoded).lower()
        assert all(term in readable for term in ("pregnan", "insulin", "potassium", "kidney", "heart failure", "children"))
        assert "250" in readable
        print("REAL_PMC_FULLTEXT_AVAILABLE", {"provider": provider, "bytes": len(xml),
                                             "has_renal_fluid_detail": True,
                                             "has_multiple_special_conditions": True})
        break
    except Exception as exc:
        print("PMC_PROVIDER_UNAVAILABLE", {"provider": provider, "reason": type(exc).__name__})
else:
    raise SystemExit("Neither NCBI nor Europe PMC returned the complete, identified clinical article")
