/**
 * Pure, deterministic selection from the original, provider-returned PMC XML.
 * Only selected original paragraphs and table rows enter the model context.
 * We retain their section headings and never generate/synthesize clinical claims.
 * No separate LLM, embeddings, or additional retrieval operation.
 */
type Passage = { section: string; text: string; score: number; order: number };

function plain(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number: string) => String.fromCodePoint(parseInt(number, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name.toLowerCase()] ?? "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const SPECIAL_GROUPS: { name: string; test: RegExp }[] = [
  { name: "kidney", test: /renal|kidney|dialysis|\bckd\b|\besrd\b/i },
  { name: "cardiac", test: /heart failure|cardiac|coronary|\bhf\b|\bacs\b/i },
  { name: "pregnancy", test: /pregnan|obstetric|fetal|maternal/i },
  { name: "older-adults", test: /elderly|geriatric|older adults?|frail/i },
  { name: "children", test: /children|childhood|pediatric|paediatric|cerebral edema/i },
  { name: "sglt2-euglycemic", test: /sglt|euglyc|\beudka\b/i },
  { name: "pancreatitis", test: /pancreatitis|triglycerides/i },
  { name: "dka-hhs", test: /\bhhs\b|hyperosmolar|mixed presentation/i },
];

function keywords(query: string): string[] {
  const stop = new Set([
    "the", "for", "and", "with", "from", "into", "that", "this", "what", "how",
    "difficulties", "dilemmas", "managing", "management", "conditions", "special",
  ]);
  return [...new Set((query.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((x) => !stop.has(x)))];
}

function sentenceBounded(text: string, limit = 1750): string {
  if (text.length <= limit) return text;
  const edge = text.lastIndexOf(". ", limit);
  if (edge >= limit / 2) return text.slice(0, edge + 1);
  const split = text.lastIndexOf(" ", limit);
  return text.slice(0, split > limit / 2 ? split : limit).trimEnd() + " […]";
}

function collectPassages(xml: string, query: string): Passage[] {
  const terms = keywords(query);
  const passages: Passage[] = [];
  const headings: string[] = [];
  const tokens =
    /<\/sec\s*>|<sec(?:\s[^>]*)?>|<title(?:\s[^>]*)?>[\s\S]*?<\/title>|<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi;
  let index = 0;
  for (const match of xml.matchAll(tokens)) {
    const token = match[0];
    if (/^<sec(?:\s|>)/i.test(token)) {
      headings.push("");
      continue;
    }
    if (/^<\/sec/i.test(token)) {
      headings.pop();
      continue;
    }
    if (/^<title(?:\s|>)/i.test(token)) {
      if (headings.length) headings[headings.length - 1] = plain(token).slice(0, 160);
      continue;
    }
    const body = sentenceBounded(plain(token));
    if (body.length < 65) continue;
    const section = headings.filter(Boolean).join(" / ") || "Article text";
    const lower = (section + " " + body).toLowerCase();
    const matches = terms.filter((word) => lower.includes(word)).length;
    const clinical = /\b(?:insulin|fluid|potassium|dextrose|dialysis|dose|infusion|monitor|replacement|treatment)\b/i.test(body);
    const therapy = /management|treatment|therap|insulin|fluid|electrolyt/i.test(section);
    const numerical = /\b\d+(?:\.\d+)?\s*(?:mL|L|mmol|mg|units?|hours?|minutes?|%|kg)\b/i.test(body);
    const score = matches * 3 + (clinical ? 3 : 0) + (therapy ? 4 : 0) + (numerical ? 2 : 0);
    passages.push({ section, text: body, score, order: index++ });
  }

  // Include actual numbered therapeutic table rows, not just table captions.
  for (const wrapped of xml.matchAll(/<table-wrap(?:\s[^>]*)?>[\s\S]*?<\/table-wrap>/gi)) {
    const table = wrapped[0];
    const caption = /<caption(?:\s[^>]*)?>[\s\S]*?<\/caption>/i.exec(table)?.[0];
    const section = caption ? "Table: " + plain(caption).slice(0, 130) : "Clinical table";
    const rows = [...table.matchAll(/<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi)]
      .map((item) => plain(item[0]))
      .filter((row) => row.length >= 35)
      .slice(0, 14);
    if (!rows.length) continue;
    const text = sentenceBounded(rows.join(" | "));
    const matches = terms.filter((word) => (section + " " + text).toLowerCase().includes(word)).length;
    passages.push({ section, text, score: matches * 3 + 5, order: index++ });
  }
  return passages;
}

export function selectPmcTeachingPassages(
  xml: string,
  question: string,
  maxCharacters: number,
): { text: string; sectionCount: number } {
  const candidates = collectPassages(xml, question);
  const broadSpecial = /special conditions|difficulties and dilemmas|special populations|complex patients/i.test(question);
  const chosen: Passage[] = [];
  const used = new Set<number>();
  let characters = 0;

  function add(p: Passage): void {
    if (used.has(p.order)) return;
    const entryLength = p.section.length + p.text.length + 16;
    if (entryLength > maxCharacters - characters) return;
    used.add(p.order);
    chosen.push(p);
    characters += entryLength;
  }

  // Multi-condition questions MUST cover distinct sections instead of only
  // selecting four passages that repeat the word "management".
  if (broadSpecial) {
    for (const group of SPECIAL_GROUPS) {
      const options = candidates
        .filter((p) => group.test.test(p.section + " " + p.text))
        .sort((a, b) => b.score - a.score || a.order - b.order);
      if (options[0]) add(options[0]);
      if (options[1]) add(options[1]);
    }
  }

  // For single-condition questions, prefer the matching paragraphs.
  const relevant = candidates
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  for (const passage of relevant) add(passage);
  return {
    text: chosen
      .sort((a, b) => a.order - b.order)
      .map((p) => "PMC section: " + p.section + "\n" + p.text)
      .join("\n\n"),
    sectionCount: new Set(chosen.map((p) => p.section)).size,
  };
}
