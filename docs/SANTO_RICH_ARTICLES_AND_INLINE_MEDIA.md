# Santo Rich Articles & Inline Medical Images — approved source UX

Tracking: [Issue #96](https://github.com/geminiamo0-ship-it/santoreno/issues/96). Product decisions approved 14 October 2026.

## Reader behavior

- Original licensed article HTML remains a **presentation-only** document, kept privately in R2 and served only after Santo-authenticated authorization. Use one canonical article HTML record alongside the unchanged plain-text per-section AI Search index.
- AMBOSS: adapt the MedPark `src/pages/library/amboss.ts` interactive reader behavior (cards, medical glossary popovers, learning tips, original in-article links, responsive medical tables and image viewer). Santo must own its implementation; do not import MedPark's React app or tenant-specific behavior. The source library ID selects the presentation style, not tenant identity.
- Non-AMBOSS: generic accessible HTML reader preserving its native safe headings, lists, tables, block quotations, figures, inline pictures, and links. Do not impose AMBOSS formatting.
- Remove study-only controls: no High-Yield toggle, notebook, notes, highlights/annotations, Create Test, AI Summary or study toolbar.
- Cited source opens at the server-verified section and provides scroll-to-target/highlight. Existing source snapshots/auth remain authoritative.
- Desktop: side drawer; mobile: full-screen reader with visible close/back. Popovers must be keyboard- and touch-accessible, never hover-only.

## Media rules

The source `<img src>` inside original HTML is the authority for original image placement. Only allow approved R2 `offline_media` media URLs or resolve relative `offline_media/<filename>` paths against `https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev`. Never reconstruct a filename, mutate its extension, mix origins, or fetch unexpected hosts. Unsupported images are omitted with an appropriate fallback. Keep images in tables/cards in-place, lazy-load in reader, allow image zoom/captions, avoid layout shift.

Chat image behavior is a **separate feature slice**, not part of the import foundation. From citation-authorized evidence, select a bounded set of relevant images, preserve their source association, render alongside the explanatory passage in the chat and allow opening the verified source. Do not trust arbitrary model-authored Markdown image URLs. Do not make chat text depend on completed image fetches.

## Security and data contract

- Schema V1 articles remain readable with optional `contentHtml`. New importer includes strictly allowlisted, nonexecutable markup. Existing `sections` are retained unchanged for the R2 `medical-search/v1` files.
- Importer removes script/style/iframe/event-handler attributes, forbidden URL schemes, foreign media hosts, and high-risk CSS. It allows only a narrow set of HTML presentation tags, attributes and style declarations; the reader will run **a second independent DOM sanitizer** before any HTML enters the DOM or before decoding/populating popover contents. Never use model-generated HTML in the reader.
- Authenticated Santo reader endpoint remains staging-only; no public licensed corpus objects. No storage-key leaks, no source forgery, no change to quota or private AI Search.
- Max article JSON object 2 MB and HTML field 1.5M characters. Fail closed if exporter inputs exceed guardrails; adjust only after measuring licensed data and updating tests.
- This first PR intentionally **does not render** the new HTML field. It only makes a secure, backward-compatible import/contract foundation. Existing text reader remains until a separately validated UI integration.

## Acceptance plan

1. Unit: preserved AMBOSS headings/ids/cards/tables, original image path resolution and safe absolute media URL; hostile scripts/handlers/unsafe URLs absent; legacy schema backward-compatible; oversized field fails.
2. CI: Prettier, lint, typecheck, Python import tests, Vitest, build, smoke. Assert old search/citation keys do not change.
3. Licensed staging: verify article object sizes/checksums; verify images exist on approved media CDN, test long/short articles from each source and correct section anchors.
4. UI PR: use MedPark library component as fidelity reference; screenshot compare desktop/mobile/light/dark and verify popovers/table/image viewer/links. Keep annotation and study controls absent.
5. Chat PR: verify source-bound image near answer, no arbitrary model URLs, lazy load, no uncited images, no auth leaks.
6. AI PR: bilingual Royal Professor adaptive style; evaluate model availability and provider-native safe streaming behind a staging flag. Preserve old buffered validated SSE until staged medical safety tests pass.

**Current state:** foundation changes on a draft PR only. No licensed library re-export/reupload, live pilot validation, UI component port, chat image integration, model change, or production rollout has occurred.
