/**
 * PubMed Research-only prioritization. The journal / PubMed is still the
 * authority for study identity and publication types. No synthetic sources.
 */
export interface ResearchPaper {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  title: string;
  abstract: string;
  /** Indexed original PubMed keywords/MeSH headings, never clinical excerpts. */
  subjectTerms?: string[];
  year: number | null;
  types: string[];
  citations: number | null;
  position: number;
  score: number;
}

const QUERY_FILLER = new Set([
  "what",
  "which",
  "where",
  "when",
  "with",
  "from",
  "about",
  "latest",
  "tell",
  "explain",
  "detail",
  "detailed",
  "overview",
  "review",
  "evidence",
  "clinical",
  "current",
  "updated",
  "recent",
  "management",
  "treatment",
  "treatments",
  "therapy",
  "diagnosis",
  "diagnostic",
  "symptoms",
  "signs",
  "severity",
  "severe",
  "mild",
  "moderate",
  "pathophysiology",
  "guideline",
  "guidelines",
  "recommendation",
  "recommendations",
  "trials",
  "trial",
  "randomized",
  "study",
  "studies",
  "patient",
  "patients",
  "adults",
  "adult",
  "outcomes",
  "risk",
  "for",
  "the",
  "and",
  "in",
  "of",
  "on",
  "how",
]);

const lowerWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

export function researchTopicWords(query: string): string[] {
  return [...new Set(lowerWords(query).filter((word) => !QUERY_FILLER.has(word)))].slice(0, 8);
}

/** Deliberately distinct from the broad Qwen query: one of two PubMed
 * ESearch calls targets actual Practice Guideline/Guideline publication types,
 * or explicitly titled guidance. No fabricated guideline status or version.
 */
export function guidelineSearchQuery(query: string): string {
  const words = researchTopicWords(query).slice(0, 4);
  if (!words.length) return query.slice(0, 1800);
  const topic = words.join(" ");
  return (
    "(" +
    topic +
    ") AND (" +
    "Practice Guideline[pt] OR Guideline[pt] OR guideline[ti] OR guidelines[ti] OR consensus[ti]" +
    ")"
  );
}

/** Reserve real slots for guideline-search PMIDs. A broad first search cannot
 * crowd all of them out before the single EFetch call (60 unique IDs total).
 */
export function mergePubMedCandidateIds(
  primary: readonly string[],
  guidelines: readonly string[],
  limit = 60,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (ids: readonly string[], count: number) => {
    let added = 0;
    for (const id of ids) {
      if (added >= count || merged.length >= limit) break;
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
      added++;
    }
  };
  add(primary, Math.max(0, limit - Math.min(20, limit)));
  add(guidelines, Math.min(20, limit));
  add(primary, limit);
  add(guidelines, limit);
  return merged;
}

export function isPublishedGuideline(paper: Pick<ResearchPaper, "types">): boolean {
  return paper.types.some((type) => /^(?:practice guideline|guideline)$/i.test(type.trim()));
}

function isBroadMedicalQuestion(query: string): boolean {
  // No evidence request for a specific trial, subgroup, drug or intervention.
  return !/\b(polygenic|genetic|score|tavr|tavi|savr|bleeding|stroke|renal|pulmonary|post.hoc|predictor|prediction|mortality|meta.analysis|randomi[sz]ed|versus|vs)\b/i.test(
    query,
  );
}

function category(paper: ResearchPaper): string {
  const title = paper.title.toLowerCase();
  if (isPublishedGuideline(paper) || /\bguidelines?\b/.test(title)) return "guideline";
  if (
    /\b(review|meta.analysis|systematic review|consensus)\b/.test(title) ||
    paper.types.some((type) => /review|meta.analysis/i.test(type))
  )
    return "review";
  if (/complication|bleeding|stroke|pacemaker|adverse event|kidney injury/.test(title))
    return "complication";
  if (/predict|prognos|risk score|genetic|polygenic|association|phenotype/.test(title))
    return "risk";
  if (/diagnos|echocardiograph|severity|classification|assessment/.test(title)) return "diagnosis";
  if (
    /treatment|management|replacement|intervention|implantation|surgery|randomi[sz]ed/.test(title)
  )
    return "treatment";
  return "other";
}

