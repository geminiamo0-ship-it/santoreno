/** Source HTML only, never model-generated HTML. Staged behind Santo's authenticated reader. */
const MEDIA_ORIGIN = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev";
const MEDIA_PATH = /^\/offline_media\/[A-Za-z0-9_%+.-]+\.(?:jpg|jpeg|png|webp|gif)$/i;
const TAGS = new Set(
  "p div span section article h1 h2 h3 h4 h5 h6 b strong i em u s small sub sup br hr ul ol li dl dt dd blockquote pre code table thead tbody tfoot tr th td a img figure figcaption caption details summary mark abbr time".split(
    " ",
  ),
);
const ATTR = new Set(["class", "id", "title", "alt", "aria-label", "colspan", "rowspan"]);
const DATA = new Set([
  "data-content",
  "data-offline-popover",
  "data-title",
  "data-learningcard-id",
  "data-lxid",
  "data-anker",
  "data-type",
  "data-image-id",
  "data-description",
]);
const STYLES = new Set([
  "color",
  "background-color",
  "text-align",
  "font-weight",
  "font-style",
  "text-decoration",
]);
const STYLE_VALUE =
  /^(?:#[0-9a-f]{3,8}|[a-z]{2,30}|rgba?\([0-9., %]+\)|left|right|center|justify|bold|normal|italic|underline|none)$/i;

/** Media must come from the previously approved public R2 path, never a model URL. */
export function approvedMedicalImageUrl(value: string): string | null {
  if (typeof value !== "string" || !value || value.length > 900) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== MEDIA_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !MEDIA_PATH.test(url.pathname)
    ) {
      return null;
    }
    const name = decodeURIComponent(url.pathname.slice("/offline_media/".length));
    if (
      name.includes("..") ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\x00-\x1f]/.test(name)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeLink(value: string): string | null {
  if (/^#[A-Za-z0-9_:.~-]{1,180}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && value.length < 1000) {
      return url.href;
    }
  } catch {
    /* relative/invalid */
  }
  return null;
}

function scrub(root: ParentNode): void {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (!TAGS.has(tag)) {
      // Remove unknown wrappers entirely: don't allow SVG/script/iframe/custom elements.
      element.remove();
      continue;
    }
    const wasOpen = tag === "details" && element.hasAttribute("open");
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      let ok = false;
      if (ATTR.has(name)) {
        ok =
          name === "class" || name === "id"
            ? /^[\w :.\-]{1,512}$/.test(value)
            : value.length <= 500;
        if (["rowspan", "colspan"].includes(name)) ok = /^\d{1,3}$/.test(value);
      } else if (DATA.has(name)) {
        ok = value.length <= 10000;
      } else if (name === "href" && tag === "a") {
        const link = safeLink(value);
        if (link) {
          element.setAttribute("href", link);
          ok = true;
        }
      } else if (name === "src" && tag === "img") {
        const url = approvedMedicalImageUrl(value);
        if (url) {
          element.setAttribute("src", url);
          ok = true;
        }
      } else if (name === "style") {
        const declarations = value
          .split(";")
          .map((entry) => {
            const index = entry.indexOf(":");
            if (index <= 0) return "";
            const property = entry.slice(0, index).trim().toLowerCase();
            const content = entry.slice(index + 1).trim();
            return STYLES.has(property) && STYLE_VALUE.test(content)
              ? property + ":" + content
              : "";
          })
          .filter(Boolean);
        if (declarations.length) {
          element.setAttribute("style", declarations.join(";"));
          ok = true;
        }
      }
      if (!ok) element.removeAttribute(attr.name);
    }
    if (tag === "img") {
      if (!element.hasAttribute("src")) {
        element.remove();
        continue;
      }
      element.setAttribute("loading", "lazy");
      element.setAttribute("referrerpolicy", "no-referrer");
    }
    if (wasOpen) element.setAttribute("open", "");
    if (tag === "a" && (element.getAttribute("href") ?? "").startsWith("https://")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
    scrub(element);
  }
}

/**
 * Independent browser-side allowlist; converter already sanitized source markup at import.
 * Returns no HTML without DOMParser rather than opening an unsafe fallback.
 */
export function sanitizeArticleForReader(value: string): string {
  if (typeof DOMParser === "undefined" || typeof value !== "string" || value.length > 1_500_000) {
    return "";
  }
  const doc = new DOMParser().parseFromString(value, "text/html");
  scrub(doc.body);
  return doc.body.innerHTML;
}

/** AMBOSS's h2 card convention, adapted from MedPark without its study toolbar. */
export function formatArticleForReader(value: string, libraryId: string): string {
  const clean = sanitizeArticleForReader(value);
  if (!clean || libraryId !== "amboss" || typeof DOMParser === "undefined") return clean;
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const container = doc.body;
  const children = Array.from(container.childNodes);
  const output = doc.createDocumentFragment();
  let current: HTMLDetailsElement | null = null;
  let body: HTMLElement | null = null;
  for (const node of children) {
    if (node.nodeType === 1 && (node as Element).tagName === "H2") {
      const heading = node as HTMLElement;
      current = doc.createElement("details");
      current.className = "santo-amboss-card";
      current.open = true;
      const summary = doc.createElement("summary");
      summary.appendChild(heading);
      body = doc.createElement("div");
      body.className = "santo-amboss-card-body";
      current.append(summary, body);
      output.appendChild(current);
    } else if (body) {
      body.appendChild(node);
    } else {
      output.appendChild(node);
    }
  }
  container.replaceChildren(output);
  return sanitizeArticleForReader(container.innerHTML);
}

/** Old articles had synthetic s-0001 style section ids, not DOM anchors. */
export function referencedHeadingText(heading: string): string {
  return heading
    .replace(/\s+\(part\s+\d+\)$/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function decodeArticlePopover(value: string): string {
  if (!value || value.length > 10000) return "";
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}
