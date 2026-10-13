import { html, LitElement, nothing } from "lit";

import { widgetStyles } from "./styles";
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

/**
 * Phase 10 shell: interactive display only until a verified Santo session
 * provider and strict conversation API adapter are connected.
 * Never accept or render customer server secrets in browser code.
 */
export class SantoAiElement extends LitElement {
  static override styles = widgetStyles;

  static override properties = {
    ui: { state: true },
    libraries: { attribute: false },
    assistantName: { type: String, attribute: "assistant-name" },
  };

  private ui: WidgetUiState = INITIAL_WIDGET_UI_STATE;
  libraries: readonly SantoWidgetLibrary[] = [];
  assistantName = "Santo";

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
                ${options.map(
                  (option) =>
                    html`<option value="${option.id}">${option.label}</option>`,
                )}
              </select>
            </div>
            <main class="messages">
              <div class="empty">
                <span class="empty-icon" aria-hidden="true">✦</span>
                <h2>Ask with confidence</h2>
                <p>Answers will include verified citations from Santo medical libraries.</p>
              </div>
            </main>
            <div class="status" role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              A Santo end-user session is required before sending.
            </div>
            <div class="composer">
              <textarea
                aria-label="Question composer (unavailable until connected)"
                placeholder="Connect a Santo session to ask a question"
                disabled
              ></textarea>
              <div class="footer">Powered by Santo · Cited medical evidence</div>
            </div>
          </section>
        `
      : nothing;
    return html`
      ${panel}
      ${this.ui.fullscreen
        ? nothing
        : html`
            <button
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
            </button>
          `}
    `;
  }
}

if (typeof customElements !== "undefined" && !customElements.get(SANTO_WIDGET_TAG)) {
  customElements.define(SANTO_WIDGET_TAG, SantoAiElement);
}

export { SANTO_WIDGET_TAG } from "./tag-name";
export { reduceWidgetUi, INITIAL_WIDGET_UI_STATE } from "./ui-state";
