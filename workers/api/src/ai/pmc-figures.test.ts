import { describe, expect, it, vi } from "vitest";

import {
  extractPmcFigureCaptions,
  approvedPmcMedia,
  loadLicensedPmcFigures,
} from "./pmc-figures";

const PMCID = "PMC10009416";
const PATH = "s3://pmc-oa-opendata/PMC10009416.1/";
const MD5 = "?md5=39209b49c555fa939d5108a4b6c4fe92";
const good = {
  pmcid: PMCID,
  version: 1,
  license_code: "CC BY",
  is_pmc_openaccess: true,
  is_retracted: false,
  media_urls: [PATH + "gr1.jpg" + MD5, PATH + "wrong-name.png" + MD5],
};
const fullText = [
  '<article><fig id="f1"><label>Figure 1</label><caption><p>Severe aortic stenosis Doppler',
  'imaging demonstrates valve gradients in the clinical population.</p></caption>',
  '<graphic xlink:href="gr1"/></fig>',
  '<fig id="f2"><caption><p>Nonmatching X-ray of the chest with cardiomegaly.</p></caption>',
  '<graphic xlink:href="gr2"/></fig>',
  '<fig id="f3"><caption><p>Third-party image reproduced with permission.</p></caption>',
  '<graphic xlink:href="wrong-name.png"/></fig></article>',
].join("");

describe("only real licensed figures from original PMC OA cloud metadata", () => {
  it("extracts exact JATS graphic/figure captions; skips third-party rights caveats", () => {
    const figures = extractPmcFigureCaptions(fullText);
    expect(figures).toEqual([
      expect.objectContaining({ id: "f1", name: "gr1" }),
      expect.objectContaining({ id: "f2", name: "gr2" }),
    ]);
    expect(figures.map((f) => f.caption).join(" ")).toContain("Doppler");
  });

  it("requires actual media_urls with correct PMCID, version, basename, md5 and license", () => {
    expect(approvedPmcMedia(good, PMCID, { name: "gr1" })).toEqual({
      src: "https://pmc-oa-opendata.s3.amazonaws.com/PMC10009416.1/gr1.jpg" + MD5,
      license: "CC BY",
    });
    for (const invalid of [
      { ...good, pmcid: "PMC222" },
      { ...good, version: -1 },
      { ...good, is_pmc_openaccess: false },
      { ...good, license_code: "CC BY-NC" },
      { ...good, license_code: "TDM" },
      { ...good, is_retracted: true },
      { ...good, media_urls: [PATH + "gr12.jpg" + MD5] },
      { ...good, media_urls: ["s3://attacker.invalid/PMC10009416.1/gr1.jpg" + MD5] },
      { ...good, media_urls: [PATH + "gr1.jpg?md5=garbage"] },
    ]) {
      expect(approvedPmcMedia(invalid, PMCID, { name: "gr1" })).toBeNull();
    }
  });

  it("never mixes a figure from a different image or article", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("PMC10009416.1.json")) return Response.json(good);
      return new Response("404", { status: 404 });
    });
    const found = await loadLicensedPmcFigures(PMCID, fullText, request as typeof fetch);
    expect(found).toEqual([
      {
        src: "https://pmc-oa-opendata.s3.amazonaws.com/PMC10009416.1/gr1.jpg" + MD5,
        caption: expect.stringContaining("Doppler"),
        pmcid: PMCID,
        figureId: "f1",
        license: "CC BY",
      },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.startsWith("https://pmc-oa-opendata.s3.amazonaws.com/metadata/"))).toBe(true);
  });

  it("fails closed, without changing the research answer, if metadata is unavailable", async () => {
    const failed = vi.fn(async () => new Response("offline", { status: 503 }));
    expect(await loadLicensedPmcFigures(PMCID, fullText, failed as typeof fetch)).toEqual([]);
    expect(await loadLicensedPmcFigures("PMC../evil", fullText, failed as typeof fetch)).toEqual([]);
    expect(failed).toHaveBeenCalledTimes(3);
  });

  it("never accepts HTML, SVG, external links or script-bearing media", () => {
    expect(extractPmcFigureCaptions(
      '<fig><caption><p>Malicious media path in figure caption</p></caption>' +
        '<graphic xlink:href="../private/gr1.jpg"/></fig>',
    )).toEqual([]);
    expect(approvedPmcMedia(
      { ...good, media_urls: [PATH + "gr1.svg" + MD5] }, PMCID, { name: "gr1" },
    )).toBeNull();
  });
});