/** Favor directly applicable clinical guidelines and broad systematic
 * evidence; do not promote a niche observational study merely for recency.
 * Relevance is anchored to medical-topic tokens, not generic words such
 * as "management". Exclude unrelated-condition-only records, but allow
 * comparative studies where the requested condition is genuinely discussed.
 */
export function rankResearchPapers(
  papers: readonly ResearchPaper[],
  query: string,
): ResearchPaper[] {
  const topic = researchTopicWords(query);
  const anchors = topic.slice(0, Math.min(3, topic.length));
  const broad = isBroadMedicalQuestion(query);
  const year = new Date().getUTCFullYear();
  const scored = papers
    .flatMap((paper) => {
      if (paper.types.some((type) => /retract(ed|ion)/i.test(type))) return [];
      const title = paper.title.toLowerCase();
      const body = (
        paper.title +
        " " +
        paper.abstract +
        " " +
        (paper.subjectTerms ?? []).join(" ")
      ).toLowerCase();
      const titleWords = new Set(lowerWords(title));
      const bodyWords = new Set(lowerWords(body));
      const titleMatches = anchors.filter((word) => titleWords.has(word)).length;
      const abstractMatches = anchors.filter((word) => bodyWords.has(word)).length;
      if (anchors.length >= 2 && abstractMatches < anchors.length) return [];

      const guideline = isPublishedGuideline(paper);
      const titledGuidance = /\b(guidelines?|consensus statement|expert consensus)\b/i.test(
        paper.title,
      );
      const review = paper.types.some((type) =>
        /systematic review|meta.analysis|^review$/i.test(type),
      );
      const clinicalFocus =
        /management|treatment|diagnos|severity|recommendation|valve replacement|clinical practice|evaluation/i.test(
          title,
        );
      const niche =
        /polygenic|genetic risk|risk score|prognos|predictor|post.hoc|bleeding|complication|phenotype/i.test(
          title,
        );
      const competing =
        (anchors.includes("stenosis") &&
          /\bregurgitation\b/i.test(title) &&
          !/\bstenosis\b/i.test(title)) ||
        (anchors.includes("regurgitation") &&
          /\bstenosis\b/i.test(title) &&
          !/\bregurgitation\b/i.test(title));
      const relevance = anchors.length
        ? 1.7 * (titleMatches / anchors.length) + 0.65 * (abstractMatches / anchors.length)
        : 0.8;
      const evidenceType = guideline
        ? 2.1
        : titledGuidance
          ? 1.55
          : review
            ? 1.05
            : paper.types.some((type) => /randomized controlled trial/i.test(type))
              ? 0.45
              : 0.1;
      const recency = paper.year ? 0.25 / (1 + Math.max(0, year - paper.year) / 8) : 0.05;
      const pubmedRank = 0.2 * (1 - paper.position / 60);
      const score =
        relevance +
        evidenceType +
        recency +
        pubmedRank +
        (clinicalFocus ? 0.35 : 0) -
        (broad && niche ? 0.65 : 0) -
        (competing ? 1.8 : 0);
      return [{ ...paper, score }];
    })
    .sort((a, b) => b.score - a.score || a.position - b.position);

  // On broad teaching questions, spread evidence across guidelines, reviews,
  // diagnosis and treatment before considering another niche risk study.
  if (!broad) return scored;
  const kept: ResearchPaper[] = [];
  const overflow: ResearchPaper[] = [];
  const counts = new Map<string, number>();
  for (const paper of scored) {
    const group = category(paper);
    const n = counts.get(group) ?? 0;
    if (n >= (group === "guideline" || group === "review" ? 4 : 2)) {
      overflow.push(paper);
    } else {
      kept.push(paper);
      counts.set(group, n + 1);
    }
  }
  return [...kept, ...overflow];
}
