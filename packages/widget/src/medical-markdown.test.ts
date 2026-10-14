import { describe, expect, it } from "vitest";
import { renderSantoMarkdown } from "./medical-markdown";

describe("Santo safe medical Markdown", () => {
  it("renders comparative tables and teaching callout structures", () => {
    const parts = renderSantoMarkdown(
      [
        "## ECG interpretation",
        "| Finding | Meaning |",
        "|---|---|",
        "| ST elevation | Consider STEMI |",
        "### Clinical Pearl",
        "**Look for** reciprocal changes.",
        "- Assess symptoms",
        "- Compare leads",
      ].join("\n"),
    );
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.map((part) => part.strings.join("")).join(" ")).toContain("<table>");
    expect(parts.map((part) => part.strings.join("")).join(" ")).toContain("md-callout");
  });

  it("never inserts model-controlled raw HTML into Lit templates", () => {
    const input =
      "<script>alert('x')</script>\n\n| A | B |\n|---|---|\n| <img src=x onerror=alert(1)> | yes |";
    const result = renderSantoMarkdown(input);
    const staticTemplates = result.map((part) => part.strings.join("")).join(" ");
    expect(staticTemplates).not.toContain("<script>");
    expect(staticTemplates).not.toContain("<img");
    expect(result.length).toBe(2);
  });

  it("handles Arabic/English mixed paragraphs, fenced code, and lists safely", () => {
    const rendered = renderSantoMarkdown(
      "## الخلاصة\nاحفظ **Key point**\n\n1. First\n2. ثاني\n\n```txt\na < b\n```",
    );
    expect(rendered).toHaveLength(3);
  });
});
