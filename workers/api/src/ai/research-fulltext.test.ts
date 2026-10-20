import { describe, expect, it } from "vitest";
import { selectPmcTeachingPassages } from "./research-fulltext";
import { PubMedResearchRetrieval } from "./research-retrieval";

const question = "Managing diabetic ketoacidosis in special conditions: Difficulties and dilemmas";
const sections = [
  { title: "Diabetic ketoacidosis in CKD / dialysis", content: "In DKA with renal impairment and dialysis, initial fluid replacement needs individualized volume assessment. In hypovolemic patients, small 250 mL aliquots with reassessment are discussed. Insulin remains necessary, but reduced renal clearance requires careful monitoring and dose adjustment." },
  { title: "Cardiac disease / heart failure", content: "Managing DKA in heart failure creates fluid overload concerns despite intravascular depletion. The source describes cautious 250-500 mL boluses and careful monitoring of haemodynamics, lungs, and peripheral congestion." },
  { title: "DKA during pregnancy", content: "Pregnancy is associated with relatively euglycemic diabetic ketoacidosis, requiring maternal stabilization and obstetric co-management. The article describes laboratory monitoring every 2-4 hours and fetal monitoring in appropriate gestation." },
  { title: "DKA in older adults", content: "Older and frail adults can experience atypical neurological symptoms of DKA with impaired kidney function and comorbid infection. Fluid and insulin treatment should account for physiological reserve, cardiac function and cognitive status." },
  { title: "Pediatric DKA in children", content: "For pediatric DKA, insulin infusion should begin at least one hour after starting fluid therapy, with particular attention to cerebral injury. The clinical article discusses 0.05-0.1 units/kg/hour as an example of insulin infusion." },
  { title: "SGLT2 inhibitor associated euglycemic DKA", content: "SGLT2 medications can cause euglycemic DKA even when measured serum glucose is not elevated. Dextrose may be introduced early while insulin infusion continues to suppress ketosis." },
  { title: "Acute pancreatitis and DKA", content: "Acute pancreatitis and diabetic ketoacidosis may coexist during severe hypertriglyceridemia. Insulin infusion and careful fluid and electrolyte therapy are discussed together with precipitant investigation." },
  { title: "Mixed DKA-HHS hyperosmolar overlap", content: "The review describes DKA-HHS hyperosmolar overlap and its management dilemmas, including aggressive monitoring of fluid balance, osmolality, and potassium during insulin treatment." },
];
const pmcXml = '<pmc-articleset><article><front><article-meta><article-id pub-id-type="pmc">12444256</article-id></article-meta></front><body>' +
  sections.map((section) => '<sec><title>' + section.title + '</title><p>' + section.content + '</p></sec>').join('') +
  '<table-wrap><caption><p>Special DKA management dosing by comorbidity</p></caption>' +
  '<table><tbody><tr><td>Renal disease</td><td>Small 250 mL fluid aliquots and repeated assessment</td></tr></tbody></table></table-wrap>' +
  '</body></article></pmc-articleset>';

const pubmedXml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>40980300</PMID>
<Article><ArticleTitle>Managing diabetic ketoacidosis in special conditions: Difficulties and dilemmas</ArticleTitle>
<Abstract><AbstractText>Patients with DKA in pregnancy, kidney disease, cardiac disease, older age, children and SGLT2 inhibitor use require tailored clinical management.</AbstractText></Abstract>
<Journal><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal></Article>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pmc">PMC12444256</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle></PubmedArticleSet>`;

function provider(pmcFailure = false) {
  const urls: string[] = [];
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/esearch.fcgi")) {
      return Response.json({ esearchresult: { idlist: ["40980300"] } });
    }
    if (url.includes("/efetch.fcgi") && url.includes("db=pubmed")) return new Response(pubmedXml);
    if (url.includes("/efetch.fcgi") && url.includes("db=pmc")) {
      return pmcFailure ? new Response("timeout", { status: 503 }) : new Response(pmcXml);
    }
    if (url.includes("/fullTextXML")) {
      return pmcFailure ? new Response("unavailable", { status: 503 }) : new Response(pmcXml);
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetcher: fetcher as typeof fetch, urls };
}

describe("PMC full-text-first original medical evidence", () => {
  it("extracts actual treatment paragraphs across every named special condition and tables", () => {
    const selected = selectPmcTeachingPassages(pmcXml, question, 13_800);
    expect(selected.sectionCount).toBeGreaterThanOrEqual(8);
    for (const term of ["250 mL", "250-500 mL", "pregnancy", "older adults", "Pediatric DKA", "SGLT2", "Acute pancreatitis", "DKA-HHS"]) {
      expect(selected.text).toContain(term);
    }
    expect(selected.text).toContain("Table:");
    expect(selected.text).toContain("PMC section:");
    expect(selected.text.length).toBeLessThan(13_800);
  });

  it("prioritizes the original PMC article and sends multiple cited treatment sections, not just its PubMed abstract", async () => {
    const { fetcher, urls } = provider();
    const evidence = await new PubMedResearchRetrieval({ fetcher }).retrieve({
      query: "Prior discussion (untrusted context):\\nQ: dka | Verified A: old answer\\nFollow-up question:\\n" + question,
      libraryId: null,
      sourceMode: "research",
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourceId).toBe("pubmed:40980300");
    expect(evidence[0]?.text).toContain("PMC full-text passages available and included");
    expect(evidence[0]?.text).toContain("Verified PMC full-text excerpts by section");
    for (const text of ["250 mL", "pregnancy", "SGLT2", "DKA-HHS"]) {
      expect(evidence[0]?.text).toContain(text);
    }
    expect(evidence[0]?.text.length).toBeGreaterThan(1_500);
    expect(urls.some((url) => url.includes("db=pmc"))).toBe(true);
  });

  it("explicitly labels abstract-only when both PMC full-text providers fail; never invents a dose", async () => {
    const { fetcher, urls } = provider(true);
    const evidence = await new PubMedResearchRetrieval({ fetcher }).retrieve({
      query: question, libraryId: null, sourceMode: "research",
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.text).toContain("ABSTRACT ONLY");
    expect(evidence[0]?.text).toContain("Do not claim this abstract verifies");
    expect(evidence[0]?.text).not.toContain("250 mL");
    expect(evidence[0]?.text).not.toContain("Verified PMC full-text excerpts");
    expect(urls.some((url) => url.includes("fullTextXML"))).toBe(true);
  });

  it("bounds original excerpt size and never manufactures a clinical fact to fill the budget", () => {
    const answer = selectPmcTeachingPassages(pmcXml, question, 1_200);
    expect(answer.text.length).toBeLessThanOrEqual(1_200);
    expect(answer.text).not.toContain("0.5 units/kg/h");
  });
});
