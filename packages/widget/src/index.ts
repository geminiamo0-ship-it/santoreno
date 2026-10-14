import { html, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GroundedAiQueryResponse } from "@santo/contracts/ai";
import type { ConversationAnswer, ConversationTurn } from "@santo/contracts/conversation";
import type {
  LibraryArticle,
  LibraryCatalog,
  LibraryArticleListResponse,
} from "@santo/contracts/library-reader";
import type { TrustedSourceDetailResponse } from "@santo/contracts/source";

import {
  SantoConversationClient,
  SantoWidgetApiError,
  type SantoSessionProvider,
} from "./conversation-client";
import { widgetStyles } from "./styles";
import { approvedMedicalImageUrl, decodeArticlePopover, formatArticleForReader, referencedHeadingText, sanitizeArticleForReader } from "./article-rich-html";
import { renderSantoMarkdown } from "./medical-markdown";
import { readableMedicalSourceTitle } from "./source-title";
import { SANTO_WIDGET_TAG } from "./tag-name";
import {
  INITIAL_WIDGET_UI_STATE,
  reduceWidgetUi,
  type WidgetUiAction,
  type WidgetUiState,
} from "./ui-state";

export interface SantoWidgetLibrary {
  id: string;
  label: string;
}

export interface SantoWidgetConfiguration {
  /** Browser-accessible Santo API, ideally a same-origin authenticated proxy. */
  apiBaseUrl: string;
  /** Obtains a short-lived Santo END-USER access token via customer's backend. */
  sessionProvider: SantoSessionProvider;
  /** Stable tenant+end-user scope; optional, disables refresh persistence when omitted. */
  sessionScope?: string;
}

/** Browser UI only. All identity, quota, ordering and citation checks remain on Santo. */
export class SantoAiElement extends LitElement {
  static override styles = widgetStyles;

  static override properties = {
    ui: { state: true },
    libraries: { attribute: false },
    assistantName: { type: String, attribute: "assistant-name" },
    turns: { state: true },
    draft: { state: true },
    pending: { state: true },
    busy: { state: true },
    statusText: { state: true },
    remaining: { state: true },
    source: { state: true },
    imageUrl: { state: true },
    readerOpen: { state: true },
    readerArticle: { state: true },
    readerHighlight: { state: true },
    readerLibraries: { state: true },
    readerItems: { state: true },
    readerLibrary: { state: true },
    readerNext: { state: true },
    readerPopover: { state: true },
    readerLightbox: { state: true },
  };

  private ui: WidgetUiState = INITIAL_WIDGET_UI_STATE;
  libraries: readonly SantoWidgetLibrary[] = [];
  assistantName = "Santo";
  private client: SantoConversationClient | null = null;
  private turns: readonly ConversationTurn[] = [];
  private draft = "";
  private pending = "";
  private busy = false;
  private statusText = "Connect a Santo session to begin.";
  private remaining: number | null = null;
  private source: TrustedSourceDetailResponse | null = null;
  private imageUrl: string | null = null;
  private readerOpen = false;
  private readerArticle: LibraryArticle | null = null;
  private readerHighlight: string | null = null;
  private readerLibraries: LibraryCatalog["libraries"] = [];
  private readerItems: LibraryArticleListResponse["articles"] = [];
  private readerLibrary: string | null = null;
  private readerNext: number | null = null;
  private readerPopover: { title: string; html: string } | null = null;
  private readerLightbox: { src: string; alt: string } | null = null;
  private latestAnswer: GroundedAiQueryResponse | null = null;
  private latestQuestion = "";

  /** Called by customer frontend AFTER its own authenticated user has been resolved. */
  configure(config: SantoWidgetConfiguration): void {
    if (this.busy) return;
    this.cleanupImage();
    let store: Storage | undefined;
    try {
      store = config.sessionScope ? window.sessionStorage : undefined;
    } catch {
      // Private browsing or restricted frames may disable session storage.
    }
    this.client = new SantoConversationClient({
      apiBaseUrl: config.apiBaseUrl,
      sessionProvider: config.sessionProvider,
      store,
      storeKey: config.sessionScope,
    });
    this.turns = [];
    this.latestAnswer = null;
    this.pending = "";
    this.remaining = null;
    this.readerOpen = false;
    this.readerArticle = null;
    this.readerLibrary = null;
    this.readerItems = [];
    this.readerLibraries = [];
    this.readerNext = null;
    this.readerPopover = null;
    this.readerLightbox = null;
    this.statusText = "Session connected. You can ask a question.";
    void this.reconnect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cleanupImage();
    this.readerPopover = null;
    this.readerLightbox = null;
  }

