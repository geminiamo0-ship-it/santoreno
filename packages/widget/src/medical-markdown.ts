import { html, type TemplateResult } from "lit";

/**
 * A deliberately small, safe GitHub-Flavored Markdown renderer.
 * All model text is passed through Lit's escaped interpolations.
 * No innerHTML, unsafeHTML, event attributes, raw HTML, or remote image loads.
 */
const CALLOUT =
  /^(clinical pearl|clinical tip|common trap|exam tip|key takeaway|remember|red flag|high[- ]yield|الخلاصة|نقطة مهمة|للامتحان|تنبيه)\s*:?$/i;
const BREAK = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*|```|---+\s*$)/;

function inline(text: string): TemplateResult {
  // Support bold, italics and inline code without accepting arbitrary HTML.
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g);
  return html`${parts.map((part) =>
    part.startsWith("**") && part.endsWith("**")
      ? html`<strong>${part.slice(2, -2)}</strong>`
      : part.startsWith("`") && part.endsWith("`")
        ? html`<code dir="ltr">${part.slice(1, -1)}</code>`
        : part.startsWith("*") && part.endsWith("*")
          ? html`<em>${part.slice(1, -1)}</em>`
          : part,
  )}`;
}

function cells(line: string): string[] {
  let t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const result: string[] = [];
  let value = "";
  let escaped = false;
  for (const char of t) {
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      result.push(value.trim());
      value = "";
      continue;
    }
    value += char;
  }
  result.push(value.trim());
  return result;
}

function isSeparator(line: string): boolean {
  const values = cells(line);
  return values.length >= 2 && values.every((part) => /^:?-{3,}:?$/.test(part));
}

export function renderSantoMarkdown(markdown: string): TemplateResult[] {
  const lines = markdown.replace(/\r\n?/g, "\n").slice(0, 30000).split("\n");
  const output: TemplateResult[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim().slice(0, 32);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        code.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      output.push(
        html`<div class="md-code-block">
          ${language ? html`<span class="md-code-lang">${language}</span>` : ""}
          <pre dir="ltr"><code>${code.join("\n")}</code></pre>
        </div>`,
      );
      continue;
    }

    if (i + 1 < lines.length && line.includes("|") && isSeparator(lines[i + 1]!)) {
      const header = cells(line).slice(0, 8);
      const rows: string[][] = [];
      i += 2;
      while (
        i < lines.length &&
        rows.length < 40 &&
        lines[i]!.trim().includes("|") &&
        lines[i]!.trim()
      ) {
        rows.push(cells(lines[i]!).slice(0, 8));
        i++;
      }
      output.push(
        html`<div
          class="md-table-scroll"
          role="region"
          aria-label="Medical comparison table"
          tabindex="0"
        >
          <table>
            <thead>
              <tr>
                ${header.map((value) => html`<th dir="auto">${inline(value)}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (row) =>
                  html`<tr>
                    ${header.map((_, n) => html`<td dir="auto">${inline(row[n] || "")}</td>`)}
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const title = heading[2]!.trim();
      const highlight = CALLOUT.test(title);
      if (highlight) {
        const details: string[] = [];
        i++;
        while (i < lines.length && lines[i]!.trim() && !BREAK.test(lines[i]!.trim())) {
          details.push(lines[i]!.trim());
          i++;
        }
        output.push(
          html`<aside class="md-callout" dir="auto">
            <strong>${title}</strong>
            ${details.length ? html`<p>${inline(details.join(" "))}</p>` : ""}
          </aside>`,
        );
      } else {
        output.push(html`<h3 class="md-heading" dir="auto">${inline(title)}</h3>`);
        i++;
      }
      continue;
    }

    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      output.push(html`<hr class="md-rule" />`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quotes: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        quotes.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      output.push(
        html`<blockquote class="md-quote" dir="auto">${inline(quotes.join(" "))}</blockquote>`,
      );
      continue;
    }
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(line)) {
      const ordered = /^\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^([-*+]\s+|\d+[.)]\s+)/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^([-*+]\s+|\d+[.)]\s+)/, ""));
        i++;
      }
      output.push(
        ordered
          ? html`<ol class="md-list" dir="auto">
              ${items.map((x) => html`<li>${inline(x)}</li>`)}
            </ol>`
          : html`<ul class="md-list" dir="auto">
              ${items.map((x) => html`<li>${inline(x)}</li>`)}
            </ul>`,
      );
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !BREAK.test(lines[i]!.trim()) &&
      !(i + 1 < lines.length && lines[i]!.includes("|") && isSeparator(lines[i + 1]!))
    ) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    output.push(html`<p class="md-paragraph" dir="auto">${inline(paragraph.join(" "))}</p>`);
  }
  return output;
}
