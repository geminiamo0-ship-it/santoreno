import { describe, expect, it } from "vitest";

import { INITIAL_WIDGET_UI_STATE, reduceWidgetUi } from "./ui-state";

describe("Santo widget shell state", () => {
  it("starts closed with All Libraries selected", () => {
    expect(INITIAL_WIDGET_UI_STATE).toEqual({
      expanded: false,
      fullscreen: false,
      libraryId: null,
      sourceMode: "libraries",
    });
  });

  it("opens/closes launcher and clears full screen when closed", () => {
    const open = reduceWidgetUi(INITIAL_WIDGET_UI_STATE, { type: "toggle" });
    expect(open.expanded).toBe(true);
    const full = reduceWidgetUi(open, { type: "fullscreen" });
    expect(full).toMatchObject({ expanded: true, fullscreen: true });
    const closed = reduceWidgetUi(full, { type: "close" });
    expect(closed).toEqual(INITIAL_WIDGET_UI_STATE);
  });

  it("leaves selected library unchanged when exiting full screen", () => {
    const filtered = reduceWidgetUi(INITIAL_WIDGET_UI_STATE, {
      type: "library",
      libraryId: "mrcp_part_1",
    });
    const full = reduceWidgetUi(filtered, { type: "fullscreen" });
    expect(full).toMatchObject({ expanded: true, fullscreen: true, libraryId: "mrcp_part_1" });
    expect(reduceWidgetUi(full, { type: "fullscreen" })).toMatchObject({
      expanded: true,
      fullscreen: false,
      libraryId: "mrcp_part_1",
    });
    expect(reduceWidgetUi(full, { type: "toggle" })).toMatchObject({
      expanded: false,
      fullscreen: false,
      libraryId: "mrcp_part_1",
    });
  });

  it("rejects unsafe library keys and allows resetting to all libraries", () => {
    const initial = INITIAL_WIDGET_UI_STATE;
    for (const unsafe of [
      "../other-tenant",
      "https://evil.invalid",
      "not a key",
      "<img>",
      "mrcp%2Fprivate",
      "A".repeat(65),
    ]) {
      expect(reduceWidgetUi(initial, { type: "library", libraryId: unsafe })).toBe(initial);
    }
    const filtered = reduceWidgetUi(initial, { type: "library", libraryId: "nbme" });
    expect(filtered.libraryId).toBe("nbme");
    expect(reduceWidgetUi(filtered, { type: "library", libraryId: null }).libraryId).toBeNull();
  });

  it("switches sources without retaining an incompatible library filter", () => {
    const filtered = reduceWidgetUi(INITIAL_WIDGET_UI_STATE, {
      type: "library",
      libraryId: "usmle",
    });
    const research = reduceWidgetUi(filtered, { type: "source-mode", sourceMode: "research" });
    expect(research).toMatchObject({ sourceMode: "research", libraryId: null });
    expect(reduceWidgetUi(research, { type: "source-mode", sourceMode: "libraries" })).toMatchObject({
      sourceMode: "libraries",
      libraryId: null,
    });
  });

  it("does not mutate state objects during a toggle or filter transition", () => {
    const old = Object.freeze({ ...INITIAL_WIDGET_UI_STATE });
    reduceWidgetUi(old, { type: "toggle" });
    reduceWidgetUi(old, { type: "library", libraryId: "usmle" });
    expect(old).toEqual(INITIAL_WIDGET_UI_STATE);
  });
});
