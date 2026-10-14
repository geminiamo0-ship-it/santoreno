"""Strict, dependency-free HTML allowlist for *licensed* Santo article imports.

Stored markup is presentation data, NEVER model output or trusted executable HTML.
A client must apply its own vetted HTML sanitizer immediately before DOM insertion.
Untrusted and external image hosts are not forwarded to the article reader.
"""
from html import escape
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit

MEDIA = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev"
BASE = MEDIA + "/offline_media/"

def media_url(value):
    source = (value or "").strip()
    if source.startswith(BASE):
        source = "offline_media/" + source[len(BASE):]
    else:
        # Legacy licensed content contains relative image paths only.
        source = source.lstrip("/")
    if not source.startswith("offline_media/") or any(c in source for c in ("?", "#", "\\", "\x00")):
        return None
    filename = unquote(source[len("offline_media/"):])
    if not re.fullmatch(r"[A-Za-z0-9_.+ -]{1,180}", filename) or ".." in filename:
        return None
    if Path(filename).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return None
    return BASE + quote(filename, safe=".-_+")

_ALLOWED = frozenset("""
p div span section article h1 h2 h3 h4 h5 h6 b strong i em u s small sub sup
br hr ul ol li dl dt dd blockquote pre code table thead tbody tfoot tr th td
a img figure figcaption caption details summary mark abbr time
""".split())
_VOID = frozenset({"br", "hr", "img"})
_DROP_CONTENT = frozenset({"script", "style", "svg", "iframe", "object", "embed", "noscript", "form", "select", "textarea", "template"})
_DATA_NAME = re.compile(r"data-[a-z0-9_-]{1,35}$")
_CLASS_ID = re.compile(r"[\w :.\-]{1,512}$")
_COLOR = re.compile(r"(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{2,30}|rgba?\([0-9., %]+\))$")
_ALLOWED_CSS = {"color", "background-color", "text-align", "font-weight", "font-style", "text-decoration"}
_CSS_VALUES = {"left", "center", "right", "justify", "bold", "normal", "italic", "underline", "none"}
_MAX_SOURCE_CHARS = 1_500_000

def _safe_style(raw):
    declarations = []
    for declaration in raw.split(";"):
        if ":" not in declaration:
            continue
        prop, value = (part.strip() for part in declaration.split(":", 1))
        prop = prop.lower()
        if prop not in _ALLOWED_CSS or len(value) > 65:
            continue
        if value.lower() in _CSS_VALUES or (prop in {"color", "background-color"} and _COLOR.fullmatch(value)):
            declarations.append(prop + ":" + value)
    return ";".join(declarations)

def _safe_href(href):
    href = (href or "").strip()
    if href.startswith("#") and re.fullmatch(r"#[A-Za-z0-9_:.~-]{1,180}", href):
        return href
    if href.startswith("/") and not href.startswith("//") and not any(c in href for c in ("\\", "\x00")):
        return href[:1000]
    if len(href) <= 1000:
        parsed = urlsplit(href)
        if parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password:
            return href
    return None

class _ArticleHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.open_tags = []
        self.blocked = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.blocked:
            if tag in _DROP_CONTENT:
                self.blocked += 1
            return
        if tag in _DROP_CONTENT:
            self.blocked = 1
            return
        if tag not in _ALLOWED:
            return
        pairs = dict(attrs)
        safe = {}
        if tag == "img":
            src = media_url(pairs.get("src"))
            if not src:
                return
            safe["src"] = src
            safe["loading"] = "lazy"
        for key, value in attrs:
            key = key.lower()
            value = value or ""
            if key in {"class", "id"} and _CLASS_ID.fullmatch(value):
                safe[key] = value
            elif key in {"title", "alt", "aria-label"}:
                safe[key] = value[:500]
            elif key == "style":
                style = _safe_style(value)
                if style:
                    safe[key] = style
            elif key == "href" and tag == "a":
                href = _safe_href(value)
                if href:
                    safe[key] = href
            elif key in {"colspan", "rowspan", "width", "height"} and value.isdigit() and 0 < int(value) <= 32768:
                safe[key] = value
            elif _DATA_NAME.fullmatch(key) and len(value) <= 10000:
                # AMBOSS popovers use encoded medical text in data-* attributes.
                # The future client must sanitize decoded popover HTML separately.
                safe[key] = value
        if tag == "a" and safe.get("href", "").startswith("https://"):
            safe["rel"] = "noopener noreferrer"
        attributes = "".join(" " + key + '="' + escape(value, quote=True) + '"' for key, value in safe.items())
        self.output.append("<" + tag + attributes + ">")
        if tag not in _VOID:
            self.open_tags.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.blocked:
            if tag in _DROP_CONTENT:
                self.blocked -= 1
            return
        if tag not in self.open_tags:
            return
        while self.open_tags:
            current = self.open_tags.pop()
            self.output.append("</" + current + ">")
            if current == tag:
                break

    def handle_data(self, data):
        if not self.blocked:
            self.output.append(escape(data, quote=False))

    def finish(self):
        while self.open_tags:
            self.output.append("</" + self.open_tags.pop() + ">")
        return "".join(self.output)

def sanitize_medical_html(raw):
    if not isinstance(raw, str):
        raw = ""
    if len(raw) > _MAX_SOURCE_CHARS:
        raise ValueError("Medical article HTML exceeds safety bound")
    parser = _ArticleHTML()
    parser.feed(raw)
    return parser.finish()
