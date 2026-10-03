import { css, html, LitElement } from "lit";

import { SANTO_WIDGET_TAG } from "./tag-name";

export class SantoAiElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
  `;

  override render() {
    return html`<span>Santo AI</span>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get(SANTO_WIDGET_TAG)) {
  customElements.define(SANTO_WIDGET_TAG, SantoAiElement);
}

export { SANTO_WIDGET_TAG } from "./tag-name";