  private cleanupImage(): void {
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = null;
    this.source = null;
  }

  private async reconnect(): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    try {
      this.turns = await this.client.connect();
      const last = this.turns.filter((turn) => turn.response !== null).at(-1);
      this.remaining = last?.response?.usage.remaining ?? this.remaining;
      this.pending = this.client.pending?.text ?? "";
      this.statusText = this.client.pending
        ? "An earlier question may have completed. Retry it with the same key."
        : "Connected to Santo.";
    } catch (error) {
      this.statusText =
        error instanceof SantoWidgetApiError ? error.code : "WIDGET_CONNECTION_FAILED";
    } finally {
      this.busy = false;
    }
  }

  private transition(action: WidgetUiAction): void {
    const previous = this.ui;
    this.ui = reduceWidgetUi(this.ui, action);
    if (this.ui === previous) return;
    this.dispatchEvent(
      new CustomEvent("santo-ui-change", {
        detail: {
          open: this.ui.expanded,
          fullscreen: this.ui.fullscreen,
          libraryId: this.ui.libraryId,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggle(): void {
    this.transition({ type: "toggle" });
    if (this.ui.expanded) {
      void this.updateComplete.then(() =>
        this.renderRoot.querySelector<HTMLButtonElement>("[data-close]")?.focus(),
      );
    }
  }

  private closePanel(): void {
    this.cleanupImage();
    this.transition({ type: "close" });
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLButtonElement>("[data-launcher]")?.focus(),
    );
  }

  private onLibraryChange(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = target.value || null;
    const available = this.libraries.some(
      (item) => item.id === value && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id),
    );
    if (value !== null && !available) return;
    this.transition({ type: "library", libraryId: value });
  }

  private async sendQuestion(): Promise<void> {
    if (!this.client || this.busy) return;
    const question = this.client.pending?.text ?? this.draft.trim();
    const library = this.client.pending?.libraryId ?? this.ui.libraryId;
    if (!question || question.length > 4000) return;
    this.busy = true;
    this.statusText = "Searching verified medical evidence…";
    try {
      const answer = await this.client.ask(question, library);
      this.latestAnswer = answer;
      this.latestQuestion = question;
      this.draft = "";
      this.pending = "";
      this.turns = [...this.client.completedTurns];
      this.remaining = answer.usage.remaining;
      this.statusText = "Answer verified and saved.";
    } catch (error) {
      this.pending = this.client.pending?.text ?? question;
      this.statusText = error instanceof SantoWidgetApiError ? error.code : "WIDGET_REQUEST_FAILED";
    } finally {
      this.busy = false;
    }
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    void this.sendQuestion();
  }

  private onComposeKey(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.sendQuestion();
    }
  }

  private async browseLibraries(): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.readerOpen = true;
    this.readerArticle = null;
    this.readerHighlight = null;
    this.readerLibrary = null;
    try {
      const data = await this.client.libraryCatalog();
      this.readerLibraries = data.libraries;
      this.statusText = "Browse Santo medical libraries.";
    } catch (error) {
      this.statusText = error instanceof SantoWidgetApiError ? error.code : "LIBRARY_UNAVAILABLE";
    } finally {
      this.busy = false;
    }
  }
  private async browseArticles(libraryId: string, cursor = 0): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.readerOpen = true;
    try {
      const result = await this.client.libraryArticles(libraryId, cursor);
      this.readerItems = cursor ? [...this.readerItems, ...result.articles] : result.articles;
      this.readerNext = result.nextCursor;
      this.readerArticle = null;
      this.readerHighlight = null;
      this.readerLibrary = libraryId;
    } catch (error) {
      this.statusText = error instanceof SantoWidgetApiError ? error.code : "LIBRARY_UNAVAILABLE";
    } finally {
      this.busy = false;
    }
  }
  private async openArticle(libraryId: string, articleId: string): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    try {
      this.readerArticle = await this.client.libraryArticle(libraryId, articleId);
      this.readerOpen = true;
      this.readerPopover = null;
      this.readerLightbox = null;
      this.readerHighlight = null;
      this.readerLibrary = libraryId;
    } catch (error) {
      this.statusText = error instanceof SantoWidgetApiError ? error.code : "LIBRARY_UNAVAILABLE";
    } finally {
      this.busy = false;
    }
  }
  private async jumpToReferencedSection(sectionId: string): Promise<void> {
    await this.updateComplete;
    const row = Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>("[data-santo-section]"),
    ).find((element) => element.dataset.santoSection === sectionId);
    row?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  private async showSource(messageId: string, sourceId: string): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.cleanupImage();
    try {
      const detail = await this.client.sourceDetails(messageId, sourceId);
      this.source = detail;
      try {
        const resolved = await this.client.sourceArticle(messageId, sourceId);
        this.readerArticle = resolved.article;
        this.readerPopover = null;
        this.readerLightbox = null;
        this.readerHighlight = resolved.highlightSectionId;
        this.readerLibrary = resolved.article.libraryId;
        this.readerOpen = true;
        if (resolved.highlightSectionId)
          void this.jumpToReferencedSection(resolved.highlightSectionId);
      } catch (cause) {
        this.statusText =
          cause instanceof SantoWidgetApiError && cause.code === "LIBRARY_ARTICLE_NOT_AVAILABLE"
            ? "Original article is not indexed yet; verified citation details are available."
            : cause instanceof SantoWidgetApiError
              ? cause.code
              : "LIBRARY_UNAVAILABLE";
      }
      const first = detail.images[0];
      if (first) {
        const image = await this.client.sourceImage(messageId, sourceId, first.assetId);
        this.imageUrl = URL.createObjectURL(image);
      }
    } catch (error) {
      this.statusText = error instanceof SantoWidgetApiError ? error.code : "SOURCE_UNAVAILABLE";
    } finally {
      this.busy = false;
    }
  }

  private renderAnswer(response: ConversationAnswer) {
    const general = "groundingMode" in response && response.groundingMode === "general";
    const quickReply = "kind" in response && response.kind === "quick_reply";
    return html`
      <div class="answer-text medical-markdown" dir="auto">
        ${renderSantoMarkdown(response.answer)}
      </div>
      ${
        !quickReply
          ? html`<div class="answer-footer">
              <span class="answer-mode ${general ? "mode-general" : "mode-grounded"}">
                ${
                  general
                    ? "○ General medical knowledge · No matching Santo source"
                    : "✓ Grounded in verified Santo medical libraries"
                }
              </span>
            </div>`
          : ""
      }
      ${
        response.citations.length
          ? html`<details class="source-collection">
              <summary>Sources used · ${response.citations.length}</summary>
              <div class="source-cards">
                ${response.citations.map(
                  (citation) => html`
                    <button
                      type="button"
                      class="source-card"
                      @click=${() => this.showSource(response.messageId, citation.sourceId)}
                      aria-label="Open verified source ${citation.title}"
                    >
                      <span class="source-label">Verified medical source</span>
                      <strong title=${citation.title}
                        >${readableMedicalSourceTitle(citation.title)}</strong
                      >
                      <span class="source-meta"
                        >${citation.page ? `Page ${citation.page} · ` : ""}Open article and cited
                        section ↗</span
                      >
                    </button>
                  `,
                )}
              </div>
            </details>`
          : ""
      }
    `;
  }

  private renderTranscript() {
    const latestSaved = this.turns.some(
      (turn) => turn.response?.messageId === this.latestAnswer?.messageId,
    );
    const showLatest = this.latestAnswer && !latestSaved;
    if (this.turns.length === 0 && !showLatest && !this.pending) {
      return html`<div class="empty">
        <span class="empty-icon" aria-hidden="true">✦</span>
        <h2>Ask with confidence</h2>
        <p>
          Evidence-based medical answers, clear comparisons, and transparent general knowledge when
          sources are unavailable.
        </p>
      </div>`;
    }
    return html`
      <div class="transcript" aria-live="polite">
        ${this.turns.map(
          (turn) =>
            html`<article class="turn">
              <div class="question">${turn.question}</div>
              ${
                turn.response
                  ? html`<div class="answer">${this.renderAnswer(turn.response)}</div>`
                  : html`<div class="pending-message">
                      ${turn.status === "retryable" ? "Retry available" : "Processing…"}
                    </div>`
              }
            </article>`,
        )}
        ${
          showLatest
            ? html`<article class="turn">
                <div class="question">${this.latestQuestion}</div>
                <div class="answer">${this.renderAnswer(this.latestAnswer!)}</div>
              </article>`
            : nothing
        }
        ${
          this.pending && !this.turns.some((turn) => turn.question === this.pending)
            ? html`<article class="turn">
                <div class="question">${this.pending}</div>
                <div class="pending-message">Question saved locally for same-key retry.</div>
              </article>`
            : nothing
        }
      </div>
    `;
  }

  override render() {
    const options = this.libraries.filter(
      (item) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) && item.label.trim().length > 0,
    );
    const panel = this.ui.expanded
      ? html`
          <section
            id="santo-panel"
            class="panel ${this.ui.fullscreen ? "fullscreen" : ""}"
            role="dialog"
            aria-label="${this.assistantName} assistant"
            aria-modal="${this.ui.fullscreen ? "true" : "false"}"
          >
            <header class="header">
              <div class="header-text">
                <span class="name">${this.assistantName}</span>
                <span class="caption">Grounded medical knowledge</span>
              </div>
              <div class="header-actions">
                <button
                  class="icon-button"
                  type="button"
                  aria-label="${this.ui.fullscreen ? "Exit full screen" : "Enter full screen"}"
                  @click=${() => this.transition({ type: "fullscreen" })}
                >
                  <span aria-hidden="true">${this.ui.fullscreen ? "⊡" : "⛶"}</span>
                </button>
                <button
                  class="icon-button"
                  data-close
                  type="button"
                  aria-label="Close Santo"
                  @click=${this.closePanel}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </header>
            <div class="controls">
              <label for="santo-library">Library</label>
              <select
                id="santo-library"
                aria-label="Medical knowledge library"
                .value=${this.ui.libraryId ?? ""}
                @change=${this.onLibraryChange}
              >
                <option value="">All libraries</option>
                ${options.map((option) => html`<option value="${option.id}">${option.label}</option>`)}
              </select>
              <button type="button" class="citation" @click=${() => void this.browseLibraries()}>
                Browse library
              </button>
            </div>
            <main class="messages">${this.renderTranscript()}</main>
            ${
              this.source
                ? html` <aside class="source-details" aria-label="Verified source details">
                    <button
                      type="button"
                      class="source-close"
                      aria-label="Close source"
                      @click=${() => this.cleanupImage()}
                    >
                      ×
                    </button>
                    <strong>${this.source.source.title}</strong>
                    <p>
                      ${this.source.source.section ?? "Verified source"}
                      ${this.source.source.page ? ` · page ${this.source.source.page}` : ""}
                    </p>
                    ${
                      this.imageUrl
                        ? html`<a
                            href="${this.imageUrl}"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open source image in new window"
                          >
                            <img
                              src="${this.imageUrl}"
                              alt="${this.source.images[0]?.altText ?? "Source image"}"
                            />
                          </a>`
                        : nothing
                    }
                  </aside>`
                : nothing
            }
            ${
              this.readerOpen
                ? html` <aside class="reader-panel" aria-label="Santo Source Explorer">
                    <div class="reader-head">
                      <strong>Source Explorer</strong>
                      <button
                        type="button"
                        aria-label="Close article reader"
                        class="source-close"
                        @click=${() => {
                          this.readerOpen = false;
                          this.readerPopover = null;
                          this.readerLightbox = null;
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div class="reader-nav">
                      <button type="button" @click=${() => void this.browseLibraries()}>
                        All libraries
                      </button>
                      ${
                        this.readerArticle && this.readerLibrary
                          ? html`<button
                              type="button"
                              @click=${() => void this.browseArticles(this.readerLibrary!)}
                            >
                              Articles
                            </button>`
                          : nothing
                      }
                    </div>
                    <div class="reader-body">
                      ${
                        this.readerArticle
                          ? html`
                              <h2>${this.readerArticle.title}</h2>
                              <p class="reader-meta">
                                ${this.readerArticle.category} · ${this.readerArticle.source}
                              </p>
                              <nav aria-label="Article sections">
                                ${this.readerArticle.sections.map(
                                  (section) => html`
                                    <button
                                      type="button"
                                      @click=${() => void this.jumpToReferencedSection(section.id)}
                                    >
                                      ${section.heading}
                                    </button>
                                  `,
                                )}
                              </nav>
                              ${this.readerArticle.sections.map(
                                (section) =>
                                  html` <section
                                    data-santo-section=${section.id}
                                    class=${section.id === this.readerHighlight ? "reader-highlight" : ""}
                                  >
                                    <h3>${section.heading}</h3>
                                    <p>${section.text}</p>
                                    ${section.images.map((img) => html`<img src=${img.src} alt=${img.alt || section.heading} loading="lazy" referrerpolicy="no-referrer" />`)}
                                  </section>`,
                              )}
                            `
                          : this.readerLibrary
                            ? html`
                                <h2>${this.readerLibrary} articles</h2>
                                ${this.readerItems.map(
                                  (item) =>
                                    html`<button
                                      class="reader-item"
                                      type="button"
                                      @click=${() => void this.openArticle(this.readerLibrary!, item.id)}
                                    >
                                      <strong>${item.title}</strong><small>${item.category}</small>
                                    </button>`,
                                )}
                                ${this.readerNext !== null ? html`<button type="button" @click=${() => void this.browseArticles(this.readerLibrary!, this.readerNext!)}>Load more</button>` : nothing}
                              `
                            : html`
                                ${this.readerLibraries.map(
                                  (library) =>
                                    html`<button
                                      type="button"
                                      class="reader-item"
                                      @click=${() => void this.browseArticles(library.id)}
                                    >
                                      <strong>${library.title}</strong
                                      ><small>${library.count} articles</small>
                                    </button>`,
                                )}
                              `
                      }
                    </div>
                  </aside>`
                : nothing
            }
            <div class="status" role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              ${this.statusText}
              ${this.remaining === null ? nothing : html` · ${this.remaining} remaining`}
            </div>
            <form class="composer" @submit=${this.onSubmit}>
              <textarea
                aria-label="Your medical question"
                placeholder="Ask a medical question…"
                maxlength="4000"
                .value=${this.pending || this.draft}
                ?disabled=${!this.client || this.busy || Boolean(this.pending)}
                @input=${(event: Event) => {
                  if (event.target instanceof HTMLTextAreaElement) this.draft = event.target.value;
                }}
                @keydown=${this.onComposeKey}
              ></textarea>
              <button
                type="submit"
                class="send"
                ?disabled=${!this.client || this.busy || (!this.pending && !this.draft.trim())}
              >
                ${this.busy ? "Working…" : this.pending ? "Retry same question" : "Send"}
              </button>
              <div class="footer">Powered by Santo · Verified medical evidence</div>
            </form>
          </section>
        `
      : nothing;
    return html`${panel}
    ${
      this.ui.fullscreen
        ? nothing
        : html`<button
            data-launcher
            class="launcher"
            type="button"
            aria-controls="santo-panel"
            aria-expanded="${this.ui.expanded}"
            aria-label="${this.ui.expanded ? "Close Santo" : "Open Santo assistant"}"
            @click=${this.toggle}
          >
            <span class="launcher-mark" aria-hidden="true">S</span>
            ${this.ui.expanded ? "Close" : "Ask Santo"}
          </button>`
    }`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get(SANTO_WIDGET_TAG)) {
  customElements.define(SANTO_WIDGET_TAG, SantoAiElement);
}

export { SANTO_WIDGET_TAG } from "./tag-name";
export { reduceWidgetUi, INITIAL_WIDGET_UI_STATE } from "./ui-state";
export { SantoConversationClient, SantoWidgetApiError } from "./conversation-client";
